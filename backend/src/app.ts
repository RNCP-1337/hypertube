import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { config, enabledOAuthProviders, isProduction, SUPPORTED_LANGUAGES } from './config';
import { registerErrorHandlers } from './middleware/errors';
import { authRoutes } from './routes/auth';
import { commentRoutes, movieCommentRoutes } from './routes/comments';
import { docsRoutes } from './routes/docs';
import { movieRoutes } from './routes/movies';
import { oauthRoutes } from './routes/oauth';
import { userRoutes } from './routes/users';
import { MAX_AVATAR_BYTES } from './services/avatars';
import { metadataProvidersConfigured } from './services/metadata';
import { sourceInfo } from './services/sources';
import { pool } from './db/pool';

// pino-pretty is a dev dependency, so it is absent from the production image.
function prettyTransport() {
  if (isProduction) return undefined;
  try {
    require.resolve('pino-pretty');
    return { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } };
  } catch {
    return undefined;
  }
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: isProduction ? 'info' : 'debug',
      transport: prettyTransport(),
    },
    // nginx sits in front and sets X-Forwarded-*, trust it for real client ips
    trustProxy: true,
    bodyLimit: 1024 * 1024, // 1 MB for JSON; uploads go through multipart
    disableRequestLogging: false,
  });

  await app.register(cookie, {
    secret: config.JWT_ACCESS_SECRET,
    parseOptions: { httpOnly: true, sameSite: 'strict', secure: isProduction },
  });

  await app.register(cors, {
    // SPA is same-origin behind nginx, so only allow credentials for PUBLIC_URL
    origin: (origin, callback) => {
      if (!origin || origin === config.PUBLIC_URL) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    // Streaming issues a lot of range requests; they must not be throttled.
    allowList: (request) => request.url.includes('/stream'),
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: (_request, context) => ({
      error: 'too_many_requests',
      message: `rate limit exceeded, retry in ${context.after}`,
    }),
  });

  await app.register(multipart, {
    limits: { fileSize: MAX_AVATAR_BYTES, files: 1, fields: 10 },
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Resource-Policy', 'same-site');
    reply.removeHeader('X-Powered-By');
    if (isProduction) {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    return payload;
  });

  registerErrorHandlers(app);

  app.get('/api/health', async (_request, reply) => {
    let database = false;
    try {
      await pool.query('SELECT 1');
      database = true;
    } catch {
      database = false;
    }

    reply.code(database ? 200 : 503).send({
      status: database ? 'ok' : 'degraded',
      database,
      version: '1.0.0',
      sources: sourceInfo().map((s) => s.id),
      metadataProviders: metadataProvidersConfigured(),
      oauthProviders: enabledOAuthProviders(),
      languages: SUPPORTED_LANGUAGES,
    });
  });

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(oauthRoutes, { prefix: '/api/oauth' });
  await app.register(userRoutes, { prefix: '/api/users' });
  await app.register(movieRoutes, { prefix: '/api/movies' });
  await app.register(movieCommentRoutes, { prefix: '/api/movies' });
  await app.register(commentRoutes, { prefix: '/api/comments' });
  await app.register(docsRoutes, { prefix: '/api/docs' });

  return app;
}
