# 12 — Testing strategy

> Test the safety invariants against a real PostgreSQL, mock only the LLM, and keep one real-browser journey. A green happy path proves almost nothing for this product.

**Back to:** [Implementation Walkthrough — Step 8](../Implementation_Walkthrough.md#9-step-8--tests-e2e-and-documentation) · [Concept index](../Implementation_Walkthrough.md#concept-index)

> **Current implementation note:** Jest recreates `database_knowledge_assistant_test` from `schema.sql` and uses the real `demo_analytics` target on `localhost:5435`. Playwright starts an LLM stub on `4010`, the API on `4100`, and Vite on `5273`, seeds the app database, and uses the normal `DATABASE_URL`. The older port examples below describe the original dev-only setup. See [Query map](../../databases/query-map.md).

## What it is

- **Unit tests:** crypto, SQL guard, schema mapping, result normalization, SSE parsing.
- **Integration tests:** Jest + Supertest against the real Express app, real app database, real target database, mocked LLM.
- **E2E:** one Playwright journey through signup, connection setup, schema and data questions, evidence persistence, scope editing, and logout.
- **CI:** typecheck, tests, frontend build, E2E on pull requests.

**Prerequisites:** [03 — Docker, Postgres & environment](03-docker-postgres.md) (two databases). [08 — Read-only SQL execution](08-readonly-sql-execution.md) (the invariants). [09 — LLM provider abstraction](09-llm-provider-abstraction.md) (what to mock). [11 — Frontend architecture](11-frontend-architecture.md) (E2E flows).

## Why this project uses it

- The highest-risk code is not the UI; it is credential handling, SQL validation, read-only enforcement, table scoping, and evidence persistence. Those need real database behavior.
- Mocking `pg` would hide the exact failures that matter: transaction mode, statement timeout, row cap, permission errors.
- A deterministic fake LLM keeps tests fast and free while still exercising the real planner/answer split.
- One E2E catches wiring mistakes that unit and integration tests cannot: SSE parsing, locked connection UI, and evidence rendering after reload.

## When to use this pattern

- Any app that executes user-influenced SQL or stores third-party credentials.
- Any streaming app with a server-side safety boundary.
- Do not build a huge E2E suite for an MVP. One journey plus focused integration tests is the right ratio.

## How it works here

### Test layers

| Layer | Tool | Real DB? | LLM | What it proves |
|---|---|---|---|---|
| Unit | Jest | no | none | Crypto, AST guard, normalization, formatting |
| Integration | Jest + Supertest | app DB + target DB | mocked | Routes, ownership, safety, persistence, SSE |
| E2E | Playwright | app DB + target DB | stub or real | The user journey and evidence UI |
| Build | `tsc` / Vite | no | none | Types and production bundle |

### Databases

Use three logical databases:

1. **App test DB** — `database_knowledge_assistant_test`, created/dropped by `globalSetup`.
2. **Target test DB** — a separate database (or schema) with sample tables and a read-only role. Do not point tests at the manual demo database.
3. **Manual demo DB** — `demo_analytics`, used by `npm run dev` and the E2E if you keep them separate.

`globalSetup.cjs`:

```js
const { Client } = require('pg');

module.exports = async () => {
  const adminUrl = process.env.TEST_ADMIN_DATABASE_URL
    ?? 'postgres://app_user:local_dev_password@localhost:5434/postgres';

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();

  await admin.query('DROP DATABASE IF EXISTS database_knowledge_assistant_test WITH (FORCE)');
  await admin.query('CREATE DATABASE database_knowledge_assistant_test');
  await admin.end();

  const app = new Client({
    connectionString: 'postgres://app_user:local_dev_password@localhost:5434/database_knowledge_assistant_test'
  });
  await app.connect();
  // Resolve this path from apps/backend, where Jest runs.
  await app.query(require('fs').readFileSync('schema.sql', 'utf8'));
  await app.end();

  // Create the target test database/schema and read-only role here too.
};
```

Rules:

- `WITH (FORCE)` drops stale connections from a previous failed run.
- Apply `schema.sql` exactly as production does; do not maintain a second test schema.
- Create the target test schema and role in setup, not by hand.
- Close every client. A leaked admin client can make the next drop hang.
- Set a generous Jest `testTimeout` for setup, but keep individual query timeouts short.

`setEnv.ts` runs before imports:

```ts
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  'postgres://app_user:local_dev_password@localhost:5434/database_knowledge_assistant_test';
process.env.JWT_SECRET = 'test-secret-at-least-32-characters-long';
process.env.CONNECTION_ENCRYPTION_KEY =
  Buffer.alloc(32, 7).toString('base64');
process.env.SQL_MAX_ROWS = '100';
process.env.SQL_TIMEOUT_MS = '500';
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/v1';
```

- Use a fixed test encryption key, not the developer's real key.
- Point `LLM_BASE_URL` at a closed port so an accidental real call fails fast.
- Set `SQL_TIMEOUT_MS` low enough for a timeout test but high enough for normal queries.
- Never use production credentials in test env.

### Isolation between tests

Integration tests share one app database. Choose one strategy and use it consistently:

- **Truncate between tests:** `TRUNCATE qa_history, conversations, database_connections, users RESTART IDENTITY CASCADE` in `beforeEach`.
- **Transaction rollback:** wrap each test in a transaction. Harder with Supertest because the app uses its own pool; not recommended here.
- **Per-worker schemas:** powerful but more setup than this app needs.

Run integration tests with `--runInBand` unless you have per-worker isolation. Parallel workers truncating the same tables produce flaky 404s and missing rows.

### Mocking the LLM

Mock the service module, not `fetch`, for route tests:

```ts
jest.mock('../src/services/llm', () => ({
  ...jest.requireActual('../src/services/llm'),
  chat: jest.fn(),
  chatStream: jest.fn()
}));

const mockChat = chat as jest.MockedFunction<typeof chat>;
const mockStream = chatStream as jest.MockedFunction<typeof chatStream>;

beforeEach(() => {
  mockChat.mockReset();
  mockStream.mockReset();
});
```

For a data question, queue the planner response, then the answer stream:

```ts
mockChat.mockResolvedValueOnce(JSON.stringify({
  mode: 'data',
  sql: 'SELECT count(*) AS count FROM customers'
}));

mockStream.mockImplementationOnce(async function* () {
  yield 'There are ';
  yield '3 customers.';
});
```

For a schema question:

```ts
mockChat.mockResolvedValueOnce(JSON.stringify({
  mode: 'schema',
  focus: 'orders -> customers'
}));
```

For a clarify:

```ts
mockChat.mockResolvedValueOnce(JSON.stringify({
  mode: 'clarify',
  question: 'Which table should I use: orders or order_items?'
}));
```

Do not mock `services/connectionPool` or `pg` in integration tests. The real read-only transaction, timeout, and row cap are the point.

### Unit tests

**Crypto**

- Encrypt → decrypt round-trips.
- Same plaintext encrypted twice produces different ciphertext (random IV).
- Wrong key fails.
- Tampered ciphertext/tag fails.
- Malformed payload fails with a clear error.
- Missing key fails at startup/use, not silently.

**SQL guard**

Accepted:

```text
SELECT * FROM orders
WITH recent AS (SELECT * FROM orders) SELECT * FROM recent
SELECT * FROM orders UNION ALL SELECT * FROM archived_orders
SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id
```

Rejected:

```text
INSERT INTO orders ...
UPDATE orders ...
DELETE FROM orders ...
DROP TABLE orders
SELECT * FROM orders; DROP TABLE orders
SELECT * INTO backup FROM orders
SELECT * FROM orders FOR UPDATE
SELECT * FROM secret_schema.salaries
WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x
```

Also test quoted identifiers, schema-qualified names, CTE aliases, and a table name that appears in a string literal (it must not be counted as a reference).

**Schema mapping**

- Columns, PK, FK, nullable, defaults, comments.
- Multi-column FKs.
- Views included and marked as views.
- `reltuples` clamped and labeled estimated.
- Direct relationships only; no name-based inference.

**Normalization**

- `int8` and `numeric` remain strings.
- `Date` becomes ISO.
- `Buffer` becomes a base64 marker.
- `null` stays `null`.
- Oversized cells are capped.

**SSE parsing**

- Event split across chunks.
- Multiple `data:` lines.
- `[DONE]` and keepalives ignored.
- Malformed JSON does not crash the stream.
- External abort stops the generator.

### Integration tests

Use a helper that signs up a user and returns a token:

```ts
async function signup(email = `user-${randomUUID()}@example.com`) {
  const response = await request(app)
    .post('/api/auth/signup')
    .send({ email, password: 'correct horse battery staple' });
  return { token: response.body.token, userId: response.body.user.id };
}
```

Must-have cases:

| Area | Assertion |
|---|---|
| Auth | No token → `401`; expired/invalid → `401` |
| Connections | Create → `201`; response has no password/ciphertext |
| Ownership | Another user's connection/session → `404` |
| Connection test | Failure → `200 { ok: false }`, safe message |
| Sessions | Create requires `connectionId`; `PATCH connectionId` → `400` |
| Scope | Unselected table → `422` with reason |
| Schema | Returns tables and direct FKs; no row data |
| Data | Returns SQL evidence and rows; persists `qa_history` |
| Schema mode | Does not call the generated-data-query path |
| Read-only | A direct `BEGIN TRANSACTION READ ONLY; INSERT ...` fails; the guard is tested separately |
| Timeout | `pg_sleep` beyond `SQL_TIMEOUT_MS` → `504` |
| Row cap | 101 rows with max 100 → `truncated: true`, 100 rows |
| Repair | Invalid SQL → one repair call → valid result; no infinite loop |
| LLM outage | `LlmUnavailableError` → `503` |
| Abort | Client abort does not insert a completed turn |
| Persistence | Reload session detail returns the same evidence JSON |
| Host guard | Blocked host → `400`; connection test to blocked host → `200 { ok: false }`; `DB_ALLOWED_HOSTS` restricts hosts |
| Session history | List loads; delete removes session and history; current-session delete navigates |

Schema-mode “no data query” assertion:

```ts
const runQuery = jest.spyOn(sqlExecution, 'runReadOnlyQuery');
mockChat.mockResolvedValueOnce(JSON.stringify({ mode: 'schema', focus: 'orders' }));

await request(app)
  .post('/api/questions')
  .set('Authorization', `Bearer ${token}`)
  .send({ conversationId, question: 'How are orders and customers related?' });

expect(runQuery).not.toHaveBeenCalled();
```

This asserts the routing decision without mocking the database. A stale schema cache may re-introspect metadata; that is not a generated data query.

### Playwright E2E

Use a deterministic LLM stub for CI. A tiny Express server that implements `POST /v1/chat/completions` can inspect the last user message and return:

- a schema plan for “related”
- a data plan for “how many”
- a clarify plan for “show me the data”
- an SSE stream for the answer

Start it via Playwright `webServer` (or a global setup) and point `LLM_BASE_URL` at it. This avoids API keys and makes assertions stable.

The journey:

1. Sign up with a unique email.
2. Add the demo target connection; test it.
3. Start a session; confirm all tables are selected by default.
4. Ask “How are orders and customers related?”; see schema evidence.
5. Ask “How many orders are there?”; see SQL and result rows.
6. Reload; confirm the turn and evidence persist.
7. Open the schema explorer; deselect a table; save.
8. Confirm the connection badge is locked; **New session** starts setup.
9. Browse and delete the saved session from the history page and drawer.
10. Log out.

Add a responsive smoke:

- Desktop ~1440×900: chat, evidence, explorers usable.
- Mobile ~390×844: no horizontal page scroll; drawers full-screen; send/stop reachable.

Add a host-guard smoke:

- Create a connection with `169.254.169.254`; expect the UI error `not allowed`.
- Retry with `127.0.0.1`; expect success.

Add a history smoke:

- Open `/sessions`; expect the empty state.
- Open the `Session history` drawer; expect focus trap and Escape close.
- Delete the saved session; expect the empty state again.

Playwright config notes:

```ts
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure'
  },
  webServer: [
    {
      command: 'npm run dev:api',
      cwd: '../..',
      port: 4000,
      reuseExistingServer: !process.env.CI
    },
    {
      command: 'npm run dev:web',
      cwd: '../..',
      port: 5173,
      reuseExistingServer: !process.env.CI
    }
  ]
});
```

If the app requires a clean database per E2E run, reset it in global setup. Do not rely on a developer's local data.

### CI

```yaml
# shape, not a full workflow
services:
  postgres:
    image: postgres:16
    env:
      POSTGRES_USER: app_user
      POSTGRES_PASSWORD: local_dev_password
      POSTGRES_DB: postgres
    ports: ['5434:5432']
    options: >-
      --health-cmd "pg_isready -U app_user"
      --health-interval 5s --health-timeout 5s --health-retries 10

steps:
  - run: npm ci
  - run: npm run typecheck
  - run: npm run test -w apps/backend -- --runInBand
  - run: npm run build
  - run: npx playwright install --with-deps chromium
  - run: npm run test:e2e
```

- The CI service container provides the PostgreSQL cluster; the job must still create the target test database/role (global setup or a migration step).
- Upload Playwright traces/screenshots on failure.
- Keep the E2E LLM stub in the repo; do not require a paid key for CI.
- Run the safety tests on every PR; they are fast enough.

## Pitfalls we hit (and fixes)

1. **Mocking `pg` for integration tests.** It hides transaction mode, timeout, and permission behavior. Use a real PostgreSQL.
2. **Parallel tests truncating shared tables.** Flaky 404s and missing rows. Use `--runInBand` or per-worker isolation.
3. **Global setup leaving connections open.** The next `DROP DATABASE` hangs. Close every client and use `WITH (FORCE)`.
4. **Using the developer's encryption key.** Tests become environment-dependent and may decrypt real secrets. Use a fixed test key.
5. **Accidentally calling a real LLM.** Point the base URL at a closed port in unit/integration env; use a stub for E2E.
6. **Fake timers around real database timeouts.** Jest fake timers do not advance PostgreSQL's clock. Use a real short `statement_timeout` and a real `pg_sleep`.
7. **Asserting on full error strings.** Messages change. Assert status codes and stable fragments (“outside this session's selected tables”).
8. **Only testing the happy path.** The product's value is the rejection path. Test writes, unselected tables, timeouts, and aborts.
9. **E2E against the manual demo DB.** A test can mutate data a human is using. Use a separate target DB.
10. **Not testing reload.** Evidence persistence is a core feature; a passing stream test does not prove the session detail endpoint returns it.

## Verification checklist

```bash
npm run typecheck
npm run test -w apps/backend -- --runInBand
npm run build
npx playwright install --with-deps chromium
npm run test:e2e
```

Before calling the suite healthy, confirm:

- [ ] Every safety test in the table above exists and passes.
- [ ] A direct write inside a read-only transaction fails; the AST guard is tested separately.
- [ ] Timeout and row cap are tested with real SQL, not mocks.
- [ ] Schema mode does not call the generated-data-query path.
- [ ] The password never appears in any response body.
- [ ] E2E reloads and sees persisted evidence.
- [ ] CI runs without a paid LLM key.

## Backlinks

- Walkthrough: [Step 8 — Tests, E2E, and documentation](../Implementation_Walkthrough.md#9-step-8--tests-e2e-and-documentation)
- Related: [06 — Database connections & encryption](06-database-connections-encryption.md) · [08 — Read-only SQL execution](08-readonly-sql-execution.md) · [09 — LLM provider abstraction](09-llm-provider-abstraction.md) · [13 — Security checklist](13-security-checklist.md)
