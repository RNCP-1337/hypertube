import { spawn } from 'node:child_process';
import { extname } from 'node:path';
import type { Readable } from 'node:stream';

const NATIVE_CONTAINERS = new Set(['.mp4', '.m4v', '.webm']);

const BROWSER_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const BROWSER_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);

export interface ProbeResult {
  durationSec: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  subtitleStreams: Array<{ index: number; language: string; title?: string; codec: string }>;
}

interface FfprobeStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  tags?: Record<string, string>;
}

interface FfprobeOutput {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

export function isNativelyPlayable(filePath: string): boolean {
  return NATIVE_CONTAINERS.has(extname(filePath).toLowerCase());
}

export function probe(filePath: string, timeoutMs = 20_000): Promise<ProbeResult | null> {
  return new Promise((resolve) => {
    const child = spawn(
      'ffprobe',
      [
        '-v', 'error',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        '-analyzeduration', '10000000',
        '-probesize', '10000000',
        filePath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 4 * 1024 * 1024) child.kill('SIGKILL');
    });
    child.stderr.resume();
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const data = JSON.parse(stdout) as FfprobeOutput;
        const streams = data.streams ?? [];
        const video = streams.find((s) => s.codec_type === 'video');
        const audio = streams.find((s) => s.codec_type === 'audio');

        resolve({
          durationSec: data.format?.duration ? Number(data.format.duration) : null,
          videoCodec: video?.codec_name ?? null,
          audioCodec: audio?.codec_name ?? null,
          width: video?.width ?? null,
          height: video?.height ?? null,
          subtitleStreams: streams
            .filter((s) => s.codec_type === 'subtitle')
            .map((s, order) => ({
              index: order,
              language: (s.tags?.language ?? 'und').toLowerCase().slice(0, 8),
              title: s.tags?.title,
              codec: s.codec_name ?? 'unknown',
            })),
        });
      } catch {
        resolve(null);
      }
    });
  });
}

export interface TranscodeHandle {
  stream: Readable;
  contentType: string;
  kill: () => void;
}

export function transcodeToMp4(
  filePath: string,
  probeResult: ProbeResult | null,
  startSeconds = 0,
): TranscodeHandle {
  const canCopyVideo =
    probeResult?.videoCodec !== null && BROWSER_VIDEO_CODECS.has(probeResult?.videoCodec ?? '');
  const canCopyAudio =
    probeResult?.audioCodec !== null && BROWSER_AUDIO_CODECS.has(probeResult?.audioCodec ?? '');

  const args: string[] = ['-hide_banner', '-loglevel', 'error'];

  // Seeking before -i is the fast path (keyframe accurate, no decoding).
  if (startSeconds > 0) args.push('-ss', startSeconds.toFixed(3));

  args.push('-i', filePath);

  // Take the first video and audio stream only; subtitles are served
  // separately as WebVTT so the player can toggle them.
  args.push('-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn');

  if (canCopyVideo) {
    args.push('-c:v', 'copy');
  } else {
    args.push(
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-tune', 'zerolatency',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      // Keyframe every 2s keeps the fragments small and seeking responsive.
      '-force_key_frames', 'expr:gte(t,n_forced*2)',
    );
  }

  if (canCopyAudio) {
    args.push('-c:a', 'copy');
  } else {
    args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2');
  }

  args.push(
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof+faststart',
    '-frag_duration', '2000000',
    'pipe:1',
  );

  const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  // Drain stderr so ffmpeg never blocks on a full pipe; log real failures only.
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-2000);
  });
  child.on('close', (code, signal) => {
    if (code !== 0 && signal === null && stderr.trim() !== '') {
      console.warn(`[transcode] ffmpeg exited ${code}: ${stderr.trim().split('\n').pop()}`);
    }
  });
  child.on('error', (err) => {
    console.error(`[transcode] cannot start ffmpeg: ${err.message}`);
    child.stdout.destroy(err);
  });

  return {
    stream: child.stdout,
    contentType: 'video/mp4',
    kill: () => {
      if (!child.killed) child.kill('SIGKILL');
    },
  };
}

export function extractSubtitle(
  filePath: string,
  streamIndex: number,
  outputPath: string,
  timeoutMs = 180_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-i', filePath,
        '-map', `0:s:${streamIndex}`,
        '-c:s', 'webvtt',
        '-f', 'webvtt',
        outputPath,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stderr.resume();
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

export function convertSubtitleFile(
  inputPath: string,
  outputPath: string,
  timeoutMs = 60_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, '-f', 'webvtt', outputPath],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stderr.resume();
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

export function normaliseImage(
  inputPath: string,
  outputPath: string,
  size = 512,
  timeoutMs = 20_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-i', inputPath,
        // A single frame only: an animated bomb cannot loop us.
        '-frames:v', '1',
        '-vf', `scale='min(${size},iw)':-2`,
        '-f', 'image2',
        '-vcodec', 'mjpeg',
        '-q:v', '4',
        outputPath,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );

    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stderr.resume();
    child.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}
