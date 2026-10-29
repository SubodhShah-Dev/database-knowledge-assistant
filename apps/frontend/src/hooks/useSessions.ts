import { useCallback, useEffect, useState } from 'react';
import { ApiError, deleteConversation, listConversations, updateConversation } from '../api/client';
import type { ConversationSummary } from '../types';

export const CONVERSATION_UPDATED_EVENT = 'dka:conversation-updated';

export function useSessions() {
  const [sessions, setSessions] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const applyConversationUpdate = useCallback((updated: ConversationSummary) => {
    setSessions(current =>
      current
        .map(session =>
          session.id === updated.id
            ? { ...session, ...updated, connection: updated.connection ?? session.connection }
            : session
        )
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    );
  }, []);

  useEffect(() => {
    function onConversationUpdated(event: Event) {
      applyConversationUpdate((event as CustomEvent<ConversationSummary>).detail);
    }

    window.addEventListener(CONVERSATION_UPDATED_EVENT, onConversationUpdated);
    return () => window.removeEventListener(CONVERSATION_UPDATED_EVENT, onConversationUpdated);
  }, [applyConversationUpdate]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setActionError('');
    try {
      setSessions(await listConversations());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load sessions.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(session: ConversationSummary): Promise<boolean> {
    setDeletingId(session.id);
    setActionError('');
    try {
      await deleteConversation(session.id);
      setSessions(current => current.filter(item => item.id !== session.id));
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setSessions(current => current.filter(item => item.id !== session.id));
        return true;
      }
      setActionError(err instanceof ApiError ? err.message : 'Could not delete the session.');
      return false;
    } finally {
      setDeletingId(null);
    }
  }

  async function rename(session: ConversationSummary, title: string): Promise<boolean> {
    setRenamingId(session.id);
    setActionError('');
    try {
      const response = await updateConversation(session.id, { title });
      const updated = { ...session, ...response, connection: response.connection ?? session.connection };
      applyConversationUpdate(updated);
      window.dispatchEvent(
        new CustomEvent<ConversationSummary>(CONVERSATION_UPDATED_EVENT, { detail: updated })
      );
      return true;
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not rename the session.');
      return false;
    } finally {
      setRenamingId(null);
    }
  }

  return { sessions, loading, error, actionError, deletingId, renamingId, load, remove, rename };
}
