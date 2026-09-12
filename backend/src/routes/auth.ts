import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config, isProduction } from '../config';
import { badRequest, conflict, unauthorized, unprocessable } from '../middleware/errors';
import { requireAuth } from '../middleware/auth';
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
} from '../lib/validation';
import { sendPasswordResetEmail } from '../lib/mailer';
import {
  ConflictError,
  authenticate,
  consumePasswordReset,
  createPasswordReset,
  createUser,
  findUserByEmail,
  findUserByProvider,
  issueAccessToken,
  issueRefreshToken,
  linkProvider,
  listProviders,
  refreshCookieOptions,
  REFRESH_COOKIE,
  revokeRefreshToken,
  rotateRefreshToken,
  uniqueUsername,
  findUserById,
  type UserRecord,
} from '../services/auth';
import {
  availableProviders,
  buildAuthorizeUrl,
  exchangeCode,
  getProvider,
} from '../services/oauth-providers';
import { storeAvatarFromUrl } from '../services/avatars';
import { publicUser } from './users';

const OAUTH_STATE_COOKIE = 'hypertube_oauth_state';

function signState(nonce: string, providerId: string): string {
  return createHmac('sha256', config.JWT_ACCESS_SECRET)
    .update(`${nonce}:${providerId}`)
    .digest('base64url');
}

function verifyState(state: string, cookie: string | undefined, providerId: string): boolean {
  if (!cookie) return false;
  const expected = Buffer.from(signState(cookie, providerId));
  const provided = Buffer.from(state);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

async function establishSession(
  reply: FastifyReply,
  request: FastifyRequest,
  user: UserRecord,
): Promise<{ accessToken: string; expiresIn: number }> {
  const refreshToken = await issueRefreshToken(user.id, request.headers['user-agent']);
  reply.setCookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions);
  return { accessToken: issueAccessToken(user.id), expiresIn: config.ACCESS_TOKEN_TTL };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {

  app.post(
    '/register',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const parsed = registerSchema.safeParse(request.body);
      if (!parsed.success) throw unprocessable('validation failed', parsed.error.issues);

      let user: UserRecord;
      try {
        user = await createUser({ ...parsed.data, emailVerified: false });
      } catch (err) {
        if (err instanceof ConflictError) {
          throw conflict(err.message, [{ field: err.field, message: err.message }]);
        }
        throw err;
      }

      const session = await establishSession(reply, request, user);
      reply.code(201).send({ user: publicUser(user, user.id), ...session });
    },
  );

  app.post(
    '/login',
    { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) throw unprocessable('validation failed', parsed.error.issues);

      const user = await authenticate(parsed.data.username, parsed.data.password);
      // One generic message: never reveal whether the account exists.
      if (!user) throw unauthorized('invalid credentials');

      const session = await establishSession(reply, request, user);
      reply.send({ user: publicUser(user, user.id), ...session });
    },
  );

  app.post('/refresh', async (request, reply) => {
    const token = request.cookies[REFRESH_COOKIE];
    if (!token) throw unauthorized('no session');

    const rotated = await rotateRefreshToken(token, request.headers['user-agent']);
    if (!rotated) {
      reply.clearCookie(REFRESH_COOKIE, refreshCookieOptions);
      throw unauthorized('session expired');
    }

    const user = await findUserById(rotated.userId);
    if (!user) throw unauthorized('session expired');

    reply.setCookie(REFRESH_COOKIE, rotated.refreshToken, refreshCookieOptions);
    reply.send({
      user: publicUser(user, user.id),
      accessToken: issueAccessToken(user.id),
      expiresIn: config.ACCESS_TOKEN_TTL,
    });
  });

  app.post('/logout', async (request, reply) => {
    const token = request.cookies[REFRESH_COOKIE];
    if (token) await revokeRefreshToken(token);
    reply.clearCookie(REFRESH_COOKIE, refreshCookieOptions);
    reply.code(204).send();
  });

  app.get('/me', { preHandler: requireAuth }, async (request, reply) => {
    const user = request.user as UserRecord;
    reply.send({
      user: publicUser(user, user.id),
      providers: await listProviders(user.id),
    });
  });

  app.post(
    '/forgot-password',
    { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const parsed = forgotPasswordSchema.safeParse(request.body);
      if (!parsed.success) throw unprocessable('validation failed', parsed.error.issues);

      const reset = await createPasswordReset(parsed.data.email);
      if (reset) {
        try {
          await sendPasswordResetEmail({
            to: reset.user.email,
            username: reset.user.username,
            token: reset.token,
            language: reset.user.language,
          });
        } catch (err) {
          request.log.error({ err }, 'failed to send the reset e-mail');
        }
      }

      // Always the same answer: the endpoint must not be a user enumerator.
      reply.send({
        message: 'if an account matches this address, a reset link has been sent',
      });
    },
  );

  app.post(
    '/reset-password',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const parsed = resetPasswordSchema.safeParse(request.body);
      if (!parsed.success) throw unprocessable('validation failed', parsed.error.issues);

      const ok = await consumePasswordReset(parsed.data.token, parsed.data.password);
      if (!ok) throw badRequest('this reset link is invalid or has expired');

      reply.send({ message: 'password updated, you can now sign in' });
    },
  );

  app.get('/providers', async (_request, reply) => {
    reply.send({ providers: availableProviders() });
  });

  app.get('/oauth/:provider', async (request, reply) => {
    const { provider: providerId } = request.params as { provider: string };
    const provider = getProvider(providerId);
    if (!provider) throw badRequest(`unknown or unconfigured provider "${providerId}"`);

    const nonce = randomBytes(24).toString('base64url');
    reply.setCookie(OAUTH_STATE_COOKIE, nonce, {
      httpOnly: true,
      sameSite: 'lax', // the provider redirects back cross-site
      secure: isProduction,
      path: '/api/auth',
      maxAge: 600,
    });

    reply.redirect(buildAuthorizeUrl(provider, signState(nonce, providerId)), 302);
  });

  app.get('/oauth/:provider/callback', async (request, reply) => {
    const { provider: providerId } = request.params as { provider: string };
    const queryParams = request.query as { code?: string; state?: string; error?: string };

    const fail = (reason: string) => {
      reply.clearCookie(OAUTH_STATE_COOKIE, { path: '/api/auth' });
      reply.redirect(`${config.PUBLIC_URL}/login?error=${encodeURIComponent(reason)}`, 302);
    };

    const provider = getProvider(providerId);
    if (!provider) return fail('unknown_provider');
    if (queryParams.error) return fail('provider_denied');
    if (!queryParams.code || !queryParams.state) return fail('missing_code');
    if (!verifyState(queryParams.state, request.cookies[OAUTH_STATE_COOKIE], providerId)) {
      return fail('invalid_state');
    }
    reply.clearCookie(OAUTH_STATE_COOKIE, { path: '/api/auth' });

    let profile;
    try {
      const accessToken = await exchangeCode(provider, queryParams.code);
      profile = await provider.fetchProfile(accessToken);
    } catch (err) {
      request.log.error({ err }, `${providerId} OmniAuth flow failed`);
      return fail('provider_error');
    }

    // 1. Already linked -> straight in.
    let user = await findUserByProvider(providerId, profile.providerUserId);

    // 2. Same e-mail as an existing account -> link the identity to it.
    if (!user && profile.email) {
      const existing = await findUserByEmail(profile.email);
      if (existing) {
        await linkProvider(existing.id, providerId, profile.providerUserId);
        user = existing;
      }
    }

    // 3. Brand new account.
    if (!user) {
      const username = await uniqueUsername(profile.username);
      const email =
        profile.email ?? `${username}.${providerId}@users.noreply.hypertube.local`;
      try {
        user = await createUser({
          username,
          email,
          firstName: profile.firstName,
          lastName: profile.lastName,
          emailVerified: profile.email !== null,
        });
      } catch (err) {
        request.log.error({ err }, 'could not create the OmniAuth account');
        return fail('account_creation_failed');
      }
      await linkProvider(user.id, providerId, profile.providerUserId);

      if (profile.avatarUrl) {
        // Re-encoded locally: we never hotlink a third-party image.
        await storeAvatarFromUrl(user.id, profile.avatarUrl).catch(() => undefined);
      }
    }

    await establishSession(reply, request, user);
    // The SPA picks the session up with a silent refresh on this route.
    reply.redirect(`${config.PUBLIC_URL}/oauth/complete`, 302);
  });
}
