import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ApiError,
  getConversation,
  listModels,
  streamQuestion,
  updateConversation
} from '../api/client';
import type {
  AnswerMode,
  ConversationDetail,
  ConversationSummary,
  Evidence,
  Model,
  StreamStatus,
  Turn,
  UsedAnswerMode
} from '../types';
import EvidencePanel, { FailedQuery } from '../components/EvidencePanel';
import MarkdownText from '../components/MarkdownText';
import SessionContextDrawer, { type ContextTab } from '../components/SessionContextDrawer';
import { CONVERSATION_UPDATED_EVENT } from '../hooks/useSessions';
import {
  IconAlert,
  IconCheck,
  IconClose,
  IconCopy,
  IconEdit,
  IconLink,
  IconLock,
  IconPlus,
  IconRefresh,
  IconSend,
  IconSpark,
  IconStop,
  IconTable
} from '../components/icons';
import { shortModelName } from '../format';

type ChatTurn = Turn & {
  local?: boolean;
  stopped?: boolean;
  error?: string;
  failedQuery?: string;
};

type LiveTurn = {
  question: string;
  answer: string;
  evidence: Evidence | null;
  status: StreamStatus | null;
  error: string;
  stopped: boolean;
  failedQuery?: string;
};

function evidenceFromTurn(value: Turn['evidence']): Evidence | null {
  if (!value || Array.isArray(value)) return null;
  return value;
}

function truncateTitle(question: string): string {
  return question.length > 80 ? `${question.slice(0, 77)}...` : question;
}

function usedModeLabel(mode: UsedAnswerMode): string {
  if (mode === 'clarify') return 'Clarification';
  return mode === 'data' ? 'Data' : 'Schema';
}

function modeIcon(mode: AnswerMode | UsedAnswerMode, size = 14) {
  if (mode === 'data') return <IconTable size={size} />;
  if (mode === 'schema') return <IconLink size={size} />;
  if (mode === 'clarify') return <IconAlert size={size} />;
  return <IconSpark size={size} />;
}

async function copyPromptToClipboard(prompt: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(prompt);
    return;
  } catch {
    const area = document.createElement('textarea');
    area.value = prompt;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    let copied = false;
    try {
      area.select();
      copied = document.execCommand('copy');
    } finally {
      area.remove();
    }
    if (copied) return;
    throw new Error('Clipboard access is unavailable.');
  }
}

function isAbort(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'AbortError';
}

export default function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const threadRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const stickToBottom = useRef(true);

  const [conversation, setConversation] = useState<ConversationDetail | null>(null);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [modelId, setModelId] = useState('');
  const [modelSaving, setModelSaving] = useState(false);
  const [modelError, setModelError] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [titleSaving, setTitleSaving] = useState(false);
  const [titleError, setTitleError] = useState('');
  const [answerMode, setAnswerMode] = useState<AnswerMode>('auto');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [reloadNonce, setReloadNonce] = useState(0);
  const [draft, setDraft] = useState('');
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [drawer, setDrawer] = useState<ContextTab | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    setModelError('');
    setEditingTitle(false);
    setTitleError('');
    setLive(null);
    setStreaming(false);
    setAnswerMode('auto');
    setDraft('');
    setDrawer(null);

    Promise.all([getConversation(id), listModels().catch(() => [])])
      .then(([detail, nextModels]) => {
        if (cancelled) return;
        setConversation(detail);
        setTurns(detail.turns);
        setModels(nextModels);
        setModelId(detail.modelId ?? '');
        stickToBottom.current = true;
      })
      .catch(err => {
        if (!cancelled) {
          setLoadError(
            err instanceof ApiError && err.status === 404
              ? 'Session not found.'
              : err instanceof ApiError
                ? err.message
                : 'Could not load this session.'
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id, reloadNonce]);

  useEffect(() => {
    function onConversationUpdated(event: Event) {
      const updated = (event as CustomEvent<ConversationSummary>).detail;
      setConversation(current =>
        current?.id === updated.id
          ? { ...current, ...updated, connection: updated.connection ?? current.connection }
          : current
      );
    }

    window.addEventListener(CONVERSATION_UPDATED_EVENT, onConversationUpdated);
    return () => window.removeEventListener(CONVERSATION_UPDATED_EVENT, onConversationUpdated);
  }, []);

  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [id]);

  useEffect(() => {
    const element = threadRef.current;
    if (element && stickToBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [turns, live]);

  function archiveLive() {
    if (!live) return;
    setTurns(current => [
      ...current,
      {
        id: `local-${Date.now()}`,
        question: live.question,
        answer: live.answer,
        evidence: live.evidence ?? [],
        model: null,
        createdAt: new Date().toISOString(),
        local: true,
        stopped: live.stopped,
        error: live.error || undefined,
        failedQuery: live.failedQuery
      }
    ]);
    setLive(null);
  }

  async function ask(question: string, retry = false) {
    const text = question.trim();
    if (!text || !conversation || controllerRef.current) return;

    if (live) {
      if (retry) setLive(null);
      else archiveLive();
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    setDraft('');
    setStreaming(true);
    stickToBottom.current = true;

    let answer = '';
    let evidence: Evidence | null = null;
    let terminal = false;

    setLive({
      question: text,
      answer,
      evidence,
      status: { phase: 'planning', label: 'Understanding the question' },
      error: '',
      stopped: false
    });

    try {
      await streamQuestion(
        { question: text, conversationId: conversation.id, mode: answerMode },
        {
          onStatus: status => {
            if (controllerRef.current !== controller) return;
            setLive(current => (current ? { ...current, status } : current));
          },
          onEvidence: nextEvidence => {
            if (controllerRef.current !== controller) return;
            evidence = nextEvidence;
            setLive(current =>
              current
                ? {
                    ...current,
                    evidence: nextEvidence,
                    status: {
                      phase: 'answering',
                      label:
                        nextEvidence.kind === 'schema'
                          ? 'Preparing the schema answer'
                          : 'Preparing the answer'
                    }
                  }
                : current
            );
          },
          onToken: token => {
            if (controllerRef.current !== controller) return;
            answer += token;
            setLive(current =>
              current
                ? {
                    ...current,
                    answer,
                    status: {
                      phase: 'answering',
                      label: 'Writing the answer'
                    }
                  }
                : current
            );
          },
          onDone: payload => {
            if (controllerRef.current !== controller) return;
            terminal = true;
            setTurns(current => [
              ...current,
              {
                id: payload.messageId,
                question: text,
                answer: payload.answer,
                evidence: evidence ?? [],
                model: payload.model,
                mode: payload.mode,
                createdAt: new Date().toISOString()
              }
            ]);
            setLive(null);
            setConversation(current =>
              current
                ? {
                    ...current,
                    title:
                      current.title === 'New session' ? truncateTitle(text) : current.title,
                    updatedAt: new Date().toISOString()
                  }
                : current
            );
          },
          onError: (message, payload) => {
            if (controllerRef.current !== controller) return;
            terminal = true;
            if (payload?.evidence) evidence = payload.evidence as Evidence;
            setLive(current =>
              current
                ? {
                    ...current,
                    evidence: payload?.evidence ?? current.evidence,
                    error: message,
                    failedQuery: payload?.sql,
                    status: { phase: 'error', label: 'Could not complete the answer' }
                  }
                : current
            );
          }
        },
        controller.signal
      );

      if (controllerRef.current === controller && !terminal) {
        setLive(current =>
          current
            ? {
                ...current,
                error: 'The response ended before the answer completed. Try again.',
                status: { phase: 'error', label: 'The response ended unexpectedly' }
              }
            : current
        );
      }
    } catch (err) {
      if (controllerRef.current !== controller) return;
      if (isAbort(err)) {
        terminal = true;
        setLive(current =>
          current
            ? {
                ...current,
                stopped: true,
                status: { phase: 'stopped', label: 'Stopped' }
              }
            : current
        );
      } else {
        terminal = true;
        setLive(current =>
          current
            ? {
                ...current,
                error:
                  err instanceof ApiError ? err.message : 'Could not reach the assistant.',
              failedQuery: err instanceof ApiError ? err.query : undefined,
              status: { phase: 'error', label: 'Could not complete the answer' }
            }
            : current
        );
      }
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setStreaming(false);
      }
    }
  }

  function stop() {
    controllerRef.current?.abort();
    controllerRef.current = null;
    setStreaming(false);
    setLive(current =>
      current
        ? {
            ...current,
            stopped: true,
            status: { phase: 'stopped', label: 'Stopped' }
          }
        : current
    );
  }

  async function changeModel(value: string) {
    if (!conversation) return;
    const previous = modelId;
    setModelId(value);
    setModelSaving(true);
    setModelError('');
    try {
      const updated = await updateConversation(conversation.id, { modelId: value || null });
      setConversation(current => (current ? { ...current, ...updated } : current));
    } catch (err) {
      setModelId(previous);
      setModelError(err instanceof ApiError ? err.message : 'Could not change the model.');
    } finally {
      setModelSaving(false);
    }
  }

  function startTitleEdit() {
    if (!conversation) return;
    setDraftTitle(conversation.title);
    setTitleError('');
    setEditingTitle(true);
  }

  function cancelTitleEdit() {
    if (titleSaving) return;
    setEditingTitle(false);
    setDraftTitle('');
    setTitleError('');
  }

  async function saveTitle(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!conversation || titleSaving) return;
    const title = draftTitle.trim();
    if (!title) {
      setTitleError('Session name cannot be empty.');
      return;
    }
    if (title === conversation.title) {
      cancelTitleEdit();
      return;
    }

    setTitleSaving(true);
    setTitleError('');
    try {
      const response = await updateConversation(conversation.id, { title });
      const updated: ConversationSummary = {
        ...conversation,
        ...response,
        title,
        connection: response.connection ?? conversation.connection
      };
      setConversation(current => (current ? { ...current, ...updated } : current));
      window.dispatchEvent(
        new CustomEvent<ConversationSummary>(CONVERSATION_UPDATED_EVENT, { detail: updated })
      );
      setEditingTitle(false);
      setDraftTitle('');
    } catch (err) {
      setTitleError(err instanceof ApiError ? err.message : 'Could not rename the session.');
    } finally {
      setTitleSaving(false);
    }
  }

  function saveScope(updated: ConversationSummary) {
    setConversation(current => (current ? { ...current, ...updated } : current));
  }

  if (loading) {
    return (
      <section className="page narrow-page">
        <div className="page-heading">
          <p className="eyebrow">Session</p>
          <h1>Loading session…</h1>
        </div>
        <div className="panel skeleton-panel">
          <span className="skeleton skeleton-line wide" />
          <span className="skeleton skeleton-line" />
          <span className="skeleton skeleton-line short" />
        </div>
      </section>
    );
  }

  if (loadError || !conversation) {
    return (
      <section className="page narrow-page">
        <div className="page-heading">
          <p className="eyebrow">Session</p>
          <h1>{loadError === 'Session not found.' ? 'Session not found' : 'Could not load session'}</h1>
          <p>{loadError || 'This session is not available.'}</p>
        </div>
        <div className="alert alert-danger page-alert">
          <IconAlert size={17} />
          <span>{loadError || 'This session is not available.'}</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setReloadNonce(value => value + 1)}>
            <IconRefresh size={15} /> Retry
          </button>
        </div>
        <Link className="btn btn-primary" to="/">
          <IconPlus size={17} /> Start a new session
        </Link>
      </section>
    );
  }

  const activeModel = models.find(model => model.id === modelId);

  return (
    <section className="chat-page">
      <header className="chat-head">
        <div className="chat-head-content">
          <div className="chat-head-main">
            {editingTitle ? (
              <form className="chat-title-edit" onSubmit={event => void saveTitle(event)}>
                <input
                  autoFocus
                  value={draftTitle}
                  onChange={event => setDraftTitle(event.target.value)}
                  aria-label="Session name"
                  maxLength={200}
                  required
                  disabled={titleSaving}
                />
                <button
                  className="btn btn-ghost btn-icon chat-title-save"
                  type="submit"
                  aria-label="Save session name"
                  title="Save name"
                  disabled={titleSaving || !draftTitle.trim()}
                >
                  {titleSaving ? <span className="spinner spinner-sm" /> : <IconCheck size={16} />}
                </button>
                <button
                  className="btn btn-ghost btn-icon"
                  type="button"
                  aria-label="Cancel session name change"
                  title="Cancel"
                  onClick={cancelTitleEdit}
                  disabled={titleSaving}
                >
                  <IconClose size={16} />
                </button>
              </form>
            ) : (
              <div className="chat-title-row">
                <h1 title={conversation.title}>{conversation.title}</h1>
                <button
                  className="btn btn-ghost btn-icon chat-title-rename"
                  type="button"
                  aria-label="Rename session"
                  title="Rename session"
                  onClick={startTitleEdit}
                  disabled={titleSaving}
                >
                  <IconEdit size={15} />
                </button>
              </div>
            )
          }
          </div>

            <div className="chat-actions">
              {models.length > 0 ? (
                <label className="model-picker">
                  <span>Model</span>
                  <select
                    value={modelId}
                    onChange={event => void changeModel(event.target.value)}
                    disabled={modelSaving || streaming}
                    aria-label="Answer model"
                  >
                    <option value="">Auto (recommended)</option>
                    {models.map(model => (
                      <option key={model.id} value={model.id}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <span className="badge">Auto · {shortModelName(activeModel?.model_id)}</span>
              )}
              <button className="btn btn-ghost btn-sm" onClick={() => setDrawer('schema')}>
                <IconTable size={15} /> Tables
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setDrawer('relationships')}>
                <IconLink size={15} /> Relationships
              </button>
            </div>
          </div>
      </header>

      {titleError && (
        <div className="alert alert-danger chat-title-error" role="alert">
          <IconAlert size={16} />
          <span>{titleError}</span>
        </div>
      )}

      {modelError && (
        <div className="alert alert-danger chat-alert">
          <IconAlert size={16} />
          <span>{modelError}</span>
        </div>
      )}

      <div
        className="chat-thread"
        ref={threadRef}
        onScroll={event => {
          const element = event.currentTarget;
          stickToBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
      >
        {turns.length === 0 && !live && (
          <div className="chat-empty">
            <span className="chat-empty-icon">
              <IconSpark size={24} />
            </span>
            <span className="chat-empty-kicker">Your database is ready</span>
            <h2>Ask about {conversation.connection.name}</h2>
            <p>
              Get a clear answer with the SQL and data used to produce it. Try a question or write
              your own below.
            </p>
            <div className="chat-empty-scope">
              <span className="chat-empty-scope-item" title="Connection">
                <IconLock size={12} /> {conversation.connection.name}
              </span>
              <span className="chat-empty-scope-item" title="Database">
                {conversation.connection.database}
              </span>
              <span className="chat-empty-scope-item" title="Tables in scope">
                <IconTable size={12} /> {conversation.selectedTables.length} tables
              </span>
            </div>
          </div>
        )}

        {turns.map(turn => (
          <TurnView
            key={turn.id}
            turn={turn}
            onRetry={() => void ask(turn.question, true)}
            disabled={streaming}
          />
        ))}

        {live && (
          <LiveTurnView
            live={live}
            streaming={streaming}
            onRetry={() => void ask(live.question, true)}
            disabled={streaming}
          />
        )}
      </div>

      <form
        className="composer"
        onSubmit={event => {
          event.preventDefault();
          void ask(draft);
        }}
      >
        <label className="sr-only" htmlFor="question">
          Ask about your database
        </label>
        <textarea
          id="question"
          value={draft}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void ask(draft);
            }
          }}
          placeholder={streaming ? 'Answer in progress…' : 'Ask about your database…'}
          rows={1}
          maxLength={2000}
          disabled={streaming}
        />
        <div className="composer-bar">
          <span className="composer-hint">
            Enter to send · Shift+Enter for a new line
            {draft.length > 1800 ? ` · ${draft.length}/2000` : ''}
          </span>
          <div className="composer-actions">
            {!streaming && (
              <div
                className="answer-mode-picker"
                role="group"
                aria-label="Answer mode"
              >
                <span className="answer-mode-label">Answer with</span>
                {(['auto', 'data', 'schema'] as const).map(mode => (
                  <button
                    key={mode}
                    type="button"
                    className="answer-mode-option"
                    aria-pressed={answerMode === mode}
                    aria-label={`${mode === 'auto' ? 'Auto' : mode === 'data' ? 'Data' : 'Schema'} answer mode`}
                    title={
                      mode === 'auto'
                        ? 'Choose automatically based on the question'
                        : mode === 'data'
                          ? 'Run a read-only query on selected tables'
                          : 'Answer from table and relationship metadata'
                    }
                    onClick={() => setAnswerMode(mode)}
                  >
                    {modeIcon(mode)}
                    <span>{mode === 'auto' ? 'Auto' : mode === 'data' ? 'Data' : 'Schema'}</span>
                  </button>
                ))}
              </div>
            )}
            {streaming ? (
              <button type="button" className="btn btn-danger" onClick={stop}>
                <IconStop size={15} /> Stop
              </button>
            ) : (
              <button
                type="submit"
                className="btn btn-primary"
                disabled={!draft.trim() || !conversation}
              >
                <IconSend size={16} /> Send
              </button>
            )}
          </div>
        </div>
      </form>

      <SessionContextDrawer
        open={drawer !== null}
        initialTab={drawer ?? 'schema'}
        conversation={conversation}
        onClose={() => setDrawer(null)}
        onSaved={saveScope}
      />
    </section>
  );
}

function TurnView({
  turn,
  onRetry,
  disabled
}: {
  turn: ChatTurn;
  onRetry: () => void;
  disabled: boolean;
}) {
  const evidence = evidenceFromTurn(turn.evidence);
  const usedMode =
    turn.mode ??
    (evidence?.kind === 'schema' ? 'schema' : evidence?.kind === 'sql' ? 'data' : null);
  return (
    <article className="chat-turn">
      <PromptBubble prompt={turn.question} />
      <div className="msg-assistant">
        <div className="msg-meta">
          <span className="assistant-mark" aria-hidden="true">
            <IconSpark size={14} />
          </span>
          <span className="assistant-name">Answer</span>
          {usedMode && (
            <span className={`answer-mode-badge answer-mode-badge-${usedMode}`}>
              {modeIcon(usedMode, 12)}
              {usedModeLabel(usedMode)}
            </span>
          )}
          {turn.model && <span>{shortModelName(turn.model)}</span>}
          {turn.local && <span className="badge">Not saved</span>}
        </div>

        {turn.error && (
          <div className="alert alert-danger">
            <IconAlert size={16} />
            <span>{turn.error}</span>
            <button className="btn btn-ghost btn-sm" onClick={onRetry} disabled={disabled}>
              Retry
            </button>
          </div>
        )}

        {turn.stopped && !turn.error && (
          <p className="turn-stopped">
            Stopped. This turn was not saved.
            <button className="btn btn-ghost btn-sm" onClick={onRetry} disabled={disabled}>
              Ask again
            </button>
          </p>
        )}

        {turn.failedQuery && <FailedQuery sql={turn.failedQuery} />}

        {turn.answer ? (
          <MarkdownText text={turn.answer} />
        ) : (
          !turn.error && !turn.stopped && <p className="muted">No answer was produced.</p>
        )}

        {evidence && <EvidencePanel evidence={evidence} />}
      </div>
    </article>
  );
}

function LiveTurnView({
  live,
  streaming,
  onRetry,
  disabled
}: {
  live: LiveTurn;
  streaming: boolean;
  onRetry: () => void;
  disabled: boolean;
}) {
  return (
    <article className="chat-turn">
      <PromptBubble prompt={live.question} />
      <div className="msg-assistant">
        <div className="msg-meta">
          <span className="assistant-mark" aria-hidden="true">
            <IconSpark size={14} />
          </span>
          <span className="assistant-name">Answer</span>
        </div>

        {live.status && (
          <div className="status-line" aria-live="polite">
            {streaming ? <span className="spinner spinner-sm" /> : null}
            <span>{live.status.label}</span>
          </div>
        )}

        {live.error && (
          <div className="alert alert-danger">
            <IconAlert size={16} />
            <span>{live.error}</span>
            <button className="btn btn-ghost btn-sm" onClick={onRetry} disabled={disabled}>
              Retry
            </button>
          </div>
        )}

        {live.stopped && !live.error && (
          <p className="turn-stopped">
            Stopped. This turn was not saved.
            <button className="btn btn-ghost btn-sm" onClick={onRetry} disabled={disabled}>
              Ask again
            </button>
          </p>
        )}

        {live.answer && <MarkdownText text={live.answer} />}

        {live.failedQuery && <FailedQuery sql={live.failedQuery} />}

        {live.evidence && <EvidencePanel evidence={live.evidence} />}
      </div>
    </article>
  );
}

function PromptBubble({ prompt }: { prompt: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');

  async function copyPrompt() {
    try {
      await copyPromptToClipboard(prompt);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
    window.setTimeout(() => setCopyState('idle'), 1800);
  }

  return (
    <div className="msg-user">
      <p>{prompt}</p>
      <button
        type="button"
        className="btn btn-ghost btn-icon prompt-copy"
        onClick={() => void copyPrompt()}
        aria-label={
          copyState === 'copied'
            ? 'Prompt copied'
            : copyState === 'error'
              ? 'Could not copy prompt'
              : 'Copy prompt'
        }
        title={
          copyState === 'copied'
            ? 'Prompt copied'
            : copyState === 'error'
              ? 'Could not copy prompt'
              : 'Copy prompt'
        }
      >
        {copyState === 'copied' ? (
          <IconCheck size={15} />
        ) : copyState === 'error' ? (
          <IconAlert size={15} />
        ) : (
          <IconCopy size={15} />
        )}
      </button>
      <span className="sr-only" aria-live="polite">
        {copyState === 'copied' ? 'Prompt copied to clipboard.' : ''}
        {copyState === 'error' ? 'Could not copy prompt to clipboard.' : ''}
      </span>
    </div>
  );
}
