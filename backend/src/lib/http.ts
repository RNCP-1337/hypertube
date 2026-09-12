export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

export async function fetchBuffer(url: string, options: FetchOptions = {}): Promise<Buffer> {
  const { timeoutMs = DEFAULT_TIMEOUT, maxBytes = DEFAULT_MAX_BYTES, headers } = options;

  // Only http(s): never let a source string turn into a file:// or data: read.
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`refusing to fetch non-HTTP url: ${parsed.protocol}`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(parsed, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Hypertube/1.0', ...headers },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${parsed.host}${parsed.pathname}`);

    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > maxBytes) throw new Error('remote response too large');

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error('remote response too large');
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const buf = await fetchBuffer(url, { maxBytes: 5 * 1024 * 1024, ...options });
  return JSON.parse(buf.toString('utf8')) as T;
}

export async function tryFetchJson<T>(url: string, options: FetchOptions = {}): Promise<T | null> {
  try {
    return await fetchJson<T>(url, options);
  } catch {
    return null;
  }
}
