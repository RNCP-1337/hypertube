import type { FastifyInstance } from 'fastify';
import { optionalAuth, requireAuth } from '../middleware/auth';
import { notFound, unprocessable } from '../middleware/errors';
import { browseQuerySchema, idSchema } from '../lib/validation';
import { browse, genres, getMovie } from '../services/catalog';
import { sourceInfo } from '../services/sources';
import { streamRoutes } from './stream';

export async function movieRoutes(app: FastifyInstance): Promise<void> {

  app.get('/', { preHandler: optionalAuth }, async (request, reply) => {
    const parsed = browseQuerySchema.safeParse(request.query);
    if (!parsed.success) throw unprocessable('invalid query', parsed.error.issues);

    const options = parsed.data;

    // one it asks for the most popular items.
    const sort =
      request.query && 'sort' in (request.query as object)
        ? options.sort
        : options.search
          ? 'title'
          : 'popularity';
    const order =
      request.query && 'order' in (request.query as object)
        ? options.order
        : sort === 'title'
          ? 'asc'
          : 'desc';

    const result = await browse({
      ...options,
      sort,
      order,
      userId: request.user?.id,
    });

    reply.send({
      movies: result.movies,
      page: options.page,
      perPage: options.perPage,
      hasMore: result.hasMore,
      sources: sourceInfo(),
    });
  });

  app.get('/genres', { preHandler: optionalAuth }, async (_request, reply) => {
    reply.send({ genres: await genres() });
  });

  app.get('/:id', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = idSchema.safeParse((request.params as { id: string }).id);
    if (!parsed.success) throw notFound('no such movie');

    const movie = await getMovie(parsed.data, request.user?.id);
    if (!movie) throw notFound('no such movie');

    reply.send({ movie });
  });

  await app.register(streamRoutes);
}
