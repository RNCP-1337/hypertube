import { createHmac, timingSafeEqual } from 'node:crypto';

export interface JwtPayload {
  sub: string;
  typ: 'access' | 'refresh' | 'api';
  scope?: string;
  client_id?: string;
  jti?: string;
  iat?: number;
  exp?: number;
  iss?: string;
}

const ISSUER = 'hypertube';

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function signJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp' | 'iss'>,
  secret: string,
  ttlSeconds: number,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(
    JSON.stringify({ ...payload, iss: ISSUER, iat: now, exp: now + ttlSeconds }),
  );
  const data = `${header}.${body}`;
  return `${data}.${sign(data, secret)}`;
}

export class JwtError extends Error {}

export function verifyJwt(token: string, secret: string): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed token');

  const [headerB64, bodyB64, signatureB64] = parts;

  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
  } catch {
    throw new JwtError('malformed header');
  }
  // Pin the algorithm: refuse "none" and any asymmetric-confusion attempt.
  if (header.alg !== 'HS256') throw new JwtError('unsupported algorithm');

  const expected = Buffer.from(sign(`${headerB64}.${bodyB64}`, secret), 'base64url');
  const provided = Buffer.from(signatureB64, 'base64url');
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    throw new JwtError('invalid signature');
  }

  let payload: JwtPayload;
  try {
    payload = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'));
  } catch {
    throw new JwtError('malformed payload');
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== ISSUER) throw new JwtError('invalid issuer');
  if (typeof payload.exp !== 'number' || payload.exp <= now) throw new JwtError('token expired');

  return payload;
}
