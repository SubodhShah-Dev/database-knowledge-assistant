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
  const [name, setName] = useState(connection?.name ?? '');
  const [host, setHost] = useState(connection?.host ?? '127.0.0.1');
  const [port, setPort] = useState(String(connection?.port ?? 5432));
  const [database, setDatabase] = useState(connection?.database_name ?? '');
  const [username, setUsername] = useState(connection?.username ?? '');
  const [password, setPassword] = useState('');
  const [sslMode, setSslMode] = useState(connection?.ssl_mode ?? 'prefer');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    firstField.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    if (!editing && !password) {
      setError('Password is required for a new connection.');
      return;
    }

    setBusy(true);
    try {
      await onSave({
        name: name.trim(),
        host: host.trim(),
        port: Number(port),
        database: database.trim(),
        username: username.trim(),
        password,
        sslMode
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
            <h2 id="connection-title">{editing ? connection?.name : 'Connect PostgreSQL'}</h2>
          </div>
          <button className="btn btn-ghost btn-icon" aria-label="Close" onClick={onClose}>
            <IconClose size={19} />
          </button>
        </header>

        <form className="form-stack" onSubmit={submit}>
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
                placeholder="demo_analytics"
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
            <span>{editing ? 'Password (leave blank to keep current)' : 'Password'}</span>
            <input
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
              autoComplete={editing ? 'new-password' : 'current-password'}
              placeholder={editing ? 'Unchanged' : 'Database password'}
              required={!editing}
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

          {error && (
            <div className="alert alert-danger" role="alert">
              <IconAlert size={17} />
              <span>{error}</span>
            </div>
          )}

          <footer className="modal-foot">
            <span className="hint">
              <IconPlug size={15} /> Credentials are encrypted before storage.
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
