import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, createUserApiKey, deleteUserApiKey, listUserApiKeysWithModels } from '../api/client';
import type { UserApiKey } from '../types';
import {
  IconAlert,
  IconCheck,
  IconClose,
  IconKey,
  IconLock,
  IconRefresh,
  IconTrash
} from '../components/icons';

const EMPTY_API_KEY = '';

export default function UserApiKeysPage() {
  const [keys, setKeys] = useState<UserApiKey[]>([]);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      setKeys(await listUserApiKeysWithModels());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load API key settings.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function handleKeyChange(modelId: string, value: string) {
    setForm(prev => ({ ...prev, [modelId]: value }));
  }

  async function saveKey(modelId: string) {
    const apiKey = form[modelId]?.trim();
    if (!apiKey) return;

    setSaving(modelId);
    setError('');
    setNotice('');
    try {
      await createUserApiKey(modelId, apiKey);
      setNotice('API key saved.');
      setForm(prev => ({ ...prev, [modelId]: '' }));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save API key.');
    } finally {
      setSaving(null);
    }
  }

  async function removeKey(model: UserApiKey) {
    if (!window.confirm(`Remove your API key for ${model.label}? The server default will be used instead.`)) return;
    setDeleting(model.modelId);
    setError('');
    try {
      await deleteUserApiKey(model.modelId);
      setNotice(`${model.label} API key removed.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove API key.');
    } finally {
      setDeleting(null);
    }
  }

  const modelsWithKeys = keys.filter(k => k.hasKey);
  const modelsWithoutKeys = keys.filter(k => !k.hasKey);

  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>My API Keys</h1>
          <p>
            Add your own API keys for any enabled model. Your keys are encrypted and never shown after saving.
            When you provide a key, it will be used instead of the server default for that model.
          </p>
        </div>
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
      {notice && <div className="alert alert-ok page-alert" role="status">{notice}</div>}

      <div className="admin-model-layout">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h2>Configured models</h2>
              <p>{keys.length} {keys.length === 1 ? 'model' : 'models'} available.</p>
            </div>
          </div>

          {loading ? (
            <p className="muted">Loading models…</p>
          ) : keys.length === 0 ? (
            <div className="admin-model-empty">
              <h3>No models available</h3>
              <p className="muted">An administrator must add and enable models first.</p>
            </div>
          ) : (
            <div className="admin-model-list">
              {modelsWithKeys.length > 0 && (
                <div>
                  <h3 style={{ marginBottom: '12px', fontSize: '14px', color: 'var(--muted)', textTransform: 'uppercase' }}>
                    Using your keys
                  </h3>
                  {modelsWithKeys.map(model => (
                    <article className="connection-card admin-model-card" key={model.modelId}>
                      <header className="connection-head">
                        <div className="connection-ident">
                          <div>
                            <h3>
                              <IconKey size={16} style={{ marginRight: '8px', verticalAlign: 'middle' }} />
                              {model.label}
                            </h3>
                            <p>{model.model_id}</p>
                          </div>
                        </div>
                        <span className="badge badge-ok">
                          <IconCheck size={12} /> Your key active
                        </span>
                      </header>
                      <p className="muted admin-model-url">{model.base_url}</p>
                      <footer className="connection-actions">
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => void removeKey(model)}
                          disabled={deleting === model.modelId}
                          aria-label={`Remove API key for ${model.label}`}
                        >
                          {deleting === model.modelId ? (
                            <span className="spinner spinner-sm" />
                          ) : (
                            <>
                              <IconTrash size={15} /> Remove key
                            </>
                          )}
                        </button>
                      </footer>
                    </article>
                  ))}
                </div>
              )}

              {modelsWithoutKeys.length > 0 && (
                <div>
                  <h3 style={{ marginBottom: '12px', fontSize: '14px', color: 'var(--muted)', textTransform: 'uppercase' }}>
                    Using server defaults
                  </h3>
                  {modelsWithoutKeys.map(model => (
                    <article className="connection-card admin-model-card" key={model.modelId}>
                      <header className="connection-head">
                        <div className="connection-ident">
                          <div>
                            <h3>
                              <IconLock size={16} style={{ marginRight: '8px', verticalAlign: 'middle' }} />
                              {model.label}
                            </h3>
                            <p>{model.model_id}</p>
                          </div>
                        </div>
                        <span className="badge">Server default</span>
                      </header>
                      <p className="muted admin-model-url">{model.base_url}</p>
                      <form className="form-stack" onSubmit={event => { event.preventDefault(); void saveKey(model.modelId); }}>
                        <label className="field">
                          <span>Your API key</span>
                          <input
                            type="password"
                            value={form[model.modelId] || ''}
                            onChange={event => handleKeyChange(model.modelId, event.target.value)}
                            placeholder="Paste your API key here"
                            autoComplete="new-password"
                            disabled={saving === model.modelId}
                          />
                        </label>
                        <footer className="modal-foot">
                          <div className="modal-actions">
                            <button
                              type="submit"
                              className="btn btn-primary"
                              disabled={saving === model.modelId || !form[model.modelId]?.trim()}
                            >
                              {saving === model.modelId ? (
                                <>
                                  <span className="spinner spinner-sm" /> Saving…
                                </>
                              ) : (
                                <>
                                  <IconKey size={17} /> Save key
                                </>
                              )}
                            </button>
                          </div>
                        </footer>
                      </form>
                    </article>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}