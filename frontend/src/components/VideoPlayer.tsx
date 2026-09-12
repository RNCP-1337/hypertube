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

export default function VideoPlayer({ movie, onWatched }: Props) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const reportedWatched = useRef(false);

  const [torrentId, setTorrentId] = useState<number | null>(movie.torrents[0]?.id ?? null);
  const [status, setStatus] = useState<StreamStatus | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [subtitles, setSubtitles] = useState(movie.subtitles);

  // The <video> element cannot send an Authorization header, so the stream URL
  // carries a short-lived token instead.
  const streamUrl = `/api/movies/${movie.id}/stream?token=${encodeURIComponent(
    getAccessToken() ?? '',
  )}`;

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
              <source src={streamUrl} type="video/mp4" />
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
    </div>
  );
}
