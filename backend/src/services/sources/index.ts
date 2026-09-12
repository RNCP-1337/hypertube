import { archiveSource } from './archive';
import { publicDomainSource } from './publicdomain';
import type { MovieSource, SourceMovie, SourceQuery } from './types';

export const sources: MovieSource[] = [archiveSource, publicDomainSource];

export type { MovieSource, SourceMovie, SourceQuery, SourceTorrent } from './types';

async function gather(
  pick: (source: MovieSource) => Promise<SourceMovie[]>,
): Promise<SourceMovie[]> {
  const settled = await Promise.allSettled(
    sources.map(async (source) => {
      try {
        return await pick(source);
      } catch (err) {
        console.warn(`[sources] ${source.id} failed: ${(err as Error).message}`);
        return [];
      }
    }),
  );

  const movies: SourceMovie[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') movies.push(...result.value);
  }
  return movies;
}

export function searchSources(query: SourceQuery): Promise<SourceMovie[]> {
  return gather((source) => source.search(query));
}

export function popularFromSources(query: SourceQuery): Promise<SourceMovie[]> {
  return gather((source) => source.popular(query));
}

export function sourceInfo(): Array<{ id: string; label: string; homepage: string }> {
  return sources.map(({ id, label, homepage }) => ({ id, label, homepage }));
}
