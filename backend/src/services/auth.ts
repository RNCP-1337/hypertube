import { createHash, randomUUID } from 'node:crypto';
import { config, isProduction } from '../config';
import { query, queryOne } from '../db/pool';
import { signJwt, verifyJwt, type JwtPayload } from '../lib/jwt';
import { hashPassword, randomToken, verifyPassword } from '../lib/password';

export interface UserRecord {
  id: number;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarPath: string | null;
  language: string;
  hasPassword: boolean;
  createdAt: string;
}

interface UserRow {
  id: string;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  avatar_path: string | null;
  language: string;
  password_hash: string | null;
  created_at: Date;
}

export function toUserRecord(row: UserRow): UserRecord {
  return {
    id: Number(row.id),
    username: row.username,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    avatarPath: row.avatar_path,
    language: row.language,
    hasPassword: row.password_hash !== null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

const USER_COLUMNS =
  'id, username, email, first_name, last_name, avatar_path, language, password_hash, created_at';

export async function findUserById(id: number): Promise<UserRecord | null> {
  const row = await queryOne<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  return row ? toUserRecord(row) : null;
}

export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  const row = await queryOne<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE email = $1`, [
    email.trim().toLowerCase(),
  ]);
  return row ? toUserRecord(row) : null;
}

export async function findUserByIdentifier(identifier: string): Promise<UserRow | null> {
  return queryOne<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE username = $1 OR email = $1 LIMIT 1`,
    [identifier.trim()],
  );
}

export class ConflictError extends Error {
  constructor(readonly field: string, message: string) {
    super(message);
  }
}

export async function createUser(input: {
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  password?: string;
  language?: string;
  emailVerified?: boolean;
}): Promise<UserRecord> {
  const existing = await queryOne<{ username: string; email: string }>(
    'SELECT username, email FROM users WHERE username = $1 OR email = $2 LIMIT 1',
    [input.username, input.email],
  );
  if (existing) {
    const field =
      existing.username.toLowerCase() === input.username.toLowerCase() ? 'username' : 'email';
    throw new ConflictError(field, `this ${field} is already taken`);
  }

  const passwordHash = input.password ? await hashPassword(input.password) : null;

  const row = await queryOne<UserRow>(
    `INSERT INTO users (username, email, first_name, last_name, password_hash, language, email_verified)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${USER_COLUMNS}`,
    [
      input.username,
      input.email,
      input.firstName,
      input.lastName,
      passwordHash,
      input.language ?? 'en',
      input.emailVerified ?? false,
    ],
  );
  if (!row) throw new Error('user creation failed');
  return toUserRecord(row);
}

export const REFRESH_COOKIE = 'hypertube_refresh';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function issueAccessToken(userId: number): string {
  return signJwt(
    { sub: String(userId), typ: 'access' },
    config.JWT_ACCESS_SECRET,
    config.ACCESS_TOKEN_TTL,
  );
}

export async function issueRefreshToken(userId: number, userAgent?: string): Promise<string> {
  const token = randomToken(48);
  const expiresAt = new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 86_400_000);

  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent)
     VALUES ($1, $2, $3, $4)`,
    [userId, sha256(token), expiresAt, userAgent?.slice(0, 200) ?? null],
  );
  return token;
}

export async function rotateRefreshToken(
  token: string,
  userAgent?: string,
): Promise<{ userId: number; refreshToken: string } | null> {
  const row = await queryOne<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM refresh_tokens
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [sha256(token)],
  );
  if (!row) return null;

  // Single use: the old token is revoked the moment a new one is issued.
  await query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [row.id]);

  const userId = Number(row.user_id);
  return { userId, refreshToken: await issueRefreshToken(userId, userAgent) };
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [sha256(token)],
  );
}

export async function revokeAllSessions(userId: number): Promise<void> {
  await query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
    [userId],
  );
}

export const refreshCookieOptions = {
  httpOnly: true,
  // strict is fine: refresh is only ever called by our own SPA, same origin
  sameSite: 'strict' as const,
  secure: isProduction,
  path: '/api/auth',
  maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86_400,
};

export async function authenticate(
  identifier: string,
  password: string,
): Promise<UserRecord | null> {
  const row = await findUserByIdentifier(identifier);

  // verify even for an unknown user so timing doesn't leak account existence
  const ok = await verifyPassword(password, row?.password_hash ?? null);
  if (!row || !ok) return null;
  return toUserRecord(row);
}

const RESET_TTL_MS = 60 * 60 * 1000;

export async function createPasswordReset(email: string): Promise<{
  token: string;
  user: UserRecord;
} | null> {
  const row = await queryOne<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE email = $1`, [
    email,
  ]);
  if (!row) return null;

  const token = randomToken(32);
  await query(
    'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [row.id, sha256(token), new Date(Date.now() + RESET_TTL_MS)],
  );
  return { token, user: toUserRecord(row) };
}

export async function consumePasswordReset(
  token: string,
  newPassword: string,
): Promise<boolean> {
  const row = await queryOne<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM password_resets
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [sha256(token)],
  );
  if (!row) return false;

  const hash = await hashPassword(newPassword);
  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [row.user_id, hash]);
  await query('UPDATE password_resets SET used_at = now() WHERE id = $1', [row.id]);
  // Changing the password invalidates every existing session.
  await revokeAllSessions(Number(row.user_id));
  return true;
}

export async function findUserByProvider(
  provider: string,
  providerUserId: string,
): Promise<UserRecord | null> {
  const row = await queryOne<UserRow>(
    `SELECT ${USER_COLUMNS.split(', ').map((c) => `u.${c}`).join(', ')}
       FROM users u
       JOIN oauth_identities i ON i.user_id = u.id
      WHERE i.provider = $1 AND i.provider_user_id = $2`,
    [provider, providerUserId],
  );
  return row ? toUserRecord(row) : null;
}

export async function linkProvider(
  userId: number,
  provider: string,
  providerUserId: string,
): Promise<void> {
  await query(
    `INSERT INTO oauth_identities (user_id, provider, provider_user_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (provider, provider_user_id) DO NOTHING`,
    [userId, provider, providerUserId],
  );
}

export async function listProviders(userId: number): Promise<string[]> {
  const rows = await query<{ provider: string }>(
    'SELECT provider FROM oauth_identities WHERE user_id = $1 ORDER BY provider',
    [userId],
  );
  return rows.map((r) => r.provider);
}

export async function uniqueUsername(base: string): Promise<string> {
  const cleaned = base.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 16) || 'user';
  const padded = cleaned.length >= 3 ? cleaned : `${cleaned}user`.slice(0, 16);

  for (let suffix = 0; suffix < 1000; suffix += 1) {
    const candidate = suffix === 0 ? padded : `${padded}${suffix}`.slice(0, 20);
    const taken = await queryOne('SELECT 1 FROM users WHERE username = $1', [candidate]);
    if (!taken) return candidate;
  }
  return `user${randomUUID().slice(0, 8)}`;
}

export interface ApiTokenClaims extends JwtPayload {
  typ: 'api';
}

export async function verifyApiClient(
  clientId: string,
  clientSecret: string,
): Promise<boolean> {
  const row = await queryOne<{ client_secret: string }>(
    'SELECT client_secret FROM oauth_clients WHERE client_id = $1',
    [clientId],
  );
  // Same constant-time verification as a user password.
  return verifyPassword(clientSecret, row?.client_secret ?? null);
}

export function issueApiToken(options: {
  subject: string;
  clientId: string;
  scope: string;
}): { accessToken: string; expiresIn: number } {
  const expiresIn = config.ACCESS_TOKEN_TTL * 4; // API tokens live a bit longer
  return {
    accessToken: signJwt(
      {
        sub: options.subject,
        typ: 'api',
        scope: options.scope,
        client_id: options.clientId,
        jti: randomUUID(),
      },
      config.JWT_ACCESS_SECRET,
      expiresIn,
    ),
    expiresIn,
  };
}

export function verifyAnyAccessToken(token: string): JwtPayload {
  return verifyJwt(token, config.JWT_ACCESS_SECRET);
}

const AUTH_CODE_TTL_MS = 5 * 60 * 1000;

export async function createAuthorizationCode(options: {
  clientId: string;
  userId: number;
  redirectUri: string;
  scope: string;
}): Promise<string> {
  const code = randomToken(32);
  await query(
    `INSERT INTO oauth_authorization_codes (code_hash, client_id, user_id, redirect_uri, scope, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      sha256(code),
      options.clientId,
      options.userId,
      options.redirectUri,
      options.scope,
      new Date(Date.now() + AUTH_CODE_TTL_MS),
    ],
  );
  return code;
}

export async function consumeAuthorizationCode(
  code: string,
  clientId: string,
  redirectUri: string,
): Promise<{ userId: number; scope: string } | null> {
  const row = await queryOne<{ user_id: string; scope: string }>(
    `UPDATE oauth_authorization_codes
        SET used_at = now()
      WHERE code_hash = $1
        AND client_id = $2
        AND redirect_uri = $3
        AND used_at IS NULL
        AND expires_at > now()
      RETURNING user_id, scope`,
    [sha256(code), clientId, redirectUri],
  );
  return row ? { userId: Number(row.user_id), scope: row.scope } : null;
}
