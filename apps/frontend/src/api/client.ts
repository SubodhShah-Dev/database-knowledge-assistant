import type {
  AuthResponse,
  AnswerMode,
  AdminModel,
  AdminModelInput,
  Connection,
  ConnectionInput,
  ConnectionTest,
  ConnectionUpdateInput,
  ConversationDetail,
  ConversationSummary,
  DonePayload,
  Evidence,
  Model,
  SchemaSnapshot,
  StreamStatus,
  TableRef,
  User
} from '../types';

const API = import.meta.env.VITE_API_URL ?? '';
const TOKEN_KEY = 'dka.token';
const USER_KEY = 'dka.user';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly query?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function getUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

export function setUser(user: User) {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

function authHeaders(): Headers {
  const headers = new Headers();
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return headers;
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API}${path}`, { ...options, headers, credentials: 'include' });
  const data = await response.json().catch(() => null);
  const isAuthRoute = path.startsWith('/api/auth/');

  if (response.status === 401 && !isAuthRoute) {
    clearAuth();
    window.location.assign('/login');
    throw new ApiError(401, 'Session expired. Please sign in again.');
  }
  if (!response.ok) {
    throw new ApiError(response.status, data?.error ?? 'Request failed.');
  }
  return data as T;
}

export async function signIn(email: string, password: string): Promise<AuthResponse> {
  return apiFetch<AuthResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });
}

export async function signUp(email: string, password: string): Promise<AuthResponse> {
  return apiFetch<AuthResponse>('/api/auth/signup', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });
}

export async function signOut(): Promise<void> {
  try {
    await apiFetch('/api/auth/logout', { method: 'POST' });
  } catch {
    // Ignore logout errors; local state is cleared regardless.
  }
  clearAuth();
}

export function listConnections(): Promise<Connection[]> {
  return apiFetch<Connection[]>('/api/connections');
}

export function createConnection(input: ConnectionInput): Promise<Connection> {
  return apiFetch<Connection>('/api/connections', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export function updateConnection(id: string, input: ConnectionUpdateInput): Promise<Connection> {
  return apiFetch<Connection>(`/api/connections/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input)
  });
}

export function deleteConnection(id: string, force = false): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/api/connections/${id}${force ? '?force=true' : ''}`, {
    method: 'DELETE'
  });
}

export function testConnection(id: string): Promise<ConnectionTest> {
  return apiFetch<ConnectionTest>(`/api/connections/${id}/test`, { method: 'POST' });
}

export function getSchema(id: string, refresh = false): Promise<SchemaSnapshot> {
  return apiFetch<SchemaSnapshot>(
    `/api/connections/${id}/schema${refresh ? '?refresh=1' : ''}`
  );
}

export function listConversations(): Promise<ConversationSummary[]> {
  return apiFetch<ConversationSummary[]>('/api/conversations');
}

export function getConversation(id: string): Promise<ConversationDetail> {
  return apiFetch<ConversationDetail>(`/api/conversations/${id}`);
}

export function createConversation(body: {
  connectionId: string;
  tables?: TableRef[];
  modelId?: string | null;
}): Promise<ConversationSummary> {
  return apiFetch<ConversationSummary>('/api/conversations', {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

export function updateConversation(
  id: string,
  body: { title?: string; tables?: TableRef[]; modelId?: string | null }
): Promise<ConversationSummary> {
  return apiFetch<ConversationSummary>(`/api/conversations/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body)
  });
}

export function deleteConversation(id: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/api/conversations/${id}`, { method: 'DELETE' });
}

export function listModels(): Promise<Model[]> {
  return apiFetch<Model[]>('/api/models');
}

export function listAdminModels(): Promise<AdminModel[]> {
  return apiFetch<AdminModel[]>('/api/models/admin');
}

export function createAdminModel(input: AdminModelInput): Promise<AdminModel> {
  return apiFetch<AdminModel>('/api/models', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export function updateAdminModel(id: string, input: AdminModelInput): Promise<AdminModel> {
  return apiFetch<AdminModel>(`/api/models/${id}`, {
    method: 'PUT',
    body: JSON.stringify(input)
  });
}

export function deleteAdminModel(id: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/api/models/${id}`, { method: 'DELETE' });
}

type StreamHandlers = {
  onStatus?: (status: StreamStatus) => void;
  onEvidence?: (evidence: Evidence) => void;
  onToken?: (text: string) => void;
  onDone?: (payload: DonePayload) => void;
  onError?: (message: string, payload?: { sql?: string; evidence?: Evidence }) => void;
};

export async function streamQuestion(
  body: { question: string; conversationId: string; mode?: AnswerMode },
  handlers: StreamHandlers,
  signal?: AbortSignal
): Promise<void> {
  const response = await fetch(`${API}/api/questions`, {
    method: 'POST',
    headers: {
      ...Object.fromEntries(authHeaders().entries()),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream'
    },
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => null);
    if (response.status === 401) {
      clearAuth();
      window.location.assign('/login');
    }
    throw new ApiError(response.status, data?.error ?? 'Could not ask the question.', data?.sql);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? '';

      for (const block of blocks) {
        let event = 'message';
        const dataLines: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue;

        let payload: any;
        try {
          payload = JSON.parse(dataLines.join('\n'));
        } catch {
          continue;
        }

        if (event === 'status') handlers.onStatus?.(payload);
        if (event === 'evidence') handlers.onEvidence?.(payload.evidence);
        if (event === 'token') handlers.onToken?.(payload.text);
        if (event === 'done') handlers.onDone?.(payload);
        if (event === 'error') handlers.onError?.(payload.error, payload);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
