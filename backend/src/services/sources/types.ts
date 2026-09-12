export interface SourceTorrent {
  quality: string; // '1080p' | '720p' | '480p' | 'unknown'
  container?: string; // 'mp4' | 'mkv' | 'avi' ...
  sizeBytes?: number;
  seeders: number;
  leechers: number;
  magnetUri?: string;
  torrentUrl?: string;
  infoHash?: string;
}

export interface SourceMovie {
  source: string;
  sourceId: string;
  title: string;
  year?: number;
  summary?: string;
  coverUrl?: string;
  genres: string[];
  language?: string;
  runtime?: number;
  rating?: number;
  popularity: number;
  torrents: SourceTorrent[];
}

export interface SourceQuery {
  search?: string;
  page: number;
  perPage: number;
}

export interface MovieSource {
  readonly id: string;
  readonly label: string;
  readonly homepage: string;
  search(query: SourceQuery): Promise<SourceMovie[]>;
  popular(query: SourceQuery): Promise<SourceMovie[]>;
}

export function guessQuality(name: string, sizeBytes?: number): string {
  const lower = name.toLowerCase();
  if (/2160p|4k|uhd/.test(lower)) return '2160p';
  if (/1080p|fullhd|full hd/.test(lower)) return '1080p';
  if (/720p|hd\b/.test(lower)) return '720p';
  if (/480p|sd\b/.test(lower)) return '480p';
  if (/360p/.test(lower)) return '360p';

  // Some catalogues describe the width instead ("320 pixels wide").
  const width = /(\d{3,4})\s*pixels/.exec(lower);
  if (width) {
    const px = Number(width[1]);
    if (px >= 1900) return '1080p';
    if (px >= 1200) return '720p';
    if (px >= 600) return '480p';
    return `${px}px`;
  }
  if (/\bpsp\b/.test(lower)) return '480p';
  if (/\bpda\b|pocketpc/.test(lower)) return '320px';

  if (sizeBytes && sizeBytes > 2.5e9) return '1080p';
  if (sizeBytes && sizeBytes > 8e8) return '720p';
  if (sizeBytes && sizeBytes > 2e8) return '480p';
  return 'SD';
}

export function guessContainer(name: string): string | undefined {
  const match = /\.(mp4|mkv|avi|webm|mov|mpg|mpeg|ogv)$/i.exec(name.trim());
  return match ? match[1].toLowerCase() : undefined;
}

export function extractYear(value?: string | null): number | undefined {
  if (!value) return undefined;
  const match = /\b(18|19|20)\d{2}\b/.exec(value);
  if (!match) return undefined;
  const year = Number(match[0]);
  return year >= 1878 && year <= new Date().getFullYear() + 2 ? year : undefined;
}

export function stripHtml(input?: string | null): string | undefined {
  if (!input) return undefined;
  const text = input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0 ? text.slice(0, 4000) : undefined;
}
