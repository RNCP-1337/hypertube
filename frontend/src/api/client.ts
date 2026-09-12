export interface ApiFieldError {
  field: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: ApiFieldError[],
  ) {
    super(message);
    this.name = 'ApiError';
  }

  fieldError(field: string): string | undefined {
    return this.details?.find((d) => d.field === field)?.message;
  }
}

const BASE = '/api';

let accessToken: string | null = null;
let refreshPromise: Promise<boolean> | null = null;
let onSessionLost: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function onUnauthenticated(handler: () => void): void {
  onSessionLost = handler;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  skipRefresh?: boolean;
  formData?: FormData;
}

async function parseError(response: Response): Promise<ApiError> {
  let payload: { error?: string; message?: string; details?: ApiFieldError[] } = {};
  try {
    payload = await response.json();
  } catch {}
  return new ApiError(
    response.status,
    payload.error ?? 'request_failed',
    payload.message ?? `request failed with status ${response.status}`,
    payload.details,
  );
}

export async function refreshSession(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const response = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return false;
      const data = (await response.json()) as { accessToken?: string };
      if (!data.accessToken) return false;
      accessToken = data.accessToken;
      return true;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  let body: BodyInit | undefined;
  if (options.formData) {
    body = options.formData;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const send = () =>
    fetch(`${BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body,
      credentials: 'include',
      signal: options.signal,
    });

  let response = await send();

  if (response.status === 401 && !options.skipRefresh) {
    const refreshed = await refreshSession();
    if (refreshed) {
      headers.Authorization = `Bearer ${accessToken as string}`;
      response = await send();
    } else {
      accessToken = null;
      onSessionLost?.();
    }
  }

  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: 'POST', body, signal }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  upload: <T>(path: string, formData: FormData) =>
    request<T>(path, { method: 'POST', formData }),
};

export interface User {
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

export interface MovieCard {
  id: number;
  title: string;
  year: number | null;
  rating: number | null;
  coverUrl: string | null;
  genres: string[];
  source: string;
  watched: boolean;
  popularity: number;
}

export interface MovieTorrent {
  id: number;
  quality: string;
  container: string | null;
  sizeBytes: number | null;
  seeders: number;
  leechers: number;
}

export interface MovieDetail extends MovieCard {
  summary: string | null;
  backdropUrl: string | null;
  runtime: number | null;
  director: string | null;
  producer: string | null;
  cast: string[];
  imdbId: string | null;
  language: string | null;
  sourceId: string;
  torrents: MovieTorrent[];
  commentCount: number;
  subtitles: Array<{ language: string; label: string }>;
  download: {
    status: string;
    progress: number;
    downloadedBytes: number;
    totalBytes: number;
  } | null;
}

export interface Comment {
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

export interface StreamStatus {
  started: boolean;
  status: string;
  ready: boolean;
  progress: number;
  downloadedBytes?: number;
  totalBytes?: number;
  peers?: number;
  connectedPeers?: number;
  downloadRate?: number;
  webSeeds?: number;
  error?: string;
}

export interface AuthResponse {
  user: User;
  accessToken: string;
  expiresIn: number;
}
