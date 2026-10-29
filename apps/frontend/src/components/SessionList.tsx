import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ConversationSummary } from '../types';
import { timeAgo } from '../format';
import {
  IconAlert,
  IconArrowRight,
  IconChat,
  IconCheck,
  IconClose,
  IconEdit,
  IconRefresh,
  IconTrash
} from './icons';

type Props = {
  sessions: ConversationSummary[];
  loading: boolean;
  error: string;
  actionError: string;
  deletingId: string | null;
  renamingId: string | null;
  currentId?: string;
  compact?: boolean;
  onDelete: (session: ConversationSummary) => void;
  onRename: (session: ConversationSummary, title: string) => Promise<boolean>;
  onRetry: () => void;
  onNavigate?: () => void;
  empty: ReactNode;
};

export default function SessionList({
  sessions,
  loading,
  error,
  actionError,
  deletingId,
  renamingId,
  currentId,
  compact = false,
  onDelete,
  onRename,
  onRetry,
  onNavigate,
  empty
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');

  if (loading) {
    return (
      <div className="session-list" aria-label="Loading sessions">
        {[0, 1, 2].map(index => (
          <div className="session-row session-row-skeleton" key={index}>
            <span className="skeleton skeleton-line wide" />
            <span className="skeleton skeleton-line short" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="alert alert-danger">
        <IconAlert size={17} />
        <span>{error}</span>
        <button className="btn btn-ghost btn-sm" onClick={onRetry}>
          <IconRefresh size={15} /> Retry
        </button>
      </div>
    );
  }

  return (
    <>
      {actionError && (
        <div className="alert alert-danger session-alert" role="alert">
          <IconAlert size={17} />
          <span>{actionError}</span>
        </div>
      )}

      {sessions.length === 0 ? (
        empty
      ) : (
        <ul className={`session-list${compact ? ' compact' : ''}`}>
          {sessions.map(session => {
            const isCurrent = session.id === currentId;
            const deleting = deletingId === session.id;
            const editing = editingId === session.id;
            const renaming = renamingId === session.id;
            const busy = deletingId !== null || renamingId !== null;

            function startRename() {
              setEditingId(session.id);
              setDraftTitle(session.title);
            }

            function cancelRename() {
              if (renaming) return;
              setEditingId(null);
              setDraftTitle('');
            }

            async function saveRename(event: FormEvent<HTMLFormElement>) {
              event.preventDefault();
              const title = draftTitle.trim();
              if (!title || busy) return;
              if (title === session.title) {
                cancelRename();
                return;
              }
              if (await onRename(session, title)) {
                setEditingId(null);
                setDraftTitle('');
              }
            }

            return (
              <li className={`session-row${isCurrent ? ' current' : ''}`} key={session.id}>
                {editing ? (
                  <form className="session-row-edit-form" onSubmit={event => void saveRename(event)}>
                    <input
                      autoFocus
                      value={draftTitle}
                      onChange={event => setDraftTitle(event.target.value)}
                      aria-label={`Rename ${session.title}`}
                      maxLength={200}
                      required
                      disabled={renaming}
                    />
                    <button
                      className="btn btn-ghost btn-icon session-rename-save"
                      type="submit"
                      aria-label={`Save name for ${session.title}`}
                      title="Save name"
                      disabled={busy || !draftTitle.trim()}
                    >
                      {renaming ? <span className="spinner spinner-sm" /> : <IconCheck size={16} />}
                    </button>
                    <button
                      className="btn btn-ghost btn-icon"
                      type="button"
                      aria-label={`Cancel renaming ${session.title}`}
                      title="Cancel"
                      onClick={cancelRename}
                      disabled={busy}
                    >
                      <IconClose size={16} />
                    </button>
                  </form>
                ) : (
                  <>
                    <Link
                      to={`/c/${session.id}`}
                      className="session-row-main"
                      aria-current={isCurrent ? 'page' : undefined}
                      onClick={onNavigate}
                    >
                      <span className="session-row-icon">
                        <IconChat size={17} />
                      </span>
                      <span className="session-row-body">
                        <span className="session-row-title" title={session.title}>
                          {session.title}
                        </span>
                        <span className="session-row-meta">
                          {session.connection.name} · {session.connection.database} ·{' '}
                          {session.selectedTables.length}{' '}
                          {session.selectedTables.length === 1 ? 'table' : 'tables'}
                        </span>
                      </span>
                      <span className="session-row-time">{timeAgo(session.updatedAt)}</span>
                      <IconArrowRight size={16} />
                    </Link>
                    <button
                      className="btn btn-ghost btn-icon session-rename"
                      aria-label={`Rename ${session.title}`}
                      title="Rename session"
                      disabled={busy}
                      onClick={startRename}
                    >
                      <IconEdit size={16} />
                    </button>
                    <button
                      className="btn btn-ghost btn-icon session-delete"
                      aria-label={`Delete ${session.title}`}
                      title="Delete session"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete "${session.title}"? This permanently removes the session and its question history.`
                          )
                        ) {
                          onDelete(session);
                        }
                      }}
                    >
                      {deleting ? <span className="spinner spinner-sm" /> : <IconTrash size={16} />}
                    </button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
