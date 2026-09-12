import { createReadStream, promises as fs } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import type { Metainfo, TorrentFileEntry } from './metainfo';

export interface ResolvedFile extends TorrentFileEntry {
  absolutePath: string;
}

export class TorrentStorage {
  readonly root: string;
  readonly files: ResolvedFile[];

  private handles = new Map<string, fs.FileHandle>();
  private closed = false;

  constructor(
    private readonly meta: Metainfo,
    mediaDir: string,
  ) {
    // One directory per info-hash keeps names unique and predictable.
    this.root = join(mediaDir, meta.infoHashHex);

    this.files = meta.files.map((file) => {
      const candidate = resolve(this.root, ...file.path);
      // refuse anything that escapes the torrent directory.
      const rel = relative(this.root, candidate);
      if (rel.startsWith('..') || rel.startsWith(`..${sep}`) || normalize(rel) !== rel) {
        throw new Error(`torrent path escapes storage root: ${file.path.join('/')}`);
      }
      return { ...file, absolutePath: candidate };
    });
  }

  async open(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
    for (const file of this.files) {
      if (file.padding) continue;
      await fs.mkdir(dirname(file.absolutePath), { recursive: true });

      // 'r+' and not 'a+': an append-mode descriptor ignores the position
      // argument of write() on Linux, which would send every piece to the end
      // of the file instead of its real offset.
      let handle: fs.FileHandle;
      try {
        handle = await fs.open(file.absolutePath, 'r+');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        handle = await fs.open(file.absolutePath, 'w+');
      }

      // Pre-size the file so seeking readers get a stable length.
      const stat = await handle.stat();
      if (stat.size !== file.length) await handle.truncate(file.length);
      this.handles.set(file.absolutePath, handle);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.handles.values()].map((h) => h.close().catch(() => undefined)));
    this.handles.clear();
  }

  private slices(offset: number, length: number): Array<{
    file: ResolvedFile;
    fileOffset: number;
    length: number;
    bufferOffset: number;
  }> {
    const out = [];
    let remaining = length;
    let cursor = offset;

    for (const file of this.files) {
      if (remaining <= 0) break;
      const fileEnd = file.offset + file.length;
      if (cursor >= fileEnd) continue;
      if (cursor < file.offset) continue;

      const fileOffset = cursor - file.offset;
      const take = Math.min(remaining, file.length - fileOffset);

      // Padding is zeros by definition: nothing to write, nothing to read.
      if (!file.padding) {
        out.push({ file, fileOffset, length: take, bufferOffset: cursor - offset });
      }
      cursor += take;
      remaining -= take;
    }
    return out;
  }

  async write(offset: number, data: Buffer): Promise<void> {
    for (const slice of this.slices(offset, data.length)) {
      const handle = this.handles.get(slice.file.absolutePath);
      if (!handle) throw new Error(`file handle missing for ${slice.file.absolutePath}`);
      await handle.write(
        data,
        slice.bufferOffset,
        slice.length,
        slice.fileOffset,
      );
    }
  }

  async read(offset: number, length: number): Promise<Buffer> {
    const out = Buffer.alloc(length);
    for (const slice of this.slices(offset, length)) {
      const handle = this.handles.get(slice.file.absolutePath);
      if (!handle) throw new Error(`file handle missing for ${slice.file.absolutePath}`);
      await handle.read(out, slice.bufferOffset, slice.length, slice.fileOffset);
    }
    return out;
  }

  async flush(): Promise<void> {
    await Promise.all(
      [...this.handles.values()].map((h) => h.datasync().catch(() => undefined)),
    );
  }

  pickPrimaryVideoFile(): ResolvedFile | null {
    const VIDEO = /\.(mp4|m4v|webm|mkv|avi|mov|mpg|mpeg|ogv|ts|wmv|flv)$/i;
    const NATIVE = /\.(mp4|m4v|webm)$/i;

    const name = (f: ResolvedFile) => f.path[f.path.length - 1];
    const largest = (list: ResolvedFile[]) =>
      list.reduce((a, b) => (b.length > a.length ? b : a));

    const videos = this.files.filter((f) => !f.padding && VIDEO.test(name(f)));
    if (videos.length === 0) {
      const real = this.files.filter((f) => !f.padding);
      return real.length > 0 ? largest(real) : null;
    }

    // Torrents from archival sources bundle several encodings of the same film.
    // A container the browser plays natively avoids a transcode entirely, and
    // those derivatives are also far smaller than the original masters.
    const native = videos.filter((f) => NATIVE.test(name(f)));
    return largest(native.length > 0 ? native : videos);
  }

  subtitleFiles(): ResolvedFile[] {
    return this.files.filter(
      (f) => !f.padding && /\.(srt|vtt|ass|ssa|sub)$/i.test(f.path[f.path.length - 1]),
    );
  }

  createFileReadStream(file: ResolvedFile, start: number, end: number): Readable {
    return createReadStream(file.absolutePath, { start, end });
  }

  piecesForFileRange(file: ResolvedFile, start: number, end: number): [number, number] {
    const absStart = file.offset + start;
    const absEnd = file.offset + end;
    return [
      Math.floor(absStart / this.meta.pieceLength),
      Math.min(
        this.meta.pieceHashes.length - 1,
        Math.floor(absEnd / this.meta.pieceLength),
      ),
    ];
  }

  async totalOnDisk(): Promise<number> {
    let total = 0;
    for (const file of this.files) {
      if (file.padding) continue;
      try {
        const stat = await fs.stat(file.absolutePath);
        total += stat.size;
      } catch {}
    }
    return total;
  }

  async destroy(): Promise<void> {
    await this.close();
    await fs.rm(this.root, { recursive: true, force: true });
  }
}
