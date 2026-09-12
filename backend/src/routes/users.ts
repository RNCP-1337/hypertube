import { promises as fs } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { query, queryOne } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { conflict, forbidden, notFound, unprocessable } from '../middleware/errors';
import { idSchema, updateProfileSchema } from '../lib/validation';
import { hashPassword } from '../lib/password';
import {
  avatarPath,
  avatarUrl,
  InvalidImageError,
  MAX_AVATAR_BYTES,
  storeAvatar,
  storeAvatarFromUrl,
} from '../services/avatars';
import { findUserById, revokeAllSessions, type UserRecord } from '../services/auth';

export interface PublicUser {
  id: number;
  username: string;
  firstName: string;
  lastName: string;
  profilePictureUrl: string | null;
  language: string;
  createdAt: string;
  email?: string;
  hasPassword?: boolean;
}

export function publicUser(user: UserRecord, requesterId?: number): PublicUser {
  const base: PublicUser = {
    id: user.id,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    profilePictureUrl: avatarUrl(user.avatarPath),
    language: user.language,
    createdAt: user.createdAt,
  };
  if (requesterId === user.id) {
    base.email = user.email;
    base.hasPassword = user.hasPassword;
  }
  return base;
}

export async function userRoutes(app: FastifyInstance): Promise<void> {

  app.get('/', { preHandler: requireAuth }, async (request, reply) => {
    const { page = '1', perPage = '50', search } = request.query as Record<string, string>;
    const limit = Math.min(Math.max(Number(perPage) || 50, 1), 100);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

    const params: unknown[] = [];
    let where = '';
    if (search && search.trim() !== '') {
      params.push(`%${search.trim()}%`);
      where = `WHERE username ILIKE $${params.length}`;
    }
    params.push(limit, offset);

    const rows = await query<{ id: string; username: string; avatar_path: string | null }>(
      `SELECT id, username, avatar_path FROM users ${where}
        ORDER BY username ASC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    reply.send({
      users: rows.map((r) => ({
        id: Number(r.id),
        username: r.username,
        profilePictureUrl: avatarUrl(r.avatar_path),
      })),
    });
  });

  // Declared before /:id so "avatar" is never parsed as an id.
  app.get('/avatar/:file', async (request, reply) => {
    const { file } = request.params as { file: string };
    const path = avatarPath(file);
    if (!path) throw notFound('no such picture');

    let picture: Buffer;
    try {
      picture = await fs.readFile(path);
    } catch {
      throw notFound('no such picture');
    }

    return reply
      .header('Content-Type', 'image/jpeg')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'public, max-age=86400')
      .send(picture);
  });

  app.get('/:id', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = idSchema.safeParse((request.params as { id: string }).id);
    if (!parsed.success) throw notFound('no such user');

    const user = await findUserById(parsed.data);
    if (!user) throw notFound('no such user');

    reply.send({ user: publicUser(user, request.user?.id) });
  });

  app.patch('/:id', { preHandler: requireAuth }, async (request, reply) => {
    const parsedId = idSchema.safeParse((request.params as { id: string }).id);
    if (!parsedId.success) throw notFound('no such user');

    if (parsedId.data !== request.user?.id) {
      throw forbidden('you may only modify your own profile');
    }

    const parsed = updateProfileSchema.safeParse(request.body);
    if (!parsed.success) throw unprocessable('validation failed', parsed.error.issues);

    const data = parsed.data;

    if (data.username || data.email) {
      const clash = await queryOne<{ username: string; email: string }>(
        `SELECT username, email FROM users
          WHERE id <> $1 AND (username = $2 OR email = $3) LIMIT 1`,
        [request.user.id, data.username ?? '', data.email ?? ''],
      );
      if (clash) {
        const field =
          data.username && clash.username.toLowerCase() === data.username.toLowerCase()
            ? 'username'
            : 'email';
        throw conflict(`this ${field} is already taken`, [
          { field, message: `this ${field} is already taken` },
        ]);
      }
    }

    // Build the SET clause from a fixed whitelist of columns.
    const updates: string[] = [];
    const params: unknown[] = [request.user.id];
    const push = (column: string, value: unknown) => {
      params.push(value);
      updates.push(`${column} = $${params.length}`);
    };

    if (data.username) push('username', data.username);
    if (data.email) push('email', data.email);
    if (data.firstName) push('first_name', data.firstName);
    if (data.lastName) push('last_name', data.lastName);
    if (data.language) push('language', data.language);
    if (data.password) push('password_hash', await hashPassword(data.password));

    if (updates.length > 0) {
      await query(`UPDATE users SET ${updates.join(', ')} WHERE id = $1`, params);
    }

    if (data.profilePictureUrl) {
      try {
        await storeAvatarFromUrl(request.user.id, data.profilePictureUrl);
      } catch (err) {
        throw unprocessable(
          err instanceof InvalidImageError ? err.message : 'this picture could not be imported',
          [{ field: 'profilePictureUrl', message: 'this picture could not be imported' }],
        );
      }
    }

    // A password change ends every other session.
    if (data.password) await revokeAllSessions(request.user.id);

    const updated = await findUserById(request.user.id);
    if (!updated) throw notFound('no such user');
    reply.send({ user: publicUser(updated, request.user.id) });
  });

  app.post('/:id/avatar', { preHandler: requireAuth }, async (request, reply) => {
    const parsedId = idSchema.safeParse((request.params as { id: string }).id);
    if (!parsedId.success) throw notFound('no such user');
    if (parsedId.data !== request.user?.id) {
      throw forbidden('you may only change your own picture');
    }

    const file = await request.file({ limits: { fileSize: MAX_AVATAR_BYTES, files: 1 } });
    if (!file) throw unprocessable('no file was uploaded');

    if (!/^image\/(jpeg|png|gif|webp|bmp)$/i.test(file.mimetype)) {
      throw unprocessable('only JPEG, PNG, GIF, WebP and BMP images are accepted', [
        { field: 'file', message: 'unsupported image type' },
      ]);
    }

    let buffer: Buffer;
    try {
      buffer = await file.toBuffer();
    } catch {
      throw unprocessable('the image is larger than 5 MB', [
        { field: 'file', message: 'file too large' },
      ]);
    }
    if (file.file.truncated) {
      throw unprocessable('the image is larger than 5 MB', [
        { field: 'file', message: 'file too large' },
      ]);
    }

    try {
      const fileName = await storeAvatar(request.user.id, buffer);
      reply.send({ profilePictureUrl: avatarUrl(fileName) });
    } catch (err) {
      if (err instanceof InvalidImageError) {
        throw unprocessable(err.message, [{ field: 'file', message: err.message }]);
      }
      throw err;
    }
  });
}
