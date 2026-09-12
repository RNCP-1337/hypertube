import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, ApiError, type Comment } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { Alert, Avatar, Spinner } from './ui';

const PER_PAGE = 10;

function timeAgo(iso: string, locale: string): string {
  const date = new Date(iso);
  const diff = (date.getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ];

  for (const [unit, seconds] of units) {
    if (Math.abs(diff) >= seconds) return rtf.format(Math.round(diff / seconds), unit);
  }
  return rtf.format(Math.round(diff), 'second');
}

function CommentItem({
  comment,
  onUpdated,
  onDeleted,
}: {
  comment: Comment;
  onUpdated: (comment: Comment) => void;
  onDeleted: (id: number) => void;
}) {
  const { t, i18n } = useTranslation();
  const { user } = useAuth();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.content);
  const [busy, setBusy] = useState(false);

  const isAuthor = user?.id === comment.author.id;

  const save = async () => {
    const content = draft.trim();
    if (content === '' || content === comment.content) {
      setEditing(false);
      setDraft(comment.content);
      return;
    }
    setBusy(true);
    try {
      const data = await api.patch<{ comment: Comment }>(`/comments/${comment.id}`, { content });
      onUpdated(data.comment);
      setEditing(false);
    } catch {
      setDraft(comment.content);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(t('comments.confirmDelete'))) return;
    setBusy(true);
    try {
      await api.delete(`/comments/${comment.id}`);
      onDeleted(comment.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex gap-3 border-b border-ink-700 py-4 last:border-0">
      <Link to={`/users/${comment.author.id}`} className="shrink-0">
        <Avatar src={comment.author.profilePictureUrl} name={comment.author.username} size={36} />
      </Link>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <Link
            to={`/users/${comment.author.id}`}
            className="text-sm font-semibold text-slate-100 hover:text-white"
          >
            {comment.author.username}
          </Link>
          <time dateTime={comment.createdAt} className="text-xs text-muted">
            {timeAgo(comment.createdAt, i18n.resolvedLanguage ?? 'en')}
          </time>
        </div>

        {editing ? (
          <div className="mt-2 space-y-2">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={3}
              maxLength={2000}
              className="field resize-y"
            />
            <div className="flex gap-2">
              <button type="button" onClick={() => void save()} disabled={busy} className="btn-primary py-1.5 text-xs">
                {t('comments.save')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setDraft(comment.content);
                }}
                className="btn-ghost py-1.5 text-xs"
              >
                {t('comments.cancel')}
              </button>
            </div>
          </div>
        ) : (
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-300">
            {comment.content}
          </p>
        )}

        {isAuthor && !editing ? (
          <div className="mt-2 flex gap-3 text-xs">
            <button type="button" onClick={() => setEditing(true)} className="text-muted hover:text-slate-200">
              {t('comments.edit')}
            </button>
            <button type="button" onClick={() => void remove()} disabled={busy} className="text-muted hover:text-accent">
              {t('comments.delete')}
            </button>
          </div>
        ) : null}
      </div>
    </li>
  );
}

export default function Comments({ movieId }: { movieId: number }) {
  const { t } = useTranslation();
  const [comments, setComments] = useState<Comment[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (targetPage: number) => {
      try {
        const data = await api.get<{ comments: Comment[]; hasMore: boolean }>(
          `/movies/${movieId}/comments?page=${targetPage}&perPage=${PER_PAGE}`,
        );
        setComments((current) =>
          targetPage === 1 ? data.comments : [...current, ...data.comments],
        );
        setHasMore(data.hasMore);
        setPage(targetPage);
      } catch {
        setError(t('errors.generic'));
      } finally {
        setLoading(false);
      }
    },
    [movieId, t],
  );

  useEffect(() => {
    setLoading(true);
    void load(1);
  }, [load]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (content === '') return;

    setPosting(true);
    setError(null);
    try {
      const data = await api.post<{ comment: Comment }>(`/movies/${movieId}/comments`, { content });
      setComments((current) => [data.comment, ...current]);
      setDraft('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('errors.generic'));
    } finally {
      setPosting(false);
    }
  };

  return (
    <section className="card p-5">
      <h2 className="text-lg font-semibold text-white">
        {t('comments.title')}
        <span className="ml-2 text-sm font-normal text-muted">({comments.length})</span>
      </h2>

      <form onSubmit={submit} className="mt-4 space-y-2">
        <label className="sr-only" htmlFor="comment-draft">
          {t('comments.placeholder')}
        </label>
        <textarea
          id="comment-draft"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t('comments.placeholder')}
          rows={3}
          maxLength={2000}
          className="field resize-y"
        />
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted">{draft.length}/2000</span>
          <button type="submit" disabled={posting || draft.trim() === ''} className="btn-primary py-2 text-sm">
            {posting ? <Spinner className="h-4 w-4" /> : null}
            {t('comments.submit')}
          </button>
        </div>
      </form>

      {error ? (
        <div className="mt-3">
          <Alert kind="error">{error}</Alert>
        </div>
      ) : null}

      {loading ? (
        <div className="flex justify-center py-8">
          <Spinner className="h-6 w-6 text-muted" />
        </div>
      ) : comments.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">{t('comments.empty')}</p>
      ) : (
        <>
          <ul className="mt-2">
            {comments.map((comment) => (
              <CommentItem
                key={comment.id}
                comment={comment}
                onUpdated={(updated) =>
                  setComments((current) =>
                    current.map((item) => (item.id === updated.id ? updated : item)),
                  )
                }
                onDeleted={(id) =>
                  setComments((current) => current.filter((item) => item.id !== id))
                }
              />
            ))}
          </ul>

          {hasMore ? (
            <button type="button" onClick={() => void load(page + 1)} className="btn-secondary mt-4 w-full">
              {t('comments.loadMore')}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
