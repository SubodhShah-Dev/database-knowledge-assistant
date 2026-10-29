import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  ApiError,
  createConversation,
  getSchema,
  listConnections,
  listModels
} from '../api/client';
import type { Connection, Model, SchemaSnapshot, TableRef } from '../types';
import TablePicker from '../components/TablePicker';
import {
  IconAlert,
  IconArrowRight,
  IconDatabase,
  IconLink,
  IconLock,
  IconPlus,
  IconRefresh,
  IconSpark
} from '../components/icons';

const MAX_SELECTED = 100;

export default function NewSessionPage() {
  const navigate = useNavigate();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [connectionId, setConnectionId] = useState('');
  const [modelId, setModelId] = useState('');
  const [schema, setSchema] = useState<SchemaSnapshot | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [loadingConnections, setLoadingConnections] = useState(true);
  const [bootstrapNonce, setBootstrapNonce] = useState(0);
  const [schemaNonce, setSchemaNonce] = useState(0);
  const [loadingSchema, setLoadingSchema] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const connection = connections.find(item => item.id === connectionId) ?? null;

  useEffect(() => {
    let cancelled = false;
    setError('');
    Promise.all([listConnections(), listModels()])
      .then(([nextConnections, nextModels]) => {
        if (cancelled) return;
        setConnections(nextConnections);
        setModels(nextModels);
        if (nextConnections.length > 0) setConnectionId(nextConnections[0].id);
        setModelId('');
      })
      .catch(err => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Could not load connections.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingConnections(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bootstrapNonce]);

  useEffect(() => {
    if (!connectionId) {
      setSchema(null);
      setSelected([]);
      return;
    }

    let cancelled = false;
    setLoadingSchema(true);
    setSchema(null);
    setSelected([]);
    setError('');

    getSchema(connectionId)
      .then(snapshot => {
        if (cancelled) return;
        setSchema(snapshot);
        if (snapshot.tables.length <= MAX_SELECTED) {
          setSelected(snapshot.tables.map(table => `${table.schema}.${table.name}`));
        }
      })
      .catch(err => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Could not read this schema.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingSchema(false);
      });

    return () => {
      cancelled = true;
    };
  }, [connectionId, schemaNonce]);

  const selectedTables = useMemo<TableRef[]>(() => {
    if (!schema) return [];
    const keys = new Set(selected);
    return schema.tables
      .filter(table => keys.has(`${table.schema}.${table.name}`))
      .map(table => ({ schema: table.schema, table: table.name }));
  }, [schema, selected]);

  const relationships = useMemo(() => {
    if (!schema) return [];
    const keys = new Set(selected);
    return schema.relationships.filter(
      relationship =>
        keys.has(`${relationship.from.schema}.${relationship.from.table}`) &&
        keys.has(`${relationship.to.schema}.${relationship.to.table}`)
    );
  }, [schema, selected]);

  async function startSession() {
    if (!connectionId || selectedTables.length === 0) return;
    setCreating(true);
    setError('');
    try {
      const conversation = await createConversation({
        connectionId,
        tables: selectedTables,
        modelId: modelId || undefined
      });
      navigate(`/c/${conversation.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the session.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="page setup-page">
      <div className="page-heading with-actions">
        <div>
          <p className="eyebrow">Start a session</p>
          <h1>New session</h1>
          <p>
            A session is locked to one database connection. Pick the tables or collections the
            assistant may use; everything else stays out of scope.
          </p>
        </div>
        <Link className="btn btn-ghost" to="/connections">
          <IconDatabase size={17} /> Manage connections
        </Link>
      </div>

      {error && (
        <div className="alert alert-danger page-alert" role="alert">
          <IconAlert size={17} />
          <span>{error}</span>
          {connectionId && (
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                if (connectionId) setSchemaNonce(value => value + 1);
                else setBootstrapNonce(value => value + 1);
              }}
            >
              <IconRefresh size={15} /> Retry
            </button>
          )}
        </div>
      )}

      {loadingConnections ? (
        <div className="setup-layout">
          <div className="setup-main">
            <div className="panel skeleton-panel">
              <span className="skeleton skeleton-line wide" />
              <span className="skeleton skeleton-line" />
              <span className="skeleton skeleton-line short" />
            </div>
          </div>
        </div>
      ) : connections.length === 0 ? (
        <div className="empty-state">
          <span className="placeholder-icon">
            <IconDatabase size={24} />
          </span>
          <h2>Add a database first</h2>
          <p>You need one saved database connection before you can start a session.</p>
          <Link className="btn btn-primary" to="/connections">
            <IconPlus size={17} /> Add connection
          </Link>
        </div>
      ) : (
        <div className="setup-layout">
          <div className="setup-main">
            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>1. Connection</h2>
                  <p>This choice is permanent for the session.</p>
                </div>
                <span className="badge badge-lock">
                  <IconLock size={12} /> Locked after start
                </span>
              </div>

              <label className="field">
                <span>Database connection</span>
                <select value={connectionId} onChange={event => setConnectionId(event.target.value)}>
                  {connections.map(item => (
                    <option key={item.id} value={item.id}>
                      {item.name} — {item.database_name}
                    </option>
                  ))}
                </select>
              </label>

              {connection && (
                <dl className="connection-meta compact">
                  <div>
                    <dt>Host</dt>
                    <dd>
                      {connection.host}:{connection.port}
                    </dd>
                  </div>
                  <div>
                    <dt>Database</dt>
                    <dd>{connection.database_name}</dd>
                  </div>
                  <div>
                    <dt>Role</dt>
                    <dd>{connection.username}</dd>
                  </div>
                </dl>
              )}
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>2. Data scope</h2>
                  <p>Only these tables or collections can be queried.</p>
                </div>
              </div>

              {loadingSchema ? (
                <div className="schema-loading" aria-live="polite">
                  <span className="spinner" aria-hidden="true" />
                  <div>
                    <strong>Reading schema…</strong>
                    <p>Loading tables, columns, and direct foreign keys.</p>
                  </div>
                </div>
              ) : schema ? (
                <>
                  {schema.tables.length > MAX_SELECTED && (
                    <div className="alert alert-warn">
                      <IconAlert size={16} />
                      <span>
                        This database has {schema.tables.length} tables. Select at most{' '}
                        {MAX_SELECTED} explicitly.
                      </span>
                    </div>
                  )}
                  <TablePicker
                    tables={schema.tables}
                    selected={selected}
                    onChange={setSelected}
                    max={MAX_SELECTED}
                  />
                </>
              ) : (
                <p className="muted">Select a connection to load its schema.</p>
              )}
            </section>

            <section className="panel">
              <div className="panel-head">
                <div>
                  <h2>3. Model</h2>
                  <p>You can change the model later without changing the table scope.</p>
                </div>
              </div>
              {models.length > 0 ? (
                <label className="field">
                  <span>Answer model</span>
                  <select value={modelId} onChange={event => setModelId(event.target.value)}>
                    <option value="">Auto (recommended)</option>
                    {models.map(model => (
                      <option key={model.id} value={model.id}>
                        {model.label}
                        {model.is_default ? ' (default)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <p className="muted">Auto will use the server-configured model.</p>
              )}
            </section>
          </div>

          <aside className="setup-aside">
            <div className="summary-card">
              <div className="summary-icon">
                <IconSpark size={20} />
              </div>
              <h2>Session summary</h2>
              <p className="muted">
                {connection ? connection.name : 'No connection selected'}
                {connection ? ` · ${connection.database_name}` : ''}
              </p>

              <dl className="summary-stats">
                <div>
                  <dt>Tables</dt>
                  <dd>{selectedTables.length}</dd>
                </div>
                <div>
                  <dt>Relationships</dt>
                  <dd>{relationships.length}</dd>
                </div>
              </dl>

              {relationships.length > 0 && (
                <div className="relationship-preview">
                  <h3>
                    <IconLink size={14} /> Direct relationships
                  </h3>
                  {relationships.slice(0, 5).map(relationship => (
                    <p key={relationship.name}>
                      {relationship.from.table}.{relationship.from.columns.join(', ')}
                      <span> → </span>
                      {relationship.to.table}.{relationship.to.columns.join(', ')}
                    </p>
                  ))}
                  {relationships.length > 5 && (
                    <p className="muted">+{relationships.length - 5} more</p>
                  )}
                </div>
              )}

              <button
                className="btn btn-primary btn-block"
                onClick={() => void startSession()}
                disabled={
                  creating ||
                  loadingSchema ||
                  !schema ||
                  selectedTables.length === 0
                }
              >
                {creating ? 'Starting…' : 'Start session'}
                {!creating && <IconArrowRight size={17} />}
              </button>
              {selectedTables.length === 0 && (
                <p className="summary-note">Select at least one table to continue.</p>
              )}
            </div>
          </aside>
        </div>
      )}
    </section>
  );
}
