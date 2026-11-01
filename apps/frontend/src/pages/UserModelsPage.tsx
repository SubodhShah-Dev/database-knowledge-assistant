import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, createUserModel, deleteUserModel, listAllUserModels, updateUserModel } from '../api/client';
import type { UserModel, UserModelInput } from '../types';
import {
  IconAlert,
  IconCheck,
  IconClose,
  IconEdit,
  IconPlus,
  IconRefresh,
  IconTrash
} from '../components/icons';

const EMPTY: UserModelInput = {
  label: '',
  modelId: '',
  baseUrl: '',
  apiKey: '',
  isEnabled: true,
  sortOrder: 0
};

export default function UserModelsPage() {
  const [models, setModels] = useState<UserModel[]>([]);
  const [form, setForm] = useState<UserModelInput>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      setModels(await listAllUserModels());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your providers.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!formOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [formOpen]);

  function edit(model: UserModel) {
    setEditingId(model.id);
    setFormOpen(true);
    setForm({
      label: model.label,
      modelId: model.model_id,
      baseUrl: model.base_url,
      apiKey: '',
      isEnabled: model.is_enabled,
      sortOrder: model.sort_order
    });
    setError('');
    setNotice('');
  }

  function reset() {
    setEditingId(null);
    setFormOpen(false);
    setForm(EMPTY);
    setError('');
  }

  function add() {
    setEditingId(null);
    setForm(EMPTY);
    setError('');
    setNotice('');
    setFormOpen(true);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    try {
      if (editingId) {
        await updateUserModel(editingId, form);
        setNotice('Provider updated.');
      } else {
        await createUserModel(form);
        setNotice('Provider added.');
      }
      reset();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save this provider.');
    } finally {
      setSaving(false);
    }
  }

  async function remove(model: UserModel) {
    if (!window.confirm(`Remove ${model.label}?`)) return;
    setDeleting(model.id);
    setError('');
    try {
      await deleteUserModel(model.id);
      setNotice(`${model.label} removed.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove this provider.');
    } finally {
      setDeleting(null);
    }
  }

  const enabledModels = models.filter(m => m.is_enabled);
  const disabledModels = models.filter(m => !m.is_enabled);

  return (
    <section className="page">
      <div className="page-heading with-actions">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>My LLM Providers</h1>
          <p>
            Add your own OpenAI-compatible LLM providers. These appear in the model picker alongside server providers.
            Your providers are tried first when using Auto mode.
          </p>
        </div>
        <button className="btn btn-primary" onClick={add}>
          <IconPlus size={16} /> Add provider
        </button>
      </div>

      {error && !formOpen && (
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
              <h2>Your providers</h2>
              <p>{models.length} {models.length === 1 ? 'provider' : 'providers'} configured.</p>
            </div>
          </div>

          {loading ? (
            <p className="muted">Loading providers…</p>
          ) : models.length === 0 ? (
            <div className="admin-model-empty">
              <h3>No providers yet</h3>
              <p className="muted">Add an OpenAI-compatible endpoint to use your own models.</p>
              <button className="btn btn-primary" onClick={add}>
                <IconPlus size={16} /> Add provider
              </button>
            </div>
          ) : (
            <div className="admin-model-list">
              {enabledModels.length > 0 && (
                <div>
                  <h3 style={{ marginBottom: '12px', fontSize: '14px', color: 'var(--muted)', textTransform: 'uppercase' }}>
                    Enabled
                  </h3>
                  {enabledModels.map(model => (
                    <article className="connection-card admin-model-card" key={model.id}>
                      <header className="connection-head">
                        <div className="connection-ident">
                          <div>
                            <h3>
                              <span className="badge badge-link" style={{ marginRight: '8px', verticalAlign: 'middle' }}>
                                <IconPlus size={12} /> Your provider
                              </span>
                              {model.label}
                            </h3>
                            <p>{model.model_id}</p>
                          </div>
                        </div>
                        <span className="badge badge-ok">
                          <IconCheck size={12} /> Enabled
                        </span>
                      </header>
                      <p className="muted admin-model-url">{model.base_url}</p>
                      <p className="muted admin-model-meta">
                        <span>Priority {model.sort_order}</span>
                      </p>
                      <footer className="connection-actions">
                        <button className="btn btn-ghost btn-sm" onClick={() => edit(model)}>
                          <IconEdit size={15} /> Edit
                        </button>
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => void remove(model)}
                          disabled={deleting === model.id}
                          aria-label={`Remove ${model.label}`}
                        >
                          {deleting === model.id ? (
                            <span className="spinner spinner-sm" />
                          ) : (
                            <>
                              <IconTrash size={15} /> Remove
                            </>
                          )}
                        </button>
                      </footer>
                    </article>
                  ))}
                </div>
              )}

              {disabledModels.length > 0 && (
                <div>
                  <h3 style={{ marginBottom: '12px', fontSize: '14px', color: 'var(--muted)', textTransform: 'uppercase' }}>
                    Disabled
                  </h3>
                  {disabledModels.map(model => (
                    <article className="connection-card admin-model-card" key={model.id} style={{ opacity: 0.6 }}>
                      <header className="connection-head">
                        <div className="connection-ident">
                          <div>
                            <h3>
                              <span className="badge badge-link" style={{ marginRight: '8px', verticalAlign: 'middle' }}>
                                <IconPlus size={12} /> Your provider
                              </span>
                              {model.label}
                            </h3>
                            <p>{model.model_id}</p>
                          </div>
                        </div>
                        <span className="badge">Disabled</span>
                      </header>
                      <p className="muted admin-model-url">{model.base_url}</p>
                      <footer className="connection-actions">
                        <button className="btn btn-ghost btn-sm" onClick={() => edit(model)}>
                          <IconEdit size={15} /> Edit
                        </button>
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => void remove(model)}
                          disabled={deleting === model.id}
                          aria-label={`Remove ${model.label}`}
                        >
                          {deleting === model.id ? (
                            <span className="spinner spinner-sm" />
                          ) : (
                            <>
                              <IconTrash size={15} /> Remove
                            </>
                          )}
                        </button>
                      </footer>
                    </article>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {formOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={event => {
            if (event.target === event.currentTarget && !saving) reset();
          }}
        >
          <section
            className="modal admin-model-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="user-model-form-title"
          >
            <header className="modal-head">
              <div>
                <p className="eyebrow">{editingId ? 'Edit provider' : 'New provider'}</p>
                <h2 id="user-model-form-title">{editingId ? 'Edit provider' : 'Add OpenAI-compatible provider'}</h2>
                <p className="muted">
                  API keys are encrypted before storage and never shown after saving.
                </p>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-icon modal-close"
                aria-label="Close provider form"
                onClick={reset}
                disabled={saving}
              >
                <IconClose size={18} />
              </button>
            </header>
            <form className="form-stack" onSubmit={submit}>
              <div className="admin-model-form-content">
                {error && (
                  <div className="alert alert-danger" role="alert">
                    <IconAlert size={17} />
                    <span>{error}</span>
                  </div>
                )}
                <label className="field">
                  <span>Display name</span>
                  <input
                    autoFocus
                    value={form.label}
                    onChange={event => setForm({ ...form, label: event.target.value })}
                    placeholder="My Groq Llama"
                    required
                    maxLength={100}
                    disabled={saving}
                  />
                </label>
                <label className="field">
                  <span>OpenAI-compatible base URL</span>
                  <input
                    type="url"
                    value={form.baseUrl}
                    onChange={event => setForm({ ...form, baseUrl: event.target.value })}
                    placeholder="https://api.example.com/v1"
                    required
                    disabled={saving}
                  />
                  <small className="field-hint">
                    The API appends /chat/completions. HTTPS is required except for localhost.
                  </small>
                </label>
                <label className="field">
                  <span>Model identifier</span>
                  <input
                    value={form.modelId}
                    onChange={event => setForm({ ...form, modelId: event.target.value })}
                    placeholder="provider/model-name"
                    required
                    maxLength={200}
                    disabled={saving}
                  />
                </label>
                <label className="field">
                  <span>
                    {editingId
                      ? 'Replace API key (leave blank to keep the current key)'
                      : 'API key'}
                  </span>
                  <input
                    type="password"
                    value={form.apiKey ?? ''}
                    onChange={event => setForm({ ...form, apiKey: event.target.value })}
                    autoComplete="new-password"
                    placeholder={editingId ? 'Saved key is hidden' : 'Paste your API key here'}
                    required={!editingId}
                    disabled={saving}
                  />
                </label>
                <div className="form-grid">
                  <label className="field">
                    <span>Priority (lower first)</span>
                    <input
                      type="number"
                      min={0}
                      max={10000}
                      value={form.sortOrder}
                      onChange={event =>
                        setForm({ ...form, sortOrder: Number(event.target.value) })
                      }
                      required
                      disabled={saving}
                    />
                  </label>
                  <label className="field field-checkbox">
                    <input
                      type="checkbox"
                      checked={form.isEnabled}
                      onChange={event => setForm({ ...form, isEnabled: event.target.checked })}
                      disabled={saving}
                    />
                    <span>Enabled</span>
                  </label>
                </div>
              </div>
              <footer className="modal-foot">
                <div className="modal-actions">
                  <button type="button" className="btn btn-ghost" onClick={reset} disabled={saving}>
                    Cancel
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={saving}>
                    {saving ? (
                      'Saving…'
                    ) : editingId ? (
                      <>
                        <IconCheck size={17} /> Save changes
                      </>
                    ) : (
                      <>
                        <IconPlus size={17} /> Add provider
                      </>
                    )}
                  </button>
                </div>
              </footer>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}