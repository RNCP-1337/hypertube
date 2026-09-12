import type { FastifyReply, FastifyRequest } from 'fastify';
import { JwtError } from '../lib/jwt';
import { findUserById, verifyAnyAccessToken, type UserRecord } from '../services/auth';

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserRecord;
    tokenScope?: string;
    tokenType?: 'access' | 'api';
  }
}

function extractBearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }
  // <video> and <track> cannot set headers, so those routes opt into ?token=
  const fromQuery = (request.query as { token?: unknown } | undefined)?.token;
  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;
  return null;
}

type Resolution =
  | { kind: 'anonymous' }
  | { kind: 'invalid' }
  | { kind: 'client' }
  | { kind: 'user'; user: UserRecord };

async function resolve(request: FastifyRequest): Promise<Resolution> {
  const token = extractBearer(request);
  if (!token) return { kind: 'anonymous' };

  let payload;
  try {
    payload = verifyAnyAccessToken(token);
  } catch (err) {
    if (err instanceof JwtError) return { kind: 'invalid' };
    throw err;
  }

  if (payload.typ !== 'access' && payload.typ !== 'api') return { kind: 'invalid' };

  request.tokenType = payload.typ;
  request.tokenScope = payload.scope ?? 'read';

  // client_credentials tokens have no user behind them, `sub` is the client id
  if (payload.typ === 'api' && !/^\d+$/.test(payload.sub)) return { kind: 'client' };

  const user = await findUserById(Number(payload.sub));
  if (!user) return { kind: 'invalid' };

  request.user = user;
  return { kind: 'user', user };
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const result = await resolve(request);
  if (result.kind === 'user') return;

  if (result.kind === 'client') {
    reply.code(403).send({
      error: 'no_user_context',
      message: 'this endpoint needs a token bound to a user, not a client-only token',
    });
    return;
  }

  reply
    .code(401)
    .header('WWW-Authenticate', 'Bearer realm="hypertube"')
    .send({ error: 'unauthorized', message: 'a valid access token is required' });
}

export async function optionalAuth(request: FastifyRequest): Promise<void> {
  await resolve(request);
}

export async function requireWriteScope(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await requireAuth(request, reply);
  if (reply.sent) return;

  const scopes = (request.tokenScope ?? 'read').split(/[\s,]+/);
  if (request.tokenType === 'api' && !scopes.includes('write')) {
    reply.code(403).send({ error: 'insufficient_scope', message: 'the write scope is required' });
  }
}
