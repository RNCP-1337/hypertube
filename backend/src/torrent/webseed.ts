import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import type { Metainfo, TorrentFileEntry } from './metainfo';

const REQUEST_TIMEOUT_MS = 30_000;
// How many bytes we are willing to throw away when a mirror ignores Range.
const MAX_DISCARD = 8 * 1024 * 1024;

export class WebSeed {
  private failures = 0;
  private mutedUntil = 0;

  constructor(
    readonly baseUrl: string,
    private readonly meta: Metainfo,
  ) {}

  // A seed is set aside after repeated failures, then given another chance:
  // a mirror that was briefly overloaded should not be lost for good.
  get isHealthy(): boolean {
    if (this.failures < 4) return true;
    if (Date.now() >= this.mutedUntil) {
      this.failures = 0;
      return true;
    }
    return false;
  }

  private urlFor(file: TorrentFileEntry): string {
    const multiFile = this.meta.files.length > 1;
    const encode = (part: string) => encodeURIComponent(part);

    if (!multiFile && !this.baseUrl.endsWith('/')) return this.baseUrl;

    const base = this.baseUrl.endsWith('/') ? this.baseUrl.slice(0, -1) : this.baseUrl;
    const segments = [encode(this.meta.name), ...file.path.map(encode)];
    return `${base}/${segments.join('/')}`;
  }

  async fetchPiece(index: number, pieceLength: number): Promise<Buffer> {
    const absoluteStart = index * this.meta.pieceLength;
    const chunks: Buffer[] = [];
    let remaining = pieceLength;
    let cursor = absoluteStart;

    try {
      for (const file of this.meta.files) {
        if (remaining <= 0) break;
        const fileEnd = file.offset + file.length;
        if (cursor >= fileEnd || cursor < file.offset) continue;

        const start = cursor - file.offset;
        const take = Math.min(remaining, file.length - start);

        // Padding exists on no mirror; requesting it would 404 and take the
        // whole seed down with it.
        chunks.push(
          file.padding
            ? Buffer.alloc(take)
            : await this.rangeGet(this.urlFor(file), start, start + take - 1),
        );
        cursor += take;
        remaining -= take;
      }
    } catch (err) {
      this.failures += 1;
      if (this.failures >= 4) this.mutedUntil = Date.now() + 60_000;
      throw err;
    }

    const piece = Buffer.concat(chunks);
    if (piece.length !== pieceLength) {
      this.failures += 1;
      throw new Error(`web seed returned ${piece.length} bytes, expected ${pieceLength}`);
    }
    this.failures = 0;
    return piece;
  }

  private rangeGet(url: string, start: number, end: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        reject(new Error('web seed is not http(s)'));
        return;
      }
      const isHttps = parsed.protocol === 'https:';

      const req = (isHttps ? httpsRequest : httpRequest)(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: `${parsed.pathname}${parsed.search}`,
          method: 'GET',
          headers: {
            'User-Agent': 'Hypertube/1.0',
            Range: `bytes=${start}-${end}`,
            Connection: 'close',
          },
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            res.resume();
            this.rangeGet(new URL(res.headers.location, parsed).toString(), start, end).then(
              resolve,
              reject,
            );
            return;
          }
          if (res.statusCode !== 206 && res.statusCode !== 200) {
            res.resume();
            reject(new Error(`web seed HTTP ${res.statusCode}`));
            return;
          }

          // Some mirrors ignore Range on small files and send the whole thing
          // with a 200. That is still usable: skip forward to the offset we
          // want and hang up as soon as we have enough.
          const expected = end - start + 1;
          let skip = res.statusCode === 206 ? 0 : start;
          if (skip > MAX_DISCARD) {
            res.destroy();
            reject(new Error('web seed ignores Range on a large file'));
            return;
          }

          const chunks: Buffer[] = [];
          let received = 0;
          let settled = false;

          const finish = () => {
            if (settled) return;
            settled = true;
            const body = Buffer.concat(chunks);
            if (body.length < expected) {
              reject(new Error(`web seed sent ${body.length} of ${expected} bytes`));
              return;
            }
            resolve(body);
          };

          res.on('data', (chunk: Buffer) => {
            if (settled) return;

            let piece = chunk;
            if (skip > 0) {
              if (piece.length <= skip) {
                skip -= piece.length;
                return;
              }
              piece = piece.subarray(skip);
              skip = 0;
            }

            const room = expected - received;
            if (piece.length > room) piece = piece.subarray(0, room);
            chunks.push(piece);
            received += piece.length;

            if (received >= expected) {
              res.destroy();
              finish();
            }
          });
          res.on('end', finish);
          res.on('error', (err) => {
            if (!settled) {
              settled = true;
              reject(err);
            }
          });
        },
      );

      req.on('timeout', () => req.destroy(new Error('web seed timeout')));
      req.on('error', reject);
      req.end();
    });
  }
}
