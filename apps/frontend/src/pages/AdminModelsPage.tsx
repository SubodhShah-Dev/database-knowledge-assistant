import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, createAdminModel, deleteAdminModel, listAdminModels, updateAdminModel } from '../api/client';
import type { AdminModel, AdminModelInput } from '../types';
import {
  IconAlert,
  IconCheck,
  IconClose,
  IconEdit,
  IconPlus,
  IconRefresh,
  IconTrash
} from '../components/icons';

const EMPTY: AdminModelInput = {
  label: '',
  modelId: '',
  baseUrl: '',
  apiKey: '',
  isDefault: false,
  sortOrder: 0
};

export default function AdminModelsPage() {
  const [models, setModels] = useState<AdminModel[]>([]);
  const [form, setForm] = useState<AdminModelInput>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const sortedModels = [...models].sort(
    (left, right) =>
      Number(right.is_default) - Number(left.is_default) ||
      left.sort_order - right.sort_order ||
      left.label.localeCompare(right.label)
  );

  async function load() {
    setLoading(true);
    setError('');
    try {
      setModels(await listAdminModels());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load model configurations.');
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

  function edit(model: AdminModel) {
    setEditingId(model.id);
    setFormOpen(true);
    setForm({
      label: model.label,
      modelId: model.model_id,
      baseUrl: model.base_url,
      apiKey: '',
      isDefault: model.is_default,
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
        await updateAdminModel(editingId, form);
        setNotice('Model configuration updated.');
      } else {
        await createAdminModel(form);
        setNotice('Provider/model added.');
      }
      reset();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save this model configuration.');
    } finally {
      setSaving(false);
    }
  }

  async function remove(model: AdminModel) {
    if (!window.confirm(`Remove ${model.label}?`)) return;
    setError('');
    try {
      await deleteAdminModel(model.id);
      setNotice(`${model.label} removed.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove this model configuration.');
    }
  }

  return (
    <section className="page">
      <div className="page-heading with-actions">
        <div>
          <p className="eyebrow">Administrator</p>
          <h1>AI providers and models</h1>
          <p>
            Manage the models available in chat. Auto tries the preferred model first and falls
            back to the remaining priority order when a provider is temporarily unavailable.
          </p>
        </div>
        <button className="btn btn-primary" onClick={add}>
          <IconPlus size={16} /> Add model
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
              <h2>Configured models</h2>
              <p>
                {models.length} {models.length === 1 ? 'model' : 'models'} available to chat
                sessions.
              </p>
            </div>
          </div>
          {loading ? (
            <p className="muted">Loading provider settings…</p>
          ) : models.length === 0 ? (
            <div className="admin-model-empty">
              <h3>No models configured</h3>
              <p className="muted">Add a provider and model to make it available in chat.</p>
              <button className="btn btn-primary" onClick={add}>
                <IconPlus size={16} /> Add model
              </button>
            </div>
          ) : (
            <div className="admin-model-list">
              {sortedModels.map(model => (
                <article className="connection-card admin-model-card" key={model.id}>
                  <header className="connection-head">
                    <div className="connection-ident">
                      <div>
                        <h3>{model.label}</h3>
                        <p>{model.model_id}</p>
                      </div>
                    </div>
                    {model.is_default && <span className="badge">Preferred</span>}
                  </header>
                  <p className="muted admin-model-url">{model.base_url}</p>
                  <p className="muted admin-model-meta">
                    <span>Priority {model.sort_order}</span>
                    <span>
                      API key{' '}
                      {model.api_key_source === 'stored'
                        ? 'saved'
                        : model.api_key_source === 'environment'
                          ? 'using server environment'
                          : 'not configured'}
                    </span>
                  </p>
                  <footer className="connection-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => edit(model)}>
                      <IconEdit size={15} /> Edit
                    </button>
                    <button
                      className="btn btn-danger btn-sm"
                      onClick={() => void remove(model)}
                      aria-label={`Remove ${model.label}`}
                    >
                      <IconTrash size={15} /> Remove
                    </button>
                  </footer>
                </article>
              ))}
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
            aria-labelledby="model-form-title"
          >
            <header className="modal-head">
              <div>
                <p className="eyebrow">{editingId ? 'Edit configuration' : 'New configuration'}</p>
                <h2 id="model-form-title">{editingId ? 'Edit model' : 'Add provider/model'}</h2>
                <p className="muted">
                  API keys are encrypted before storage and never shown after saving.
                </p>
              </div>
              <button
                type="button"
                className="btn btn-ghost btn-icon modal-close"
                aria-label="Close model form"
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
                    placeholder="Groq · Llama 3.3"
                    required
                    maxLength={100}
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
                  />
                </label>
                <label className="field">
                  <span>
                    {editingId
                      ? 'Replace API key (leave blank to keep the current key)'
                      : 'API key (optional when using the server key or a local endpoint)'}
                  </span>
                  <input
                    type="password"
                    value={form.apiKey ?? ''}
                    onChange={event => setForm({ ...form, apiKey: event.target.value })}
                    autoComplete="new-password"
                    placeholder={editingId ? 'Saved key is hidden' : 'Paste the provider key here'}
                  />
                  {editingId && models.find(model => model.id === editingId)?.has_api_key && (
                    <small className="field-hint">
                      A key is configured; its value is never displayed.
                    </small>
                  )}
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
                    />
                  </label>
                  <label className="field field-checkbox">
                    <input
                      type="checkbox"
                      checked={form.isDefault}
                      onChange={event => setForm({ ...form, isDefault: event.target.checked })}
                    />
                    <span>Preferred model (Auto tries this first)</span>
                  </label>
                </div>
              </div>
              <footer className="modal-foot">
                <span className="hint">
                  The server environment key is used when this endpoint matches its configured URL.
                </span>
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
                        <IconPlus size={17} /> Add model
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
