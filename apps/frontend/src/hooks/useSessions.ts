import { useCallback, useEffect, useState } from 'react';
import { ApiError, deleteConversation, listConversations } from '../api/client';
import type { ConversationSummary } from '../types';

export function useSessions() {
  const [sessions, setSessions] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

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

  return { sessions, loading, error, actionError, deletingId, load, remove };
}
