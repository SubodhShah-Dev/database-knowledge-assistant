import { useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import SessionList from './SessionList';
import { useSessions } from '../hooks/useSessions';
import { IconClose, IconHistory, IconPlus } from './icons';

type Props = {
  currentId?: string;
  onClose: () => void;
};

export default function SessionsDrawer({ currentId, onClose }: Props) {
  const navigate = useNavigate();
  const closeButton = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const { sessions, loading, error, actionError, deletingId, load, remove } = useSessions();

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = window.setTimeout(() => closeButton.current?.focus(), 0);
    return () => {
      window.clearTimeout(timer);
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !drawerRef.current) return;
      const focusable = Array.from(
        drawerRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter(element => element.offsetParent !== null);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      const outside = !drawerRef.current.contains(active);
      if (event.shiftKey && (active === first || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function handleDelete(session: (typeof sessions)[number]) {
    const deleted = await remove(session);
    if (deleted && session.id === currentId) {
      onClose();
      navigate('/sessions');
    }
  }

  return (
    <div
      className="drawer-backdrop"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="drawer history-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-title"
        ref={drawerRef}
      >
        <header className="drawer-head">
          <div>
            <p className="eyebrow">Session history</p>
            <h2 id="history-title">Recent sessions</h2>
            <p className="drawer-subtitle">Open a saved session or start a new one.</p>
          </div>
          <button
            ref={closeButton}
            className="btn btn-ghost btn-icon"
            aria-label="Close session history"
            onClick={onClose}
          >
            <IconClose size={19} />
          </button>
        </header>

        <div className="drawer-body">
          <SessionList
            sessions={sessions}
            loading={loading}
            error={error}
            actionError={actionError}
            deletingId={deletingId}
            currentId={currentId}
            compact
            onDelete={session => void handleDelete(session)}
            onRetry={load}
            onNavigate={onClose}
            empty={
              <div className="empty-state drawer-empty">
                <span className="placeholder-icon">
                  <IconHistory size={24} />
                </span>
                <h2>No sessions yet</h2>
                <p>Your saved sessions will appear here.</p>
              </div>
            }
          />
        </div>

        <footer className="drawer-foot">
          <div className="drawer-actions">
            <Link className="btn btn-ghost" to="/" onClick={onClose}>
              <IconPlus size={16} /> New session
            </Link>
            <Link className="btn btn-primary" to="/sessions" onClick={onClose}>
              View all sessions
            </Link>
          </div>
        </footer>
      </div>
    </div>
  );
}
