# 11 — Frontend architecture

> Four routes, one auth wrapper, one streaming client. Connection setup is a one-time gate; after that the chat page is a locked connection, a table scope, and evidence you can inspect.

**Back to:** [Implementation Walkthrough — Step 7](../history/implementation-walkthrough.md#8-step-7--frontend) · [Concept index](../history/implementation-walkthrough.md#concept-index)

> **Current implementation note:** routes are `/login`, `/connections`, `/sessions`, `/` (new session), `/c/:id` (chat), and `/admin/models` (admin only). The app shell includes a session history drawer, a session context drawer, and a provider admin page. See [Client call map](../reference/api/client-call-map.md).

## What it is

- **Routes:** `/login`, `/connections`, `/` (new session), `/c/:id` (chat).
- **`api/client.ts`:** the only place that knows the API base URL, the bearer token, and how to parse errors/SSE.
- **`NewSessionPage`:** pick one connection, load its schema, choose tables, create the session.
- **`ChatPage`:** locked connection badge, message thread, evidence panels, schema/relationship explorers, composer.
- **`SchemaExplorer` / `RelationshipExplorer`:** inspect and edit the table scope; direct FKs only.
- **`QueryResultPanel`:** SQL, result table, row count, timing, truncation.

**Prerequisites:** [04 — Express API structure](04-express-api-structure.md) (routes and errors). [05 — Auth with bcrypt + JWT](05-auth-jwt.md) (token lifecycle). [10 — NL-to-SQL agent](10-nl-to-sql-agent.md) (SSE events and evidence).

## Why this project uses it

- The hard part is not rendering a chat bubble; it is making the connection and table scope feel explicit and safe. The UI must show what database and which tables the answer came from.
- Evidence is the product's trust mechanism. SQL and rows must be visible, copyable, and readable on a phone.
- Streaming makes the app feel responsive, but it also introduces abort, partial-state, and reconnect problems. One client wrapper keeps those in one place.
- A small app does not need a global state library. Local state plus a few hooks is easier to reason about than a store with four routes.

## When to use this pattern

- Any chat-with-data app with a setup gate and a streaming answer view.
- Any app where the backend returns structured evidence alongside prose.
- If the app grows to many dashboards or shared state, add a query cache/store later; do not start with one.

## How it works here

### Routes and shell

```tsx
<BrowserRouter>
  <AuthProvider>
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<NewSessionPage />} />
        <Route path="/connections" element={<ConnectionsPage />} />
        <Route path="/sessions" element={<SessionsPage />} />
        <Route path="/c/:id" element={<ChatPage />} />
      </Route>
    </Routes>
  </AuthProvider>
</BrowserRouter>
```

- `RequireAuth` checks `getToken()` and redirects to `/login` with a `from` location.
- The app shell is a header plus the page. On mobile the header collapses to a menu; the connection badge remains visible.
- Do not render the chat composer on `/` or `/connections`. A session must exist before a question can be asked.

### Session history

- `SessionsPage` (`/sessions`) loads all sessions through `useSessions`, supports client-side search, and renders `SessionList`.
- `SessionsDrawer` is mounted from `AppShell` and provides a compact history list, focus trap, Escape/backdrop close, body scroll lock, and a `View all sessions` link.
- `AppShell` adds a `History` nav link and a `Session history` header button (`aria-label="Session history"`).
- The desktop hamburger is hidden above the mobile breakpoint via `.header-actions .menu-toggle` and a `matchMedia('(min-width: 761px)')` close handler.

### API client

```ts
const API = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const token = getToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API}${path}`, { ...options, headers });
  const data = await response.json().catch(() => null);

  const isAuthRoute = path.startsWith('/api/auth/');
  if (response.status === 401 && !isAuthRoute) {
    clearToken();
    window.location.assign('/login');
    throw new ApiError(401, 'Session expired. Please sign in again.');
  }
  if (!response.ok) {
    throw new ApiError(response.status, data?.error ?? 'Request failed');
  }
  return data as T;
}
```

Rules:

- Components never touch `localStorage` directly; `setToken`/`getToken`/`clearToken` live in one module.
- One `401` handler logs the user out everywhere, except on `/api/auth/*`; otherwise a failed login would redirect to the login page instead of showing “invalid credentials.”
- The API error message is shown as-is only because the server curates it. Never render a raw provider or database error.
- `VITE_API_URL` is build-time configuration. Document it in `.env.example`.

### SSE client

`EventSource` cannot send an `Authorization` header, so use `fetch` + a stream reader:

```ts
export async function streamQuestion(
  body: { question: string; conversationId: number },
  handlers: {
    onStatus?: (phase: string, label: string) => void;
    onEvidence?: (evidence: Evidence) => void;
    onToken?: (text: string) => void;
    onDone?: (payload: DonePayload) => void;
    onError?: (message: string) => void;
  },
  signal?: AbortSignal
) {
  const response = await fetch(`${API}/api/questions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${getToken()}`
    },
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => null);
    if (response.status === 401) {
      clearToken();
      window.location.assign('/login');
    }
    throw new ApiError(response.status, data?.error ?? 'Could not ask the question.');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? '';

    for (const block of events) {
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;

      let payload: any;
      try {
        payload = JSON.parse(dataLines.join('\n'));
      } catch {
        continue;
      }
      if (event === 'status') handlers.onStatus?.(payload.phase, payload.label);
      if (event === 'evidence') handlers.onEvidence?.(payload.evidence);
      if (event === 'token') handlers.onToken?.(payload.text);
      if (event === 'done') handlers.onDone?.(payload);
      if (event === 'error') handlers.onError?.(payload.error);
    }
  }
}
```

- Buffer across chunks; an event can split mid-line.
- Handle `event:` and multiple `data:` lines; do not assume one line per event.
- Use an `AbortController` for the Stop button. Aborting the fetch closes the server response; the server should not persist a partial turn.
- Do not use `EventSource` with a token in the query string. Tokens in URLs leak through logs and history.

### New-session page

```text
[ Connection: Analytics v ]  [ + Add connection ]
                |
                v
[ Loading schema... ]
                |
                v
[ Tables: (search) [x] customers [x] orders [x] order_items ]
                |
                v
[ Start session ]
```

Behavior:

- Load the schema only after a connection is selected. Do not preload every connection's schema.
- Default all non-system tables checked when the count is ≤ `MAX_SELECTED_TABLES` (100).
- If the schema exceeds the cap, show a clear warning and require explicit picks; the server returns `422` if the client sends an over-cap selection.
- Disable **Start session** while loading, while no tables are selected, or while a create request is in flight.
- Show connection test status inline. A failed test does not necessarily prevent saving, but it should be visible before session creation.
- On success, navigate to `/c/:id`. Do not keep the setup form mounted.
- A **New session** action from the chat page returns here and may pre-fill the previous connection/table selection. It must create a new session; it must not mutate the old one's connection.

### Chat page

```text
Header: [menu] [session title] [Analytics / demo_analytics] [model] [Tables] [New session]
Thread:
  user question
  assistant answer
    status line (planning / running query / answering)
    evidence details
      SQL (copy)
      result table
      row count · execution time · truncated
  ...
Composer: "Ask about your database…"
```

State:

```ts
type Turn = {
  id?: number;
  question: string;
  answer: string;
  evidence?: Evidence | [];
  status: 'idle' | 'planning' | 'running_query' | 'answering' | 'done' | 'error';
  error?: string;
};

type ChatState = {
  conversation: ConversationDetail | null;
  turns: Turn[];
  streaming: boolean;
  controller: AbortController | null;
};
```

Rules:

- The connection is a **locked badge**, not a picker. Changing it requires **New session**.
- The model is a session setting (`PATCH /api/conversations/:id { modelId }`); changing it does not change the connection or the selected tables.
- The composer is disabled until the conversation loads and while a stream is active.
- Enter sends; Shift+Enter inserts a newline. Disable the send button when the question is empty.
- Render evidence as soon as the `evidence` event arrives, before the first token.
- On `done`, append the final answer and persist the turn in local state. On reload, the server's session detail is the source of truth.
- On `error`, keep the question and any evidence visible; show a retry action. Do not render a fake answer.
- **Stop** aborts the request and leaves the partial text in the bubble marked “Stopped.” Catch `AbortError` from `streamQuestion` and do not show it as an API error. It must not be persisted as a completed turn.
- Auto-scroll only while the user is near the bottom. Do not yank the viewport if they scrolled up to read evidence.

### Evidence panel

```tsx
{evidence?.kind === 'sql' && (
  <details className="msg-section" open>
    <summary>
      Query · {evidence.rowCount} rows · {evidence.executionMs}ms
      {evidence.truncated ? ' · truncated' : ''}
    </summary>
    <pre><code>{evidence.sql}</code></pre>
    <ResultTable
      columns={evidence.columns}
      rows={evidence.rows}
      truncated={evidence.truncated}
    />
  </details>
)}

{evidence?.kind === 'schema' && <SchemaEvidencePanel evidence={evidence} />}
```

- SQL is monospace, selectable, and has a copy button with a visible “Copied” state.
- `ResultTable` uses a real `<table>` with a sticky header, horizontal scroll, and a max height. It renders `null` as a muted “NULL”, booleans as `true`/`false`, dates as the ISO strings returned by the API (localized only when the column type is known), and objects as compact JSON.
- Show an empty state for zero rows: “The query returned no rows.” Do not hide the panel.
- Show the truncation notice next to the row count, not only in a tooltip.
- Never render raw HTML from a cell. Use text nodes; this is an injection boundary.

### Schema explorer

Modal or side drawer:

- Search by table/column name.
- Table list with checkboxes.
- Expand a table to see columns, type, nullable, default, PK/FK badges, comments.
- Save applies `PATCH /api/conversations/:id { tables }`.
- Refresh re-introspects and warns if a selected table disappeared.
- Show a count: “12 of 40 selected.” Disable save when zero tables are selected.
- On mobile, the drawer is full-screen with a clear close button and a sticky save bar.

### Relationship explorer

- Only direct foreign keys between selected tables.
- Show `orders.customer_id → customers.id`, the constraint name, and `ON DELETE`/`ON UPDATE` actions.
- If no FKs exist, say so explicitly. Do not infer relationships from column names in Phase 1.
- Selecting a relationship highlights both tables; it does not run a query.

### Streaming state machine

```text
idle
  └─ submit → planning
       ├─ data → running_query → answering → done
       ├─ schema → answering → done
       ├─ clarify → answering → done
       └─ error → error
```

- `planning` starts when the request is sent, not when the first token arrives.
- `running_query` is a server status event; do not guess it on the client.
- `answering` starts on the first token or the `evidence` event for schema mode.
- `done` is terminal. Re-enable the composer.
- `error` is terminal for that turn. Keep the question editable for a retry.

### Responsive and accessible layout

- Desktop: chat column plus a collapsible evidence/schema side panel.
- Mobile: one column; evidence is a disclosure under each answer; explorers are full-screen sheets.
- Minimum touch target 44×44 px for icon buttons.
- Visible focus rings; never remove outlines without a replacement.
- Label every input and icon button. Use `aria-live="polite"` for streaming status, but do not announce every token.
- The result table scrolls horizontally inside its container; the page itself must not overflow.
- Respect `prefers-reduced-motion` for transitions.

### Loading, empty, and error states

| State | UI |
|---|---|
| Connections list empty | “No connections yet” + add action |
| Schema loading | Skeleton rows + “Reading schema…” |
| Schema load failed | Error with retry and “Edit connection” |
| No tables selected | Disabled start + helper text |
| Session not found / not owned | “Session not found” + back to new session |
| Question streaming | Status line + Stop button |
| Query timeout | “The query took too long” + evidence if available |
| LLM unavailable | “The assistant is unavailable. Try again shortly.” |
| Empty result | Evidence table with “No rows returned” |

Do not use a spinner as the only feedback for a multi-second schema load; show what is happening.

## Pitfalls we hit (and fixes)

1. **Using `EventSource`.** It cannot send the bearer token. Use `fetch` streaming, or move auth to an HttpOnly cookie (a larger change).
2. **Redirecting on a failed login.** A global `401` handler that runs for `/api/auth/login` hides “invalid credentials” behind a reload loop. Exclude auth routes from the redirect.
3. **Parsing SSE per chunk.** Tokens arrive split across reads. Buffer until `\n\n`, then parse complete events.
4. **Letting the connection be edited in the chat header.** It breaks the one-connection-per-session invariant. Make it a locked badge; new session only.
5. **Sending a question before the session loads.** The composer must be disabled until `conversationId` is known.
6. **Losing evidence on reload.** The server persists it; load session detail and render `turn.evidence`, not only in-memory stream state.
7. **Auto-scrolling during streaming.** It fights the user reading the SQL panel. Only scroll when already near the bottom.
8. **Rendering raw cell HTML.** XSS. Render text and format objects explicitly.
9. **Giant result cells.** Cap text and use `overflow-wrap: anywhere`; do not let one value blow the layout.
10. **Double submit.** Disable send while `streaming`; guard the handler with a ref if needed.
11. **No abort handling.** Stop must abort the fetch and leave a clear “Stopped” state; the server must not persist it.
12. **Table selection drift.** If a selected table is deleted, show the schema error and require a refresh; do not silently drop it.

## Verification checklist

```bash
npm run typecheck -w apps/frontend
npm run build -w apps/frontend
npm run dev
```

Manual/E2E:

1. Add a connection, test it, start a session with all tables.
2. Ask a data question; evidence appears before tokens; Stop aborts.
3. Ask a relationship question; schema evidence appears; no query status.
4. Ask an ambiguous question; clarify text appears; no evidence.
5. Reload `/c/:id`; turns and evidence persist.
6. Open schema explorer; deselect a table; save; ask a question needing it; get a clear scope error.
7. Open relationship explorer; see direct FKs only; empty state when none.
8. Mobile viewport ~390×844: no horizontal page scroll, drawers usable, touch targets adequate.
9. Desktop viewport ~1440×900: chat and evidence panel readable, table scroll contained.
10. Keyboard-only: login, create session, send, stop, open explorers, save.

## Backlinks

- Walkthrough: [Step 7 — Frontend](../history/implementation-walkthrough.md#8-step-7--frontend)
- Related: [04 — Express API structure](04-express-api-structure.md) · [05 — Auth with bcrypt + JWT](05-auth-jwt.md) · [10 — NL-to-SQL agent](10-nl-to-sql-agent.md) · [12 — Testing strategy](12-testing-strategy.md)
