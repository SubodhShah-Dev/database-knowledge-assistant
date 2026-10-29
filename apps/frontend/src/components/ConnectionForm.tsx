import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import type { Connection, ConnectionInput } from '../types';
import { IconAlert, IconClose, IconPlug } from './icons';

type Props = {
  connection?: Connection | null;
  onClose: () => void;
  onSave: (input: ConnectionInput) => Promise<void>;
};

const SSL_MODES = ['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'];

export default function ConnectionForm({ connection, onClose, onSave }: Props) {
  const editing = Boolean(connection);
  const firstField = useRef<HTMLInputElement>(null);
  const [engine, setEngine] = useState<Connection['engine']>(connection?.engine ?? 'postgres');
  const engineChanged = Boolean(connection && engine !== connection.engine);
  const [name, setName] = useState(connection?.name ?? '');
  const [host, setHost] = useState(connection?.host ?? '127.0.0.1');
  const [port, setPort] = useState(String(connection?.port ?? 5432));
  const [database, setDatabase] = useState(connection?.database_name ?? '');
  const [username, setUsername] = useState(connection?.username ?? '');
  const [password, setPassword] = useState('');
  const [sqlitePath, setSqlitePath] = useState(connection?.sqlite_path ?? '');
  const [connectionUri, setConnectionUri] = useState('');
  const [sslMode, setSslMode] = useState(connection?.ssl_mode ?? 'prefer');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    firstField.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if ((!editing || engineChanged) && engine !== 'sqlite' && engine !== 'mongodb' && !password) {
      setError('Password is required for this database type.');
      return;
    }
    if (engine === 'sqlite' && !sqlitePath.trim()) {
      setError('A SQLite database file path is required.');
      return;
    }
    if (engine === 'mongodb' && (!editing || engineChanged) && !connectionUri.trim()) {
      setError('A MongoDB connection URI is required.');
      return;
    }

    setBusy(true);
    try {
      await onSave({
        engine,
        name: name.trim(),
        host: host.trim(),
        port: Number(port),
        database: database.trim(),
        username: username.trim(),
        password,
        sslMode,
        sqlitePath: sqlitePath.trim(),
        connectionUri: connectionUri.trim()
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the connection.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="connection-title">
        <header className="modal-head">
          <div>
            <p className="eyebrow">{editing ? 'Edit connection' : 'New connection'}</p>
            <h2 id="connection-title">{editing ? connection?.name : 'Connect a database'}</h2>
          </div>
          <button className="btn btn-ghost btn-icon" aria-label="Close" onClick={onClose}>
            <IconClose size={19} />
          </button>
        </header>

        <form className="form-stack" onSubmit={submit}>
          <label className="field">
            <span>Database type</span>
            <select
              value={engine}
              disabled={Boolean(connection?.has_sessions)}
              onChange={event => {
                const next = event.target.value as Connection['engine'];
                if (next === engine) return;
                if (engine === 'sqlite' && next !== 'sqlite') {
                  setHost('127.0.0.1');
                  setUsername('');
                }
                setEngine(next);
                setPort(String(
                  next === 'sqlserver' ? 1433
                    : next === 'mysql' ? 3306
                      : next === 'mongodb' ? 27017
                        : next === 'sqlite' ? 1
                          : 5432
                ));
                setPassword('');
                setConnectionUri('');
                setSqlitePath('');
                setError('');
              }}
            >
              <option value="postgres">PostgreSQL</option>
              <option value="mysql">MySQL / MariaDB / TiDB</option>
              <option value="sqlserver">Microsoft SQL Server</option>
              <option value="sqlite">SQLite</option>
              <option value="mongodb">MongoDB</option>
            </select>
            {connection?.has_sessions ? (
              <small className="field-hint">
                Delete this connection's saved sessions before changing its database type.
              </small>
            ) : editing ? (
              <small className="field-hint">Changing type requires new connection details.</small>
            ) : null}
          </label>

          <label className="field">
            <span>Display name</span>
            <input
              ref={firstField}
              value={name}
              onChange={event => setName(event.target.value)}
              placeholder="Analytics warehouse"
              required
              maxLength={80}
            />
          </label>

          {engine === 'sqlite' ? (
            <>
              <label className="field">
                <span>SQLite database file</span>
                <input
                  value={sqlitePath}
                  onChange={event => setSqlitePath(event.target.value)}
                  placeholder="/path/allowed/to/the/api/data.db"
                  required
                />
              </label>
              <p className="field-hint">
                The file must be inside the API server's SQLITE_ALLOWED_DIR. Queries use an
                in-memory copy and cannot modify the original file.
              </p>
            </>
          ) : engine === 'mongodb' ? (
            <>
              <label className="field">
                <span>MongoDB connection URI</span>
                <input
                  type="password"
                  value={connectionUri}
                  onChange={event => setConnectionUri(event.target.value)}
                  placeholder={editing ? 'Stored securely; leave blank to keep current URI' : 'mongodb+srv://user:password@cluster.example/db'}
                  autoComplete="new-password"
                  required={!editing || engineChanged}
                />
              </label>
              <label className="field">
                <span>Database (optional if included in URI)</span>
                <input value={database} onChange={event => setDatabase(event.target.value)} />
              </label>
              <p className="field-hint">The API must be able to reach the MongoDB host. Use a read-only database user.</p>
            </>
          ) : (
            <>
              <div className="form-grid">
                <label className="field field-wide">
                  <span>Host</span>
                  <input
                    value={host}
                    onChange={event => setHost(event.target.value)}
                    placeholder="db.example.com"
                    aria-describedby="host-hint"
                    required
                  />
                </label>
                <label className="field field-narrow">
                  <span>Port</span>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={port}
                    onChange={event => setPort(event.target.value)}
                    required
                  />
                </label>
              </div>
              <p className="field-hint" id="host-hint">
                The API must be able to reach this host. Link-local and cloud metadata addresses are
                blocked.
              </p>

              <div className="form-grid">
                <label className="field">
                  <span>Database</span>
                  <input
                    value={database}
                    onChange={event => setDatabase(event.target.value)}
                    placeholder="analytics"
                    required
                  />
                </label>
                <label className="field">
                  <span>Username</span>
                  <input
                    value={username}
                    onChange={event => setUsername(event.target.value)}
                    placeholder="readonly_user"
                    autoComplete="username"
                    required
                  />
                </label>
              </div>

              <label className="field">
                <span>{editing && !engineChanged ? 'Password (leave blank to keep current)' : 'Password'}</span>
                <input
                  type="password"
                  value={password}
                  onChange={event => setPassword(event.target.value)}
                  autoComplete={editing ? 'new-password' : 'current-password'}
                  placeholder={editing ? 'Unchanged' : 'Database password'}
                  required={!editing || engineChanged}
                />
              </label>

              <label className="field">
                <span>SSL mode</span>
                <select value={sslMode} onChange={event => setSslMode(event.target.value)}>
                  {SSL_MODES.map(mode => (
                    <option key={mode} value={mode}>
                      {mode}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}

          {error && (
            <div className="alert alert-danger" role="alert">
              <IconAlert size={17} />
              <span>{error}</span>
            </div>
          )}

          <footer className="modal-foot">
            <span className="hint">
              <IconPlug size={15} /> Credentials and MongoDB URIs are encrypted before storage.
            </span>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? 'Saving…' : editing ? 'Save changes' : 'Add connection'}
              </button>
            </div>
          </footer>
        </form>
      </div>
    </div>
  );
}
