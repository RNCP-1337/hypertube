import type { FastifyInstance } from 'fastify';
import { query, queryOne } from '../db/pool';
import { requireAuth, requireWriteScope } from '../middleware/auth';
import { forbidden, notFound, unprocessable } from '../middleware/errors';
import { commentSchema, createCommentSchema, idSchema } from '../lib/validation';
import { avatarUrl } from '../services/avatars';

interface CommentRow {
  id: string;
  movie_id: string;
  user_id: string;
  content: string;
  created_at: Date;
  updated_at: Date;
  username: string;
  avatar_path: string | null;
  movie_title: string | null;
}

export interface CommentPayload {
  id: number;
  movieId: number;
  movieTitle: string | null;
  content: string;
  createdAt: string;
  updatedAt: string;
  author: {
    id: number;
    username: string;
    profilePictureUrl: string | null;
  };
}

function toPayload(row: CommentRow): CommentPayload {
  return {
    id: Number(row.id),
    movieId: Number(row.movie_id),
    movieTitle: row.movie_title,
    content: row.content,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    author: {
      id: Number(row.user_id),
      username: row.username,
      profilePictureUrl: avatarUrl(row.avatar_path),
    },
  };
}

const SELECT_COMMENT = `
  SELECT c.id, c.movie_id, c.user_id, c.content, c.created_at, c.updated_at,
         u.username, u.avatar_path, m.title AS movie_title
    FROM comments c
    JOIN users  u ON u.id = c.user_id
    LEFT JOIN movies m ON m.id = c.movie_id`;

async function fetchComment(id: number): Promise<CommentRow | null> {
  return queryOne<CommentRow>(`${SELECT_COMMENT} WHERE c.id = $1`, [id]);
}

async function insertComment(
  userId: number,
  movieId: number,
  content: string,
): Promise<CommentPayload> {
  const movie = await queryOne('SELECT 1 FROM movies WHERE id = $1', [movieId]);
  if (!movie) throw notFound('no such movie');

  const inserted = await queryOne<{ id: string }>(
    'INSERT INTO comments (movie_id, user_id, content) VALUES ($1, $2, $3) RETURNING id',
    [movieId, userId, content],
  );
  if (!inserted) throw new Error('comment insertion failed');

  const row = await fetchComment(Number(inserted.id));
  if (!row) throw new Error('comment insertion failed');
  return toPayload(row);
}

export async function commentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', { preHandler: requireAuth }, async (request, reply) => {
    const { page = '1', perPage = '20' } = request.query as Record<string, string>;
    const limit = Math.min(Math.max(Number(perPage) || 20, 1), 50);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

    const rows = await query<CommentRow>(
      `${SELECT_COMMENT} ORDER BY c.created_at DESC LIMIT $1 OFFSET $2`,
      [limit + 1, offset],
    );

    reply.send({
      comments: rows.slice(0, limit).map(toPayload),
      hasMore: rows.length > limit,
    });
  });

  app.get('/:id', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = idSchema.safeParse((request.params as { id: string }).id);
    if (!parsed.success) throw notFound('no such comment');

    const row = await fetchComment(parsed.data);
    if (!row) throw notFound('no such comment');
    reply.send({ comment: toPayload(row) });
  });

  app.post('/', { preHandler: requireWriteScope }, async (request, reply) => {
    const parsed = createCommentSchema.safeParse(request.body);
    if (!parsed.success) throw unprocessable('validation failed', parsed.error.issues);
    if (!parsed.data.movieId) {
      throw unprocessable('movieId is required', [
        { field: 'movieId', message: 'movieId is required' },
      ]);
    }

    const comment = await insertComment(
      request.user!.id,
      parsed.data.movieId,
      parsed.data.content,
    );
    reply.code(201).send({ comment });
  });

  app.patch('/:id', { preHandler: requireWriteScope }, async (request, reply) => {
    const parsedId = idSchema.safeParse((request.params as { id: string }).id);
    if (!parsedId.success) throw notFound('no such comment');

    const parsed = commentSchema.safeParse(request.body);
    if (!parsed.success) throw unprocessable('validation failed', parsed.error.issues);

    const existing = await fetchComment(parsedId.data);
    if (!existing) throw notFound('no such comment');
    if (Number(existing.user_id) !== request.user!.id) {
      throw forbidden('you may only edit your own comments');
    }

    await query('UPDATE comments SET content = $2 WHERE id = $1', [
      parsedId.data,
      parsed.data.content,
    ]);

    const updated = await fetchComment(parsedId.data);
    reply.send({ comment: toPayload(updated as CommentRow) });
  });

  app.delete('/:id', { preHandler: requireWriteScope }, async (request, reply) => {
    const parsedId = idSchema.safeParse((request.params as { id: string }).id);
    if (!parsedId.success) throw notFound('no such comment');

    const existing = await fetchComment(parsedId.data);
    if (!existing) throw notFound('no such comment');
    if (Number(existing.user_id) !== request.user!.id) {
      throw forbidden('you may only delete your own comments');
    }

    await query('DELETE FROM comments WHERE id = $1', [parsedId.data]);
    reply.code(204).send();
  });
}

export async function movieCommentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/:movieId/comments', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = idSchema.safeParse((request.params as { movieId: string }).movieId);
    if (!parsed.success) throw notFound('no such movie');

    const { page = '1', perPage = '20' } = request.query as Record<string, string>;
    const limit = Math.min(Math.max(Number(perPage) || 20, 1), 50);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

    const rows = await query<CommentRow>(
      `${SELECT_COMMENT} WHERE c.movie_id = $1 ORDER BY c.created_at DESC LIMIT $2 OFFSET $3`,
      [parsed.data, limit + 1, offset],
    );

    reply.send({
      comments: rows.slice(0, limit).map(toPayload),
      hasMore: rows.length > limit,
    });
  });

  app.post('/:movieId/comments', { preHandler: requireWriteScope }, async (request, reply) => {
    const parsedId = idSchema.safeParse((request.params as { movieId: string }).movieId);
    if (!parsedId.success) throw notFound('no such movie');

    const parsed = commentSchema.safeParse(request.body);
    if (!parsed.success) throw unprocessable('validation failed', parsed.error.issues);

    const comment = await insertComment(request.user!.id, parsedId.data, parsed.data.content);
    reply.code(201).send({ comment });
  });
}
