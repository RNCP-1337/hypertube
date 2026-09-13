import { z } from 'zod';
import { SUPPORTED_LANGUAGES } from '../config';

export const usernameSchema = z
  .string()
  .trim()
  .min(3, 'username must be at least 3 characters')
  .max(20, 'username must be at most 20 characters')
  .regex(/^[A-Za-z0-9_.-]+$/, 'username may only contain letters, digits, . _ and -');

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .email('invalid e-mail address');

export const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(50)
  // Letters (any script), spaces, apostrophes and hyphens - nothing else.
  .regex(/^[\p{L}\p{M}][\p{L}\p{M}\s'-]*$/u, 'invalid name');

export const passwordSchema = z
  .string()
  .min(8, 'password must be at least 8 characters')
  .max(128, 'password must be at most 128 characters')
  .refine((value) => {
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
    return classes >= 3;
  }, 'password must mix upper case, lower case, digits and symbols');

export const languageSchema = z.enum(SUPPORTED_LANGUAGES);

export const idSchema = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const infoHashSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[0-9a-f]{40}$/, 'invalid info-hash');

export const registerSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  firstName: nameSchema,
  lastName: nameSchema,
  password: passwordSchema,
  language: languageSchema.optional(),
});

export const loginSchema = z.object({
  username: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(128),
});

export const forgotPasswordSchema = z.object({
  email: emailSchema,
});

export const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: passwordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

export const updateProfileSchema = z
  .object({
    username: usernameSchema.optional(),
    email: emailSchema.optional(),
    firstName: nameSchema.optional(),
    lastName: nameSchema.optional(),
    language: languageSchema.optional(),
    password: passwordSchema.optional(),
    profilePictureUrl: z.string().url().max(2048).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, 'nothing to update');

export const browseQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).max(500).default(1),
  perPage: z.coerce.number().int().min(1).max(50).default(20),
  sort: z.enum(['title', 'year', 'rating', 'popularity']).default('popularity'),
  order: z.enum(['asc', 'desc']).default('desc'),
  genre: z.string().trim().max(40).optional(),
  yearMin: z.coerce.number().int().min(1878).max(2100).optional(),
  yearMax: z.coerce.number().int().min(1878).max(2100).optional(),
  ratingMin: z.coerce.number().min(0).max(10).optional(),
});

export const commentSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, 'comment cannot be empty')
    .max(2000, 'comment is too long'),
});

export const createCommentSchema = commentSchema.extend({
  movieId: idSchema.optional(),
});

export const watchProgressSchema = z.object({
  positionSec: z.coerce.number().min(0).max(86_400).default(0),
  completed: z.coerce.boolean().default(false),
});

export const playSchema = z.object({
  torrentId: idSchema.optional(),
});

export const createMovieSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    year: z.coerce.number().int().min(1878).max(2100).optional(),
    summary: z.string().trim().max(4000).optional(),
    coverUrl: z.string().url().max(2048).optional(),
    genres: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
    quality: z.string().trim().min(1).max(20).default('unknown'),
    magnetUri: z.string().trim().min(10).max(4000).optional(),
    torrentUrl: z.string().url().max(2048).optional(),
  })
  .refine((data) => data.magnetUri ?? data.torrentUrl, {
    message: 'magnetUri or torrentUrl is required',
    path: ['magnetUri'],
  });

export const tokenRequestSchema = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('client_credentials'),
    client_id: z.string().min(1).max(200),
    client_secret: z.string().min(1).max(400),
    scope: z.string().max(200).optional(),
  }),
  z.object({
    grant_type: z.literal('password'),
    client_id: z.string().min(1).max(200),
    client_secret: z.string().min(1).max(400),
    username: z.string().min(1).max(254),
    password: z.string().min(1).max(128),
    scope: z.string().max(200).optional(),
  }),
  z.object({
    grant_type: z.literal('authorization_code'),
    client_id: z.string().min(1).max(200),
    client_secret: z.string().min(1).max(400),
    code: z.string().min(10).max(400),
    redirect_uri: z.string().url().max(2048),
  }),
  z.object({
    grant_type: z.literal('refresh_token'),
    client_id: z.string().min(1).max(200),
    client_secret: z.string().min(1).max(400),
    refresh_token: z.string().min(10).max(4000),
  }),
]);

export interface FieldError {
  field: string;
  message: string;
}

export function formatZodError(error: z.ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || '_',
    message: issue.message,
  }));
}
