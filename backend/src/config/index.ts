import { z } from 'zod';

const bool = (d: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? d : v === 'true' || v === '1'));

const int = (d: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? d : Number.parseInt(v, 10)))
    .pipe(z.number().int());

const num = (d: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? d : Number.parseFloat(v)))
    .pipe(z.number());

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(3000),
  PUBLIC_URL: z.string().url().default('http://localhost:8080'),

  POSTGRES_HOST: z.string().default('postgres'),
  POSTGRES_PORT: int(5432),
  POSTGRES_DB: z.string().min(1),
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 chars'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 chars'),
  ACCESS_TOKEN_TTL: int(900),
  REFRESH_TOKEN_TTL_DAYS: int(30),

  SMTP_HOST: z.string().default('mailhog'),
  SMTP_PORT: int(1025),
  SMTP_SECURE: bool(false),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  MAIL_FROM: z.string().default('Hypertube <no-reply@hypertube.local>'),

  OAUTH_42_CLIENT_ID: optionalString,
  OAUTH_42_CLIENT_SECRET: optionalString,
  OAUTH_GOOGLE_CLIENT_ID: optionalString,
  OAUTH_GOOGLE_CLIENT_SECRET: optionalString,
  OAUTH_GITHUB_CLIENT_ID: optionalString,
  OAUTH_GITHUB_CLIENT_SECRET: optionalString,
  OAUTH_DISCORD_CLIENT_ID: optionalString,
  OAUTH_DISCORD_CLIENT_SECRET: optionalString,

  API_CLIENT_ID: z.string().default('hypertube-default-client'),
  API_CLIENT_SECRET: z.string().min(8),

  TMDB_API_KEY: optionalString,
  OMDB_API_KEY: optionalString,
  OPENSUBTITLES_API_KEY: optionalString,
  OPENSUBTITLES_USER_AGENT: z.string().default('Hypertube/1.0'),

  TORRENT_PORT: int(6881),
  TORRENT_MAX_PEERS: int(60),
  TORRENT_READAHEAD_PIECES: int(24),
  TORRENT_START_THRESHOLD: num(0.02),
  MEDIA_DIR: z.string().default('/data/media'),
  TORRENT_DIR: z.string().default('/data/torrents'),
  AVATAR_DIR: z.string().default('/data/avatars'),
  MEDIA_RETENTION_DAYS: int(30),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${issues}\n\nDid you run \`make env\`?`);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;

export const isProduction = config.NODE_ENV === 'production';

export const SUPPORTED_LANGUAGES = ['en', 'fr', 'es'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = 'en';

export function enabledOAuthProviders(): string[] {
  const list: string[] = [];
  if (config.OAUTH_42_CLIENT_ID && config.OAUTH_42_CLIENT_SECRET) list.push('42');
  if (config.OAUTH_GOOGLE_CLIENT_ID && config.OAUTH_GOOGLE_CLIENT_SECRET) list.push('google');
  if (config.OAUTH_GITHUB_CLIENT_ID && config.OAUTH_GITHUB_CLIENT_SECRET) list.push('github');
  if (config.OAUTH_DISCORD_CLIENT_ID && config.OAUTH_DISCORD_CLIENT_SECRET) list.push('discord');
  return list;
}
