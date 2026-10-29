import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import SessionList from '../components/SessionList';
import { useSessions } from '../hooks/useSessions';
import { IconHistory, IconPlus, IconSearch } from '../components/icons';

export default function SessionsPage() {
  const { sessions, loading, error, actionError, deletingId, load, remove } = useSessions();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!value) return sessions;
    return sessions.filter(session =>
      [session.title, session.connection.name, session.connection.database].some(field =>
        field.toLowerCase().includes(value)
      )
    );
  }, [query, sessions]);

  const searching = query.trim().length > 0;

  return (
    <section className="page">
      <div className="page-heading with-actions">
        <div>
          <p className="eyebrow">Session history</p>
          <h1>History</h1>
          <p>
            Every saved session keeps its database, table scope, and question history. Open one to
            continue where you left off.
          </p>
        </div>
        <Link className="btn btn-primary" to="/">
          <IconPlus size={17} /> New session
        </Link>
      </div>

      {!loading && !error && sessions.length > 0 && (
        <div className="session-search">
          <IconSearch size={16} />
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search by title, connection, or database"
            aria-label="Search sessions"
          />
          {searching && (
            <button className="btn btn-ghost btn-sm" onClick={() => setQuery('')}>
              Clear
            </button>
          )}
        </div>
      )}

      <SessionList
        sessions={filtered}
        loading={loading}
        error={error}
        actionError={actionError}
        deletingId={deletingId}
        onDelete={remove}
        onRetry={load}
        empty={
          sessions.length === 0 ? (
            <div className="empty-state">
              <span className="placeholder-icon">
                <IconHistory size={24} />
              </span>
              <h2>No sessions yet</h2>
              <p>Start a session to ask your first question and keep its history here.</p>
              <Link className="btn btn-primary" to="/">
                <IconPlus size={17} /> Start a session
              </Link>
            </div>
          ) : (
            <div className="empty-state">
              <span className="placeholder-icon">
                <IconSearch size={24} />
              </span>
              <h2>No matching sessions</h2>
              <p>No saved session matches “{query.trim()}”.</p>
              <button className="btn btn-ghost" onClick={() => setQuery('')}>
                Clear search
              </button>
            </div>
          )
        }
      />
    </section>
  );
}
