import { useEffect, useState } from 'react';
import {
  ApiError,
  createConnection,
  deleteConnection,
  listConnections,
  testConnection,
  updateConnection
} from '../api/client';
import type { Connection, ConnectionInput, ConnectionTest } from '../types';
import ConnectionForm from '../components/ConnectionForm';
import {
  IconAlert,
  IconDatabase,
  IconEdit,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconTrash
} from '../components/icons';

type TestState = { loading?: boolean; result?: ConnectionTest };

export default function ConnectionsPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Connection | null>(null);
  const [adding, setAdding] = useState(false);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [deleting, setDeleting] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError('');
    try {
      setConnections(await listConnections());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load connections.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save(input: ConnectionInput) {
    if (editing) {
      const { password, ...rest } = input;
      await updateConnection(editing.id, password ? input : rest);
    } else {
      await createConnection(input);
    }
    setAdding(false);
    setEditing(null);
    await load();
  }

  async function runTest(connection: Connection) {
    setTests(current => ({ ...current, [connection.id]: { loading: true } }));
    try {
      const result = await testConnection(connection.id);
      setTests(current => ({ ...current, [connection.id]: { result } }));
    } catch (err) {
      setTests(current => ({
        ...current,
        [connection.id]: {
          result: {
            ok: false,
            error: err instanceof ApiError ? err.message : 'Connection test failed.'
          }
        }
      }));
    }
  }

  async function remove(connection: Connection) {
    if (!window.confirm(`Delete "${connection.name}"?`)) return;
    setDeleting(connection.id);
    try {
      await deleteConnection(connection.id);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        if (
          window.confirm(
            'This connection has saved sessions. Delete the connection and all of its sessions?'
          )
        ) {
          await deleteConnection(connection.id, true);
          await load();
        }
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not delete the connection.');
      }
    } finally {
      setDeleting(null);
    }
  }

  return (
    <section className="page">
      <div className="page-heading with-actions">
        <div>
          <p className="eyebrow">Database connections</p>
          <h1>Connections</h1>
          <p>
            Save encrypted database connections from anywhere the API can reach. Credentials are
            never returned to the browser. Queries are scope-checked and use engine-specific
            read-only safeguards; use read-only database accounts for network databases.
            Link-local and cloud metadata hosts are blocked.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>
          <IconPlus size={17} /> Add connection
        </button>
      </div>

      {error && (
        <div className="alert alert-danger page-alert" role="alert">
          <IconAlert size={17} />
          <span>{error}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => void load()}>
            <IconRefresh size={15} /> Retry
          </button>
        </div>
      )}

      {loading ? (
        <div className="connection-grid" aria-label="Loading connections">
          {[0, 1].map(index => (
            <div className="connection-card skeleton-card" key={index}>
              <span className="skeleton skeleton-line wide" />
              <span className="skeleton skeleton-line" />
              <span className="skeleton skeleton-line short" />
            </div>
          ))}
        </div>
      ) : connections.length === 0 ? (
        <div className="empty-state">
          <span className="placeholder-icon">
            <IconDatabase size={24} />
          </span>
          <h2>No connections yet</h2>
          <p>Add a supported database to start asking questions about its schema and data.</p>
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            <IconPlus size={17} /> Add your first connection
          </button>
        </div>
      ) : (
        <div className="connection-grid">
          {connections.map(connection => {
            const test = tests[connection.id];
            return (
              <article className="connection-card" key={connection.id}>
                <header className="connection-head">
                  <div className="connection-ident">
                    <span className="connection-icon">
                      <IconDatabase size={19} />
                    </span>
                    <div>
                      <h2>{connection.name}</h2>
                      <p>
                      {connection.engine === 'mongodb'
                        ? connection.host
                          ? `${connection.host}:${connection.port} / ${connection.database_name}`
                          : connection.database_name
                        : `${connection.host}:${connection.port} / ${connection.database_name}`}
                      </p>
                    </div>
                  </div>
                  <span className="badge">{connection.engine}</span>
                </header>

                <dl className="connection-meta">
                  <div>
                    <dt>User</dt>
                    <dd>{connection.username}</dd>
                  </div>
                  <div>
                    <dt>{connection.engine === 'mongodb' ? 'Connection URI' : 'Password'}</dt>
                    <dd>
                      {connection.engine === 'mongodb'
                        ? 'Stored securely'
                        : connection.has_password
                          ? 'Saved'
                          : 'Not saved'}
                    </dd>
                  </div>
                </dl>

                {test?.loading && <p className="inline-status">Testing connection…</p>}
                {test?.result?.ok && (
                  <div className="alert alert-ok">
                    <span className="status-dot" />
                    <span>
                      Connected.
                      {test.result.warning ? ` ${test.result.warning}` : ''}
                    </span>
                  </div>
                )}
                {test?.result && !test.result.ok && (
                  <div className="alert alert-danger">
                    <IconAlert size={16} />
                    <span>{test.result.error}</span>
                  </div>
                )}

                <footer className="connection-actions">
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => void runTest(connection)}
                    disabled={test?.loading}
                  >
                    <IconPlay size={15} /> Test
                  </button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditing(connection)}>
                    <IconEdit size={15} /> Edit
                  </button>
                  <button
                    className="btn btn-danger btn-sm"
                    onClick={() => void remove(connection)}
                    disabled={deleting === connection.id}
                  >
                    <IconTrash size={15} /> Delete
                  </button>
                </footer>
              </article>
            );
          })}
        </div>
      )}

      {(adding || editing) && (
        <ConnectionForm
          connection={editing}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
          onSave={save}
        />
      )}
    </section>
  );
}
