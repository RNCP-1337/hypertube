import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, getAccessToken, type MovieDetail, type StreamStatus } from '../api/client';
import { Alert, Spinner, formatBytes } from './ui';

interface Props {
  movie: MovieDetail;
  onWatched: () => void;
}

const POLL_MS = 2000;
const PROGRESS_MS = 10_000;

const RESOLUTIONS = ['source', '1080', '720', '480', '360'] as const;
type Resolution = (typeof RESOLUTIONS)[number];

const MSE_CODEC = 'video/mp4; codecs="avc1.42E01E, mp4a.40.2"';

export default function VideoPlayer({ movie, onWatched }: Props) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const reportedWatched = useRef(false);

  const [torrentId, setTorrentId] = useState<number | null>(movie.torrents[0]?.id ?? null);
  const [resolution, setResolution] = useState<Resolution>('source');
  const [status, setStatus] = useState<StreamStatus | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subtitles, setSubtitles] = useState(movie.subtitles);

  // video tag can't send an Authorization header, so pass the token as a query param
  const streamUrl = `/api/movies/${movie.id}/stream?token=${encodeURIComponent(
    getAccessToken() ?? '',
  )}${resolution !== 'source' ? `&resolution=${resolution}` : ''}`;
  const canUseMse =
    resolution !== 'source' &&
    typeof window !== 'undefined' &&
    'MediaSource' in window &&
    MediaSource.isTypeSupported(MSE_CODEC);

  useEffect(() => {
    if (!ready || !canUseMse) return;
    const video = videoRef.current;
    if (!video) return;

    let cancelled = false;
    const mediaSource = new MediaSource();
    const objectUrl = URL.createObjectURL(mediaSource);
    video.src = objectUrl;

    const onSourceOpen = () => {
      if (cancelled) return;
      const sourceBuffer = mediaSource.addSourceBuffer(MSE_CODEC);
      const pending: Uint8Array[] = [];
      let appending = false;

      const pump = () => {
        if (appending || cancelled || sourceBuffer.updating) return;
        const chunk = pending.shift();
        if (!chunk) return;
        appending = true;
        try {
          sourceBuffer.appendBuffer(chunk as unknown as BufferSource);
        } catch {
          appending = false;
        }
      };
      sourceBuffer.addEventListener('updateend', () => {
        appending = false;
        pump();
      });

      void (async () => {
        try {
          const response = await fetch(streamUrl);
          if (!response.ok || !response.body) throw new Error('stream fetch failed');
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (cancelled) return;
            if (done) break;
            pending.push(value);
            pump();
          }
          const finish = () => {
            if (cancelled) return;
            if (pending.length === 0 && !appending && mediaSource.readyState === 'open') {
              mediaSource.endOfStream();
            } else {
              setTimeout(finish, 200);
            }
          };
          finish();
        } catch {
          if (!cancelled) setError(t('movie.streamError'));
        }
      })();
    };

    mediaSource.addEventListener('sourceopen', onSourceOpen);
    return () => {
      cancelled = true;
      mediaSource.removeEventListener('sourceopen', onSourceOpen);
      URL.revokeObjectURL(objectUrl);
    };
  }, [ready, canUseMse, streamUrl, t]);

  const start = useCallback(async () => {
    setError(null);
    setReady(false);
    try {
      const data = await api.post<{ status: StreamStatus }>(`/movies/${movie.id}/play`, {
        torrentId: torrentId ?? undefined,
      });
      setStatus(data.status);
    } catch {
      setError(t('movie.streamError'));
    }
  }, [movie.id, torrentId, t]);

  useEffect(() => {
    void start();
  }, [start]);

  useEffect(() => {
    if (ready) return;
    let cancelled = false;

    const poll = window.setInterval(async () => {
      try {
        const next = await api.get<StreamStatus>(`/movies/${movie.id}/status`);
        if (cancelled) return;
        setStatus(next);
        if (next.ready) {
          setReady(true);
          const detail = await api.get<{ movie: MovieDetail }>(`/movies/${movie.id}`);
          if (!cancelled) setSubtitles(detail.movie.subtitles);
        }
        if (next.status === 'error') setError(next.error ?? t('movie.streamError'));
      } catch {
        // transient, the next tick will retry
      }
    }, POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(poll);
    };
  }, [movie.id, ready, t]);

  const reportProgress = useCallback(
    (completed: boolean) => {
      const video = videoRef.current;
      if (!video) return;
      void api
        .post(`/movies/${movie.id}/progress`, {
          positionSec: Math.floor(video.currentTime),
          completed,
        })
        .catch(() => undefined);

      if (!reportedWatched.current) {
        reportedWatched.current = true;
        onWatched();
      }
    },
    [movie.id, onWatched],
  );

  useEffect(() => {
    if (!ready) return;
    const timer = window.setInterval(() => reportProgress(false), PROGRESS_MS);
    return () => window.clearInterval(timer);
  }, [ready, reportProgress]);

  const percent = Math.round((status?.progress ?? 0) * 100);

  return (
    <div className="space-y-3">
      <div className="relative overflow-hidden rounded-xl border border-ink-700 bg-black">
        <div className="aspect-video w-full">
          {ready ? (
            <video
              key={resolution}
              ref={videoRef}
              className="h-full w-full"
              controls
              autoPlay
              playsInline
              preload="metadata"
              poster={movie.backdropUrl ?? movie.coverUrl ?? undefined}
              onEnded={() => reportProgress(true)}
              onPause={() => reportProgress(false)}
              onError={() => setError(t('movie.streamError'))}
            >
              {!canUseMse ? <source src={streamUrl} /> : null}
              {subtitles.map((track) => (
                <track
                  key={track.language}
                  kind="subtitles"
                  srcLang={track.language}
                  label={track.label}
                  src={`/api/movies/${movie.id}/subtitles/${track.language}?token=${encodeURIComponent(
                    getAccessToken() ?? '',
                  )}`}
                  default={track.language === 'en'}
                />
              ))}
            </video>
          ) : (
            <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-6 text-center">
              {error ? (
                <>
                  <Alert kind="error">{error}</Alert>
                  <button type="button" onClick={() => void start()} className="btn-secondary">
                    {t('movie.retry')}
                  </button>
                </>
              ) : (
                <>
                  <Spinner className="h-8 w-8 text-accent" />
                  <p className="text-sm font-medium text-slate-200">
                    {status?.connectedPeers ? t('movie.buffering') : t('movie.connecting')}
                  </p>
                  <div className="w-full max-w-sm">
                    <div className="h-1.5 overflow-hidden rounded-full bg-ink-700">
                      <div
                        className="h-full rounded-full bg-accent transition-[width] duration-500"
                        style={{ width: `${Math.max(2, Math.min(100, percent))}%` }}
                      />
                    </div>
                    <p className="mt-2 text-xs text-muted">
                      {t('movie.downloaded', { percent })}
                      {status?.connectedPeers
                        ? ` · ${t('movie.peers', { count: status.connectedPeers })}`
                        : ''}
                      {status?.downloadRate
                        ? ` · ${t('movie.speed', { speed: formatBytes(status.downloadRate) })}`
                        : ''}
                    </p>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {movie.torrents.length > 1 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted">
            {t('movie.selectQuality')}
          </span>
          {movie.torrents.map((torrent) => (
            <button
              key={torrent.id}
              type="button"
              onClick={() => setTorrentId(torrent.id)}
              className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
                torrentId === torrent.id
                  ? 'border-accent bg-accent-soft text-white'
                  : 'border-ink-600 bg-ink-800 text-slate-300 hover:border-ink-600/70'
              }`}
            >
              {torrent.quality}
              {torrent.sizeBytes ? (
                <span className="ml-1.5 font-normal text-muted">
                  {formatBytes(torrent.sizeBytes)}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-muted">
          {t('movie.selectResolution')}
        </span>
        {RESOLUTIONS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setResolution(option)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors ${
              resolution === option
                ? 'border-accent bg-accent-soft text-white'
                : 'border-ink-600 bg-ink-800 text-slate-300 hover:border-ink-600/70'
            }`}
          >
            {option === 'source' ? t('movie.resolutionAuto') : `${option}p`}
          </button>
        ))}
      </div>
    </div>
  );
}
