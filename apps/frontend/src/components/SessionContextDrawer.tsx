import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, getSchema, updateConversation } from '../api/client';
import type {
  ConversationDetail,
  ConversationSummary,
  SchemaSnapshot,
  TableRef
} from '../types';
import { tableKey, timeAgo } from '../format';
import TablePicker from './TablePicker';
import { RelationshipList } from './EvidencePanel';
import {
  IconAlert,
  IconClose,
  IconLink,
  IconRefresh,
  IconTable
} from './icons';

export type ContextTab = 'schema' | 'relationships';

type Props = {
  open: boolean;
  initialTab: ContextTab;
  conversation: ConversationDetail;
  onClose: () => void;
  onSaved: (conversation: ConversationSummary) => void;
};

export default function SessionContextDrawer({
  open,
  initialTab,
  conversation,
  onClose,
  onSaved
}: Props) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<ContextTab>(initialTab);
  const [schema, setSchema] = useState<SchemaSnapshot | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setSelected(conversation.selectedTables.map(tableKey));
    setSchema(null);
    setError('');
    setSaveError('');
  }, [open, initialTab, conversation.id, conversation.selectedTables]);

  useEffect(() => {
    if (open) return;
    setRefreshNonce(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = window.setTimeout(() => closeButton.current?.focus(), 0);
    return () => {
      window.clearTimeout(timer);
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError('');

    getSchema(conversation.connectionId, refreshNonce > 0)
      .then(snapshot => {
        if (!cancelled) setSchema(snapshot);
      })
      .catch(err => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Could not read the schema.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, conversation.connectionId, refreshNonce]);

  useEffect(() => {
    if (!open) return;
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
  }, [open, onClose]);

  const schemaKeys = useMemo(
    () => new Set(schema?.tables.map(table => `${table.schema}.${table.name}`) ?? []),
    [schema]
  );
  const missing = selected.filter(key => !schemaKeys.has(key));
  const selectedSet = new Set(selected);

  const relationships = useMemo(() => {
    if (!schema) return [];
    return schema.relationships.filter(
      relationship =>
        selectedSet.has(`${relationship.from.schema}.${relationship.from.table}`) &&
        selectedSet.has(`${relationship.to.schema}.${relationship.to.table}`)
    );
  }, [schema, selected]);

  async function save() {
    if (!schema) return;
    if (selected.length === 0) {
      setSaveError('Select at least one table.');
      return;
    }
    if (missing.length > 0) {
      setSaveError('Remove tables that no longer exist before saving.');
      return;
    }

    const tables: TableRef[] = schema.tables
      .filter(table => selectedSet.has(`${table.schema}.${table.name}`))
      .map(table => ({ schema: table.schema, table: table.name }));

    setSaving(true);
    setSaveError('');
    try {
      const updated = await updateConversation(conversation.id, { tables });
      onSaved(updated);
      onClose();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Could not save the table scope.');
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div
      className="drawer-backdrop"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="context-title"
        ref={drawerRef}
      >
        <header className="drawer-head">
          <div>
            <p className="eyebrow">Session context</p>
            <h2 id="context-title">{conversation.title}</h2>
            <p className="drawer-subtitle">
              {conversation.connection.name} · {conversation.connection.database}
            </p>
          </div>
          <button
            ref={closeButton}
            className="btn btn-ghost btn-icon"
            aria-label="Close session context"
            onClick={onClose}
          >
            <IconClose size={19} />
          </button>
        </header>

        <div className="drawer-tabs" role="tablist" aria-label="Session context">
          <button
            role="tab"
            id="context-tab-schema"
            aria-selected={tab === 'schema'}
            aria-controls="context-tab-panel"
            className={`drawer-tab${tab === 'schema' ? ' active' : ''}`}
            onClick={() => setTab('schema')}
          >
            <IconTable size={15} /> Tables
            <span>{selected.length}</span>
          </button>
          <button
            role="tab"
            id="context-tab-relationships"
            aria-selected={tab === 'relationships'}
            aria-controls="context-tab-panel"
            className={`drawer-tab${tab === 'relationships' ? ' active' : ''}`}
            onClick={() => setTab('relationships')}
          >
            <IconLink size={15} /> Relationships
            <span>{relationships.length}</span>
          </button>
        </div>

        <div
          className="drawer-body"
          id="context-tab-panel"
          role="tabpanel"
          aria-labelledby={tab === 'schema' ? 'context-tab-schema' : 'context-tab-relationships'}
        >
          {loading ? (
            <div className="schema-loading" aria-live="polite">
              <span className="spinner" aria-hidden="true" />
              <div>
                <strong>Reading schema…</strong>
                <p>Refreshing tables, columns, and foreign keys.</p>
              </div>
            </div>
          ) : error ? (
            <div className="alert alert-danger">
              <IconAlert size={17} />
              <span>{error}</span>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setRefreshNonce(value => value + 1)}
              >
                <IconRefresh size={15} /> Retry
              </button>
            </div>
          ) : tab === 'schema' && schema ? (
            <>
              <div className="drawer-toolbar">
                <span className="muted">Schema read {timeAgo(schema.introspectedAt)}</span>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setRefreshNonce(value => value + 1)}
                >
                  <IconRefresh size={15} /> Refresh schema
                </button>
              </div>

              {missing.length > 0 && (
                <div className="alert alert-warn">
                  <IconAlert size={16} />
                  <span>
                    {missing.length} selected {missing.length === 1 ? 'table is' : 'tables are'} no
                    longer in this database.
                  </span>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setSelected(selected.filter(key => schemaKeys.has(key)))}
                  >
                    Remove missing
                  </button>
                </div>
              )}

              {schema.tables.length === 0 ? (
                <p className="muted empty-note">No queryable tables were found.</p>
              ) : (
                <TablePicker
                  tables={schema.tables}
                  selected={selected}
                  onChange={next => {
                    setSelected(next);
                    setSaveError('');
                  }}
                  max={100}
                />
              )}
            </>
          ) : tab === 'relationships' && schema ? (
            <div className="drawer-relationships">
              <p className="muted">
                Direct foreign keys between the tables currently in scope. Changes are only saved
                when you save the table scope.
              </p>
              <RelationshipList relationships={relationships} />
            </div>
          ) : (
            <p className="muted">Select a connection to load its schema.</p>
          )}
        </div>

        {saveError && (
          <div className="drawer-save-error">
            <div className="alert alert-danger">
              <IconAlert size={16} />
              <span>{saveError}</span>
            </div>
          </div>
        )}

        <footer className="drawer-foot">
          <span className="hint">
            <IconLockHint />
            {tab === 'schema'
              ? 'Scope changes apply to future questions in this session.'
              : 'Relationships come from the saved table scope.'}
          </span>
          <div className="drawer-actions">
            <button className="btn btn-ghost" onClick={onClose}>
              {tab === 'schema' ? 'Cancel' : 'Close'}
            </button>
            {tab === 'schema' && (
              <button
                className="btn btn-primary"
                onClick={() => void save()}
                disabled={
                  saving || loading || !!error || !schema || selected.length === 0 || missing.length > 0
                }
              >
                {saving ? 'Saving…' : 'Save table scope'}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

function IconLockHint() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4" y="10" width="16" height="10" rx="2" stroke="currentColor" strokeWidth="1.7" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}
