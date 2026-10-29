import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ApiError,
  getConversation,
  listModels,
  streamQuestion,
  updateConversation
} from '../api/client';
import type {
  ConversationDetail,
  ConversationSummary,
  Evidence,
  Model,
  StreamStatus,
  Turn
} from '../types';
import EvidencePanel from '../components/EvidencePanel';
import MarkdownText from '../components/MarkdownText';
import SessionContextDrawer, { type ContextTab } from '../components/SessionContextDrawer';
import {
  IconAlert,
  IconArrowRight,
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
};

type LiveTurn = {
  question: string;
  answer: string;
  evidence: Evidence | null;
  status: StreamStatus | null;
  error: string;
  stopped: boolean;
};

const SUGGESTIONS = [
  'Which customers placed the most orders?',
  'How are orders and customers related?',
  'What columns does the products table have?'
];

function evidenceFromTurn(value: Turn['evidence']): Evidence | null {
  if (!value || Array.isArray(value)) return null;
  return value;
}

function truncateTitle(question: string): string {
  return question.length > 80 ? `${question.slice(0, 77)}...` : question;
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
    setLive(null);
    setStreaming(false);
    setDraft('');
    setDrawer(null);

    Promise.all([getConversation(id), listModels().catch(() => [])])
      .then(([detail, nextModels]) => {
        if (cancelled) return;
        setConversation(detail);
        setTurns(detail.turns);
        setModels(nextModels);
        const defaultModel = nextModels.find(model => model.is_default) ?? nextModels[0];
        setModelId(detail.modelId ?? defaultModel?.id ?? '');
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
        error: live.error || undefined
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
        { question: text, conversationId: conversation.id },
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
    if (!conversation || !value) return;
    const previous = modelId;
    setModelId(value);
    setModelSaving(true);
    setModelError('');
    try {
      const updated = await updateConversation(conversation.id, { modelId: value });
      setConversation(current => (current ? { ...current, ...updated } : current));
    } catch (err) {
      setModelId(previous);
      setModelError(err instanceof ApiError ? err.message : 'Could not change the model.');
    } finally {
      setModelSaving(false);
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
        <div className="chat-head-main">
          <p className="eyebrow">Session</p>
          <h1 title={conversation.title}>{conversation.title}</h1>
          <div className="chat-meta">
            <span className="badge badge-lock">
              <IconLock size={12} /> {conversation.connection.name}
            </span>
            <span>{conversation.connection.database}</span>
            <span className="chat-meta-dot">·</span>
            <span>{conversation.selectedTables.length} tables in scope</span>
          </div>
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
                {models.map(model => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span className="badge">{shortModelName(activeModel?.model_id)}</span>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => setDrawer('schema')}>
            <IconTable size={15} /> Tables
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => setDrawer('relationships')}>
            <IconLink size={15} /> Relationships
          </button>
          <Link className="btn btn-ghost btn-sm" to="/">
            <IconPlus size={15} /> New session
          </Link>
        </div>
      </header>

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
            <span className="placeholder-icon">
              <IconSpark size={24} />
            </span>
            <h2>Ask about {conversation.connection.name}</h2>
            <p>
              Questions are answered with read-only SQL and the rows behind the answer. Start with
              one of these, or write your own.
            </p>
            <div className="suggestion-grid">
              {SUGGESTIONS.map(suggestion => (
                <button
                  key={suggestion}
                  className="suggestion"
                  onClick={() => void ask(suggestion)}
                  disabled={streaming}
                >
                  <span>{suggestion}</span>
                  <IconArrowRight size={16} />
                </button>
              ))}
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
          rows={2}
          maxLength={2000}
          disabled={streaming}
        />
        <div className="composer-bar">
          <span className="composer-hint">
            Enter to send · Shift+Enter for a new line
            {draft.length > 1800 ? ` · ${draft.length}/2000` : ''}
          </span>
          <div className="composer-actions">
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
  return (
    <article className="chat-turn">
      <div className="msg-user">
        <p>{turn.question}</p>
      </div>
      <div className="msg-assistant">
        <div className="msg-meta">
          <span>Assistant</span>
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
      <div className="msg-user">
        <p>{live.question}</p>
      </div>
      <div className="msg-assistant">
        <div className="msg-meta">
          <span>Assistant</span>
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

        {live.evidence && <EvidencePanel evidence={live.evidence} />}
      </div>
    </article>
  );
}
