import type { FastifyInstance } from 'fastify';
import { config } from '../config';
import { tokenRequestSchema } from '../lib/validation';
import { signJwt, verifyJwt, JwtError } from '../lib/jwt';
import { requireAuth } from '../middleware/auth';
import {
  authenticate,
  consumeAuthorizationCode,
  createAuthorizationCode,
  issueApiToken,
  verifyApiClient,
} from '../services/auth';

const ALLOWED_SCOPES = new Set(['read', 'write']);

function normaliseScope(requested?: string): string {
  if (!requested) return 'read';
  const scopes = requested
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => ALLOWED_SCOPES.has(s));
  return scopes.length > 0 ? [...new Set(scopes)].join(' ') : 'read';
}

export async function oauthRoutes(app: FastifyInstance): Promise<void> {

  app.post(
    '/token',
    { config: { rateLimit: { max: 30, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      // RFC 6749 mandates application/x-www-form-urlencoded; JSON is accepted
      // too because that is what most clients actually send today.
      const parsed = tokenRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({
          error: 'invalid_request',
          error_description: 'unsupported or malformed grant',
        });
        return;
      }
      const grant = parsed.data;

      const clientOk = await verifyApiClient(grant.client_id, grant.client_secret);
      if (!clientOk) {
        reply
          .code(401)
          .header('WWW-Authenticate', 'Basic realm="hypertube"')
          .send({ error: 'invalid_client', error_description: 'unknown client credentials' });
        return;
      }

      if (grant.grant_type === 'client_credentials') {
        const scope = normaliseScope(grant.scope);
        const token = issueApiToken({
          subject: grant.client_id,
          clientId: grant.client_id,
          scope,
        });
        reply.send({
          access_token: token.accessToken,
          token_type: 'Bearer',
          expires_in: token.expiresIn,
          scope,
        });
        return;
      }

      if (grant.grant_type === 'password') {
        const user = await authenticate(grant.username, grant.password);
        if (!user) {
          reply.code(400).send({
            error: 'invalid_grant',
            error_description: 'invalid user credentials',
          });
          return;
        }
        const scope = normaliseScope(grant.scope);
        const token = issueApiToken({
          subject: String(user.id),
          clientId: grant.client_id,
          scope,
        });
        reply.send({
          access_token: token.accessToken,
          token_type: 'Bearer',
          expires_in: token.expiresIn,
          scope,
          refresh_token: signJwt(
            { sub: String(user.id), typ: 'refresh', client_id: grant.client_id, scope },
            config.JWT_REFRESH_SECRET,
            config.REFRESH_TOKEN_TTL_DAYS * 86_400,
          ),
        });
        return;
      }

      if (grant.grant_type === 'authorization_code') {
        const consumed = await consumeAuthorizationCode(
          grant.code,
          grant.client_id,
          grant.redirect_uri,
        );
        if (!consumed) {
          reply.code(400).send({
            error: 'invalid_grant',
            error_description: 'the authorization code is invalid, used or expired',
          });
          return;
        }
        const token = issueApiToken({
          subject: String(consumed.userId),
          clientId: grant.client_id,
          scope: consumed.scope,
        });
        reply.send({
          access_token: token.accessToken,
          token_type: 'Bearer',
          expires_in: token.expiresIn,
          scope: consumed.scope,
          refresh_token: signJwt(
            {
              sub: String(consumed.userId),
              typ: 'refresh',
              client_id: grant.client_id,
              scope: consumed.scope,
            },
            config.JWT_REFRESH_SECRET,
            config.REFRESH_TOKEN_TTL_DAYS * 86_400,
          ),
        });
        return;
      }

      try {
        const payload = verifyJwt(grant.refresh_token, config.JWT_REFRESH_SECRET);
        if (payload.typ !== 'refresh' || payload.client_id !== grant.client_id) {
          throw new JwtError('token does not belong to this client');
        }
        const scope = normaliseScope(payload.scope);
        const token = issueApiToken({
          subject: payload.sub,
          clientId: grant.client_id,
          scope,
        });
        reply.send({
          access_token: token.accessToken,
          token_type: 'Bearer',
          expires_in: token.expiresIn,
          scope,
        });
      } catch {
        reply.code(400).send({
          error: 'invalid_grant',
          error_description: 'the refresh token is invalid or expired',
        });
      }
    },
  );

  app.get('/authorize', { preHandler: requireAuth }, async (request, reply) => {
    const params = request.query as Record<string, string | undefined>;

    if (params.response_type !== 'code') {
      reply.code(400).send({
        error: 'unsupported_response_type',
        error_description: 'only response_type=code is supported',
      });
      return;
    }
    if (!params.client_id || !params.redirect_uri) {
      reply.code(400).send({
        error: 'invalid_request',
        error_description: 'client_id and redirect_uri are required',
      });
      return;
    }

    let redirect: URL;
    try {
      redirect = new URL(params.redirect_uri);
    } catch {
      reply.code(400).send({
        error: 'invalid_request',
        error_description: 'redirect_uri is not a valid URL',
      });
      return;
    }
    if (redirect.protocol !== 'http:' && redirect.protocol !== 'https:') {
      reply.code(400).send({
        error: 'invalid_request',
        error_description: 'redirect_uri must be http(s)',
      });
      return;
    }

    const code = await createAuthorizationCode({
      clientId: params.client_id,
      userId: request.user!.id,
      redirectUri: params.redirect_uri,
      scope: normaliseScope(params.scope),
    });

    redirect.searchParams.set('code', code);
    if (params.state) redirect.searchParams.set('state', params.state);
    reply.redirect(302, redirect.toString());
  });
}
