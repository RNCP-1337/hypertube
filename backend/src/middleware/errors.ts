import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { isProduction } from '../config';
import { formatZodError } from '../lib/validation';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'authentication required') =>
  new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'you may not do that') =>
  new HttpError(403, 'forbidden', message);
export const notFound = (message = 'not found') => new HttpError(404, 'not_found', message);
export const conflict = (message: string, details?: unknown) =>
  new HttpError(409, 'conflict', message, details);
export const unprocessable = (message: string, details?: unknown) =>
  new HttpError(422, 'unprocessable_entity', message, details);

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    reply.code(404).send({
      error: 'not_found',
      message: `${request.method} ${request.url} is not a route of this API`,
    });
  });

  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    // Validation failures -> 422 with the offending fields.
    if (error instanceof ZodError) {
      reply.code(422).send({
        error: 'unprocessable_entity',
        message: 'validation failed',
        details: formatZodError(error),
      });
      return;
    }

    if (error instanceof HttpError) {
      reply.code(error.statusCode).send({
        error: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      });
      return;
    }

    // Fastify's own errors already carry a sensible status (415, 413, 429...).
    const status = error.statusCode ?? 500;

    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled error');
      reply.code(500).send({
        error: 'internal_error',
        message: 'something went wrong on our side',
        // Never expose internals in production.
        ...(isProduction ? {} : { debug: error.message }),
      });
      return;
    }

    reply.code(status).send({
      error: error.code ?? 'request_error',
      message: error.message,
    });
  });
}
