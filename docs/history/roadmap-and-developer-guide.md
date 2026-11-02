# Database Knowledge Assistant

> Connect a PostgreSQL database, choose the tables that matter, and ask questions in plain English. Every answer is backed by a read-only query you can inspect, with the rows, execution time, and schema/relationship context shown alongside it. No document uploads, no chunking, no embeddings — just a safe, observable database chat.

> **Status: historical — Phase 1 build plan.** This document is the original Phase 1
> roadmap. It is useful for the plan, phases, and build schedule, but it does not
> describe the current feature set. Current facts live in
> [Current state](../architecture/current-state.md); the API and database are in the
> [API reference](../reference/api/README.md) and
> [Database reference](../reference/databases/README.md). For the build diary, see the
> [Implementation Walkthrough](implementation-walkthrough.md).
>
> Treat the Phase 1 sections below as the build narrative and learning path, not as a
> description of the current feature set.

## Contents

1. [Goals and constraints](#1-goals-and-constraints)
2. [Phases at a glance](#2-phases-at-a-glance)
3. [Build plan](#3-build-plan)
4. [Minimal architecture](#4-minimal-architecture)
5. [Developer setup and repository creation](#5-developer-setup-and-repository-creation)
6. [Recommended monorepo layout](#6-recommended-monorepo-layout)
7. [Database schema](#7-database-schema)
8. [Docker and local services](#8-docker-and-local-services)
9. [Backend: Express + TypeScript](#9-backend-express--typescript)
10. [Frontend: React + TypeScript](#10-frontend-react--typescript)
11. [Query behavior: schema vs data](#11-query-behavior-schema-vs-data)
12. [Session lifecycle and table scoping](#12-session-lifecycle-and-table-scoping)
13. [Security model](#13-security-model)
14. [Testing and E2E](#14-testing-and-e2e)
15. [Seed data and running the stack](#15-seed-data-and-running-the-stack)
16. [Free deployment strategies](#16-free-deployment-strategies)
17. [Phase 1 deliverables checklist](#17-phase-1-deliverables-checklist)
18. [README template](#18-readme-template)
19. [Estimated effort and difficulty](#19-estimated-effort-and-difficulty)
20. [Next steps and demo talking points](#20-next-steps-and-demo-talking-points)
21. [Further reading](#21-further-reading)

## 1. Goals and constraints

### Phase 1 goal

Build a working app where an authenticated user can:

- Sign up / log in.
- Add a private PostgreSQL connection (host, port, database, username, password, SSL mode).
- Test the connection and inspect whether the role is read-only.
- Start a chat session tied to **exactly one connection** and a selected set of tables.
- Ask data questions in natural language; the backend generates one read-only `SELECT`, validates it, executes it with a timeout and row cap, and streams an answer based on the returned rows.
- Ask schema questions about tables, columns, types, primary keys, foreign keys, comments, and direct relationships between the selected tables.
- See the generated SQL, the result table, row count, truncation notice, and execution time for every data answer.
- Browse a schema explorer and a relationship explorer for the session's connection.
- Change the selected table scope inside a session.
- Use existing sessions after reload; each session keeps its connection and evidence history.
- Browse, search, open, and delete saved sessions from a history page and a global drawer.

**The non-negotiable rule:** a session has one connection. To use another database, start a new session. The UI and API both enforce this; the connection cannot be patched on an existing session.

### Constraints

One developer, roughly 40–50 focused hours (8–10 days). Free/open-source stack: React + TypeScript + Vite, Node.js + Express + TypeScript, PostgreSQL for the app database, a user-supplied target database (Phase 1 originally PostgreSQL; MySQL/MariaDB/TiDB and MongoDB were added later), and an OpenAI-compatible LLM (local Ollama or a free cloud tier such as Groq, Gemini, or OpenRouter).

The app is an internal tool, not a production data platform. Do not connect it to production databases containing regulated or highly sensitive data until the hardening backlog in [13 — Security checklist](../concepts/13-security-checklist.md) is complete.

### Defer from Phase 1

CSV export, saved queries, table sample-row previews, multi-hop join-path discovery, schema change notifications, scheduled reports, sharing connections between users, engines beyond the implemented PostgreSQL/MySQL/MongoDB adapters, row-level security policy authoring, query cancellation from the browser, and deployment automation.

### Why this is not a RAG app

The existing PDF knowledge assistant extracts text, chunks it, searches chunks, and asks an LLM to answer from excerpts. This project has a different evidence source: a live relational database. The LLM does not retrieve prose; it proposes SQL, the server executes it under strict controls, and the answer is synthesized from the actual rows. That changes the hard problems from extraction/retrieval to credential handling, schema modelling, SQL safety, and query observability.

## 2. Phases at a glance

### Phase 1 — Core working product (8–10 days)

**Features:** authentication; per-user encrypted database connections; connection testing; schema introspection; direct FK relationship model; explicit session creation with one connection; table selection (all non-system tables by default); PostgreSQL-first NL-to-SQL (later expanded to MySQL/MariaDB/TiDB and MongoDB); read-only SQL execution with AST validation, timeout, and row cap; schema/attribute/relationship Q&A from metadata; generated SQL and result preview; SSE answer streaming; persisted sessions and evidence; schema explorer; relationship explorer; session history page and drawer with delete; Jest/Supertest integration tests; Playwright E2E.

**Acceptance criteria:**

1. A clean clone can start by following the README.
2. A user can add a PostgreSQL connection and test it without exposing the password in any response.
3. A session cannot exist without a connection, and an existing session's connection cannot be changed.
4. New sessions default to all non-system tables; the user can narrow or widen the scope later.
5. A data question returns an answer, the generated SQL, the result rows, and timing/truncation metadata.
6. A relationship or attribute question is answered from introspected schema metadata, without inventing columns or relationships.
7. Generated SQL is rejected if it is not a single `SELECT`-class statement or references tables outside the session scope.
8. Even if validation is bypassed, the target connection runs in a read-only transaction and cannot write.
9. A slow or expensive query is cut off by the statement timeout.
10. A user cannot access another user's connection, session, or evidence.
11. The LLM being unavailable produces a clear 503, not a crash.
12. The main flow has unit, integration, and one real-browser smoke test.

**Deliverables:** working local application, `schema.sql`, demo target database SQL, `.env.example`, README, license, tests, and a 2–3 minute demo.

### Phase 2 — Improve the assistant (2–4 weeks)

Priorities in suggested order:

1. **P1 — Query quality:** better schema context selection for large databases, column-level statistics, sample distinct values, disambiguation questions, and an evaluation set of natural-language questions with expected SQL/results.
2. **P1 — Query UX:** CSV export, copy/download SQL, query history with re-run, cancel running query, and a result chart view for small numeric results.
3. **P1 — Access control:** admin-shared connections, per-connection table allowlists, workspace roles, and audit events for who queried what.
4. **P2 — Relationship intelligence:** multi-hop join paths, join suggestions, and schema diagrams.
5. **P2 — Performance:** persistent schema snapshots, background introspection, connection pool tuning, and result caching for identical queries.
6. **P3 — Other engines:** MySQL/MariaDB adapters behind the same connection and SQL-guard interfaces.

### Phase 3 — Production hardening

- CI on pull requests: typecheck, unit/integration tests, frontend build, E2E.
- Secret management and key rotation for `CONNECTION_ENCRYPTION_KEY`.
- HTTPS, strict CORS, HttpOnly cookies instead of localStorage JWTs.
- Rate limits on connection tests and question endpoints.
- SSRF host guard for user-supplied hosts: block link-local/cloud metadata addresses, normalise IPv4-mapped IPv6, reject Unix socket paths, and support optional `DB_ALLOWED_HOSTS` allowlisting; DNS rebinding remains a residual risk.
- Structured logs with credential redaction, request IDs, health checks, and monitoring.
- Backups and restore rehearsal for the app database.
- Retention policy for connection credentials and chat evidence.
- Load testing for pools, schema introspection, and concurrent sessions.

## 3. Build plan

| Day | Tasks and estimates | End-of-day result |
|---|---|---|
| **1 — Foundation** | Repo/tooling 1h; Vite + Express 1.5h; Docker app Postgres 1h; root `.env` 0.5h; health check 0.5h | Both apps and the app database start |
| **2 — App schema and auth** | Users/conversations/evidence tables 1h; bcrypt + JWT 2h; auth middleware and ownership 1h; auth tests 1h | Protected API calls work |
| **3 — LLM client** | OpenAI-compatible `chat`/`chatStream` 2h; error mapping 1h; provider configuration 0.5h; tests with mocked fetch 1h | Provider can be swapped by env |
| **4 — Connections** | Connection table 1h; AES-256-GCM encryption 1.5h; CRUD + test endpoint 2h; ownership and no-secret checks 1h | A user can add a working private connection |
| **5 — Schema introspection** | Tables/columns/PK/FK queries 2h; comments and row estimates 1h; cache and refresh 1h; relationship API 1h | Schema and direct relationships are available |
| **6 — Sessions and table scope** | Conversation creation 1h; one-connection enforcement 1h; selected tables validation 1.5h; legacy/error states 0.5h | New sessions start with a fixed connection and table scope |
| **7 — SQL safety and execution** | AST guard 2h; read-only transaction, timeout, row cap 1.5h; result normalization 1h; tests 1.5h | Generated SQL can be executed safely |
| **8 — NL-to-SQL agent** | Planner prompt and JSON parsing 2h; repair loop 1h; answer synthesis 1.5h; SSE evidence 1.5h | Ask a data or schema question end to end |
| **9 — Frontend** | Connection form 1.5h; new-session flow 1.5h; schema/relationship explorer 2h; SQL/result panel 1.5h; chat cleanup 1h | Complete UI wired to the API |
| **10 — Verification and docs** | Integration tests 2h; Playwright smoke 1.5h; README 1h; demo data 1h; bug fixes 1.5h | Milestone: add connection → select tables → ask → inspect evidence |

**Scope rule:** if the schedule slips, postpone CSV export, saved queries, multi-hop paths, and visual polish — not credential encryption, read-only enforcement, table scoping, SQL validation, or tests.

## 4. Minimal architecture

> Current implementation: the target layer is multi-engine (`postgres`, `mysql`, `mongodb`), the provider layer is admin-configurable, and the app has an **AI providers** screen. See [CURRENT_STATE.md](../architecture/current-state.md) for the actual component map.

```text
React + TypeScript UI (Vite, :5173)
        |
        | JWT / JSON API + SSE
        v
Express + TypeScript API (:4000)
        |
        +--> App PostgreSQL
        |      users, database_connections, conversations,
        |      qa_history, models, app_settings
        |
        +--> User's target PostgreSQL
        |      read-only role, SELECT only,
        |      statement timeout, row cap
        |
        +--> OpenAI-compatible LLM
               planner pass  (question + schema -> SQL or schema answer)
               answer pass   (question + rows/schema -> streamed prose)
```

The request lifecycle:

1. Resolve the session and its single connection.
2. Load the selected table scope and a cached schema snapshot.
3. Ask the planner model for a `schema` or `data` plan.
4. For `data`: validate the SQL against the AST guard and table allowlist, execute it in a read-only transaction, cap rows, normalize values.
5. For `schema`: select the relevant metadata and direct FK relationships.
6. Ask the answer model to synthesize a concise answer from the evidence.
7. Stream `status` → `evidence` → `token`* → `done`; persist the turn and evidence in one transaction.

## 5. Developer setup and repository creation

### Prerequisites

- Git.
- Node.js 20+ and npm.
- Docker Engine/Desktop (two PostgreSQL containers: app DB and demo target DB).
- An LLM API key **or** local Ollama. Both are optional until the first question.

Check tools:

```bash
node --version
npm --version
git --version
docker --version
docker compose version
```

### Create the repository

```bash
mkdir database-knowledge-assistant
cd database-knowledge-assistant
git init -b main
npm init -y
mkdir -p apps/backend/src/{routes,middleware,services} apps/backend/test apps/backend/demo
npm create vite@latest apps/frontend -- --template react-ts
```

Install the backend dependencies:

```bash
npm install -w apps/backend express cors helmet morgan pg bcrypt jsonwebtoken dotenv zod pgsql-ast-parser
npm install -D -w apps/backend typescript tsx jest ts-jest supertest @types/express @types/node @types/pg @types/bcrypt @types/jsonwebtoken @types/cors @types/morgan @types/supertest @types/jest
```

Install the frontend dependencies:

```bash
npm install -w apps/frontend react-router-dom
```

Root scripts:

```json
{
  "name": "database-knowledge-assistant",
  "private": true,
  "workspaces": ["apps/frontend", "apps/backend"],
  "scripts": {
    "dev": "concurrently -k -n api,web \"npm:dev:api\" \"npm:dev:web\"",
    "dev:api": "npm run dev -w apps/backend",
    "dev:web": "npm run dev -w apps/frontend",
    "test": "npm run test -w apps/backend",
    "test:e2e": "npm run test:e2e -w apps/frontend",
    "typecheck": "npm run typecheck -w apps/backend && npm run typecheck -w apps/frontend",
    "build": "npm run build -w apps/backend && npm run build -w apps/frontend"
  },
  "devDependencies": { "concurrently": "^9.1.2" }
}
```

### Create a GitHub repository

```bash
gh repo create database-knowledge-assistant --private --source=. --remote=origin
git add .
git commit -m "chore: repository foundation"
git push -u origin main
```

Branch-per-slice is still the best learning workflow: one branch, one coherent feature, typecheck, tests, merge.

### `.gitignore`

```gitignore
node_modules/
dist/
.env
*.log
coverage/
test-results/
playwright-report/
```

## 6. Recommended monorepo layout

```text
database-knowledge-assistant/
├── apps/
│   ├── backend/
│   │   ├── demo/
│   │   │   └── target-schema.sql      # sample target DB + read-only role
│   │   ├── src/
│   │   │   ├── middleware/            # auth
│   │   │   ├── routes/                # auth, connections, conversations, questions, models
│   │   │   ├── services/              # llm, modelConfig, connectionCrypto, connectionPool,
│   │   │   │                          # databaseAdapters, introspection, sqlGuard,
│   │   │   │                          # sqlExecution, agent, sessionScope, hostGuard
│   │   │   ├── app.ts                 # express app
│   │   │   ├── db.ts                  # app database pool
│   │   │   ├── seed.ts                # demo user
│   │   │   └── server.ts              # entrypoint
│   │   ├── schema.sql                 # app database schema
│   │   └── test/                      # jest config, setup, unit + integration
│   └── frontend/
│       ├── e2e/                       # Playwright smoke test
│       ├── playwright.config.ts
│       └── src/
│           ├── api/client.ts          # fetch wrapper, auth token, SSE
│           ├── components/            # ConnectionForm, TableSelector, SchemaExplorer,
│           │                          # RelationshipExplorer, QueryResultPanel,
│           │                          # ChatMessage, Composer, SessionList,
│           │                          # SessionsDrawer, icons
│           ├── hooks/                 # useSessions
│           ├── pages/                 # LoginPage, ConnectionsPage, HistoryPage,
│           │                          # NewSessionPage, ChatPage
│           ├── router.tsx
│           ├── types.ts
│           └── main.tsx
├── docker-compose.yml                 # app-postgres + demo-postgres
├── .env.example
├── README.md
└── package.json
```

## 7. Database schema

> Current schema: see [schema-reference.md](../reference/databases/schema-reference.md). The app schema now includes `engine`, `connection_uri_encrypted`, `qa_history.answer_mode`, and `models.api_key_encrypted`; the engine check allows only `postgres`, `mysql`, and `mongodb`.

### App database — `apps/backend/schema.sql`

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS database_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  host text NOT NULL,
  port integer NOT NULL DEFAULT 5432,
  database_name text NOT NULL,
  username text NOT NULL,
  password_encrypted text NOT NULL,
  ssl_mode text NOT NULL DEFAULT 'prefer'
    CHECK (ssl_mode IN ('disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);
CREATE INDEX IF NOT EXISTS database_connections_owner_idx
  ON database_connections (owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS conversations (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES database_connections(id) ON DELETE RESTRICT,
  title text NOT NULL,
  selected_tables jsonb NOT NULL DEFAULT '[]',
  model_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_user_updated_idx
  ON conversations (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS conversations_connection_idx
  ON conversations (connection_id);

CREATE TABLE IF NOT EXISTS qa_history (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id bigint NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  question text NOT NULL,
  answer text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]',
  model text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS qa_history_conv_idx
  ON qa_history (conversation_id, id);

CREATE TABLE IF NOT EXISTS models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  model_id text NOT NULL UNIQUE,
  base_url text,
  is_enabled boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS models_single_default
  ON models ((true)) WHERE is_default;

CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

Design notes:

- `conversations.connection_id` is `NOT NULL`: a session cannot exist without one connection.
- `ON DELETE RESTRICT` means deleting a connection with sessions fails unless the user explicitly deletes those sessions first.
- `selected_tables` is JSON because the list is small, order does not matter, and it travels with the session.
- `qa_history.evidence` stores the SQL/result or schema evidence as versioned JSON. Do not stuff generated SQL into a prose answer field.
- There is no documents/chunks/verifications table. That is intentional.

### Demo target database — `apps/backend/demo/target-schema.sql`

```sql
CREATE TABLE customers (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  country text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  category text NOT NULL,
  price numeric(10,2) NOT NULL
);

CREATE TABLE orders (
  id bigserial PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES customers(id),
  status text NOT NULL,
  ordered_at timestamptz NOT NULL,
  total numeric(10,2) NOT NULL
);

CREATE TABLE order_items (
  order_id bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES products(id),
  quantity integer NOT NULL,
  unit_price numeric(10,2) NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

CREATE ROLE demo_reader LOGIN PASSWORD 'demo_reader_password';
GRANT CONNECT ON DATABASE demo_analytics TO demo_reader;
GRANT USAGE ON SCHEMA public TO demo_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO demo_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO demo_reader;
```

Seed the demo target with a few customers, products, and orders so schema and data questions have visible answers.

## 8. Docker and local services

`docker-compose.yml` runs two independent Postgres instances:

```yaml
services:
  app-postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: database_knowledge_assistant
      POSTGRES_USER: app_user
      POSTGRES_PASSWORD: local_dev_password
    ports:
      - "5434:5432"
    volumes:
      - app_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app_user -d database_knowledge_assistant"]
      interval: 5s
      timeout: 3s
      retries: 10

  demo-postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: demo_analytics
      POSTGRES_USER: demo_admin
      POSTGRES_PASSWORD: demo_admin_password
    ports:
      - "5435:5432"
    volumes:
      - demo_pgdata:/var/lib/postgresql/data
      - ./apps/backend/demo/target-schema.sql:/docker-entrypoint-initdb.d/01-target.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U demo_admin -d demo_analytics"]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  app_pgdata:
  demo_pgdata:
```

Apply the app schema:

```bash
docker compose exec -T app-postgres psql -U app_user -d database_knowledge_assistant \
  < apps/backend/schema.sql
```

The demo target is for development only. The real product lets each user add their own connection. The demo connection details:

```text
host: 127.0.0.1
port: 5435
database: demo_analytics
username: demo_reader
password: demo_reader_password
ssl: disable
```

### Environment variables

One root `.env`, loaded by the backend regardless of CWD:

```env
NODE_ENV=development
PORT=4000
DATABASE_URL=postgres://app_user:local_dev_password@localhost:5434/database_knowledge_assistant
JWT_SECRET=replace_with_a_strong_secret
FRONTEND_ORIGIN=http://localhost:5173

# 32 bytes, base64 or hex. Generate with:
# node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
CONNECTION_ENCRYPTION_KEY=

# LLM: any OpenAI-compatible provider
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_API_KEY=
LLM_MODEL=openai/gpt-oss-120b
LLM_TIMEOUT_MS=60000

# Target-database safety limits
SQL_MAX_ROWS=100
SQL_TIMEOUT_MS=5000
SQL_SCHEMA_CACHE_MS=300000
DB_CONNECT_TIMEOUT_MS=5000
MAX_CONNECTIONS_PER_USER=20
MAX_SELECTED_TABLES=100
DB_ALLOWED_HOSTS=
```

`.env.example` commits the shape, never the values. `CONNECTION_ENCRYPTION_KEY` must be present at boot; if it is missing, fail loudly instead of silently storing weakly protected credentials.

## 9. Backend: Express + TypeScript

### Structure

- `app.ts` builds the Express app and mounts routers.
- `server.ts` binds the port.
- `routes/auth.routes.ts` — signup/login.
- `routes/connections.routes.ts` — CRUD, test, schema.
- `routes/conversations.routes.ts` — session creation, list, detail, rename, table scope.
- `routes/questions.routes.ts` — ask, SSE, evidence.
- `routes/models.routes.ts` — public model list plus admin provider CRUD.
- `services/llm.ts` — OpenAI-compatible chat and stream, timeouts, failover.
- `services/connectionCrypto.ts` — AES-256-GCM.
- `services/connectionPool.ts` — lazy PostgreSQL target pools.
- `services/databaseAdapters.ts` — MySQL/MongoDB adapters, validation, execution, introspection.
- `services/introspection.ts` — PostgreSQL tables, columns, keys, relationships.
- `services/sqlGuard.ts` — PostgreSQL AST validation and table allowlist.
- `services/sqlExecution.ts` — read-only PostgreSQL transaction, timeout, row cap, normalization.
- `services/agent.ts` — planner, repair, evidence, answer synthesis.
- `services/modelConfig.ts` — model resolution and failover chain.
- `middleware/auth.ts` — JWT verification.

> The names `schemaIntrospection.ts` and `sqlAgent.ts` in older notes map to `introspection.ts` and `agent.ts` today.

### API surface

> Full request/response documentation: [API reference](../reference/api/README.md).

```text
POST   /api/auth/signup
POST   /api/auth/login

GET    /api/connections
POST   /api/connections
GET    /api/connections/:id
PATCH  /api/connections/:id
DELETE /api/connections/:id
POST   /api/connections/:id/test
GET    /api/connections/:id/schema?refresh=1

GET    /api/conversations
POST   /api/conversations
GET    /api/conversations/:id
PATCH  /api/conversations/:id
DELETE /api/conversations/:id

POST   /api/questions
GET    /api/models
GET    /api/models/admin
POST   /api/models
PUT    /api/models/:id
DELETE /api/models/:id
GET    /api/health
```

Deleting a connection that still has sessions returns `409`; `?force=true` deletes those sessions first. The UI must make that consequence explicit.

### Create a session

```ts
POST /api/conversations
{
  "connectionId": "9f1a...",
  "tables": [
    { "schema": "public", "table": "orders" },
    { "schema": "public", "table": "customers" }
  ]
}
```

If `tables` is omitted, the server selects all non-system tables (up to `MAX_SELECTED_TABLES`). If the database has more tables than the cap, the API returns `422` and asks the client to choose explicitly.

### One connection per session

- `conversations.connection_id` is required at creation.
- `PATCH /api/conversations/:id` accepts `title`, `modelId`, and `tables`. It rejects `connectionId` with `400: A session's connection cannot be changed. Start a new session.`
- `POST /api/questions` derives the connection from `conversationId`; it never accepts a connection id from the request body.

### Ask a question

```ts
POST /api/questions
{
  "question": "How many orders were placed in the last 30 days?",
  "conversationId": 42
}
```

SSE events:

```text
event: status    { "phase": "planning", "label": "Understanding the question" }
event: status    { "phase": "running_query", "label": "Running read-only query" }
event: evidence  { "evidence": { "kind": "sql", "sql": "...", "columns": [...], "rows": [...], ... } }
event: token     { "text": "There were " }
event: token     { "text": "128 orders " }
event: done      { "conversationId": 42, "messageId": 117, "answer": "...", "model": "..." }
```

Schema questions use the same flow with `evidence.kind = "schema"` and no query execution.

### Error mapping

> Current implementation: `app.ts` maps `LlmUnavailableError` to `503` and invalid JSON bodies to `400`. Route handlers map validation, scope, target-timeout, and database errors locally. Unknown errors return `500`.

- `LlmUnavailableError` → `503` with a clear retry message.
- `SqlValidationError` → `422` with the validation reason and the rejected SQL.
- `TargetDbTimeoutError` → SSE `error` with `code: "timeout"` after the stream starts; MySQL connection timeouts can return `504` before streaming.
- Unknown errors → `500`; log server-side, never return credentials.
- Connection test failures → `200 { ok: false, error }` so the UI can show the failure without treating it as an API crash.

### Persistence

Persist the user question, answer, evidence JSON, and model in one transaction. If streaming is aborted by the Stop button, do not persist the partial turn. If the answer synthesis fails after a successful query, return a clear error and do not pretend a query result is an answer.

## 10. Frontend: React + TypeScript

### Pages and flows

1. **Login / signup** — same token lifecycle as the original app.
2. **Connections page** — list user connections, add/edit/test/delete. Password fields are write-only; show `has_password`.
3. **New session page (`/`)** — choose a connection or add one, load schema, choose tables, start session.
4. **Chat page (`/c/:id`)** — connection badge, selected tables, message thread, schema explorer, relationship explorer, SQL/result panel, composer.
5. **Schema explorer** — modal/drawer with search, tables, columns, types, PK/FK badges, comments, and table checkboxes.
6. **Relationship explorer** — direct FK relationships between selected tables, with source/target columns.
7. **Query result panel** — generated SQL, copy button, result table, row count, truncation notice, execution time.

### Session creation UI rules

- The connection picker is visible only on the new-session page.
- Once a session exists, the connection is shown as a locked badge.
- A **New session** action starts the setup flow again; it may pre-fill the previous table selection.
- The composer is disabled until the session exists.

### Streaming state

```text
idle → planning → running_query → answering → done
                \→ schema_answering → done
                \→ error
```

Show a small status line under the assistant bubble. When evidence arrives, reveal the SQL/result panel before tokens complete so the user can inspect the query while the answer streams.

### Component contracts

Every data-loading component has four states:

- **Loading:** skeleton or “Loading schema…”
- **Empty:** “No tables selected” or “No rows returned”
- **Error:** readable message with retry where safe
- **Success:** data plus a next action

## 11. Query behavior: schema vs data

The planner chooses one of three modes:

### Schema mode

Use for questions such as:

- “What columns does `orders` have?”
- “How are `orders` and `customers` related?”
- “Which column is the primary key of `order_items`?”
- “What does the `status` column mean?” (answer from comments when available; otherwise say the comment is missing)

No SQL is executed. The answer comes from the introspected metadata and direct FK relationships. The evidence panel lists the tables, columns, and relationships used.

### Data mode

Use for questions such as:

- “How many orders were placed last month?”
- “Show the top five products by revenue.”
- “Which countries have the most customers?”
- “What is the average order value by status?”

The planner generates one PostgreSQL `SELECT`. The server validates and executes it read-only. The answer is synthesized from the returned rows and must mention when results are empty or truncated.

### Clarify mode

Use when the question is ambiguous or references a table outside the session scope. The assistant asks a short clarifying question instead of guessing. Example: two selected tables both have `id` and `name`, and the user asks “show me the names” without context.

## 12. Session lifecycle and table scoping

### Lifecycle

```text
connection created (per user, encrypted)
        ↓
new session: connection + tables + model
        ↓
ask questions (connection fixed, tables editable)
        ↓
new session required to change connection
```

### Table scoping

- Stored on `conversations.selected_tables` as `[{ schema, table }]`.
- Default: all non-system tables, capped at `MAX_SELECTED_TABLES`.
- If over the cap, require explicit selection.
- `PATCH /api/conversations/:id` validates the new scope against a fresh schema snapshot.
- The selected tables control both the schema prompt and the SQL allowlist. A query that joins an unselected table is rejected.
- If a selected table disappears after a schema change, the next question returns a clear “table no longer exists; refresh the schema” error rather than guessing.

### Legacy behavior

This guide builds the database app from scratch, so there are no old document sessions. If you are adapting an existing PDF app, keep old sessions listable but block asking with a “Start a new session” message. Do not silently attach a random database connection to an old session.

## 13. Security model

The LLM is untrusted. The target database is untrusted input. The browser is untrusted. The controls are layered:

1. **Encrypted credentials:** AES-256-GCM, key from env, password never returned.
2. **Per-user ownership:** every connection and session query includes `owner_id`; other users get `404`.
3. **Read-only database role:** the strongest control. The connection test warns when the supplied role can write.
4. **Read-only transaction:** `BEGIN TRANSACTION READ ONLY` on every data query.
5. **AST validation:** exactly one `SELECT`-class statement, no DML/DDL, no `SELECT INTO`, no `FOR UPDATE`, no multi-statement payloads.
6. **Table allowlist:** only tables selected in the session; reject `pg_catalog`/`information_schema` in data queries.
7. **Timeout and row cap:** statement timeout plus a bounded outer `LIMIT`.
8. **Output normalization:** cap cell length, convert non-JSON types, never render results as HTML.
9. **Prompt-injection stance:** schema comments and row values are data, not instructions. The answer prompt says so explicitly and the server never lets the model execute anything without validation.
10. **Logging discipline:** no passwords, no connection strings, no full result sets in logs.

Accepted MVP trade-offs: JWT in localStorage, credentials stored in the app DB (encrypted, not in a vault), shared network egress for user-supplied hosts, and no query cancellation. See [13 — Security checklist](../concepts/13-security-checklist.md) for the hardening backlog.

## 14. Testing and E2E

### Unit tests

- AES-256-GCM round-trip, wrong key, tampered payload.
- SQL guard: accepts `SELECT`, CTE `SELECT`, `UNION`; rejects `INSERT`, `UPDATE`, `DELETE`, `DROP`, multiple statements, `SELECT INTO`, `FOR UPDATE`, unselected tables.
- Schema mapping: columns, PK, FK, comments, direct relationships.
- Table-scope normalization and validation.
- Result normalization: `int8` strings, `numeric` strings, dates, buffers, nulls.

### Integration tests (Jest + Supertest)

- Connection CRUD is owner-scoped; password never appears in responses.
- Connection test failure returns a safe error.
- Host guard rejects link-local/cloud metadata hosts and enforces `DB_ALLOWED_HOSTS`.
- Legacy rows with blocked hosts fail safely on connection test.
- Session creation requires a connection; `PATCH` rejects a connection change.
- Schema endpoint returns tables and relationships.
- Data question returns answer + SQL evidence; mocked LLM provides deterministic SQL.
- Schema question returns metadata evidence and does not execute SQL.
- SQL referencing an unselected table is rejected.
- Read-only role/transaction rejects a write even if the guard is bypassed.
- Timeout and row-cap behavior.
- One repair attempt after a invalid/error SQL.
- LLM outage returns 503.
- Legacy/no-connection session returns 409 (adapter scenario only).

### Playwright E2E

One real-browser journey:

1. Sign up.
2. Add the demo target connection; test it.
3. Start a session; confirm all tables selected by default.
4. Ask a relationship question; see schema evidence.
5. Ask a data question; see SQL and result rows.
6. Reload the session; confirm evidence persists.
7. Open the schema explorer and change the table scope.
8. Confirm the connection badge is locked; start a new session from the action.
9. Browse and delete the saved session from the history page and drawer.
10. Log out.

The E2E can use a mocked LLM via an env-controlled test provider endpoint, or a real free-tier key. The database itself must be real; mocking `pg` would hide the safety behavior that matters.

## 15. Seed data and running the stack

```bash
npm install
docker compose up -d
docker compose exec -T app-postgres psql -U app_user -d database_knowledge_assistant \
  < apps/backend/schema.sql
cp .env.example .env
# fill CONNECTION_ENCRYPTION_KEY, JWT_SECRET, and an LLM key or Ollama URL
npm run seed -w apps/backend
npm run dev
```

`seed.ts` creates `demo@example.com` / `DemoPassword123!`, an admin account, and one default model row matching `LLM_MODEL`. It does not create a target connection; the user adds the demo connection through the UI so the encryption path is exercised.

## 16. Free deployment strategies

### Option A — Vercel frontend + self-hosted API

Deploy the Vite frontend to Vercel; run the API and both Postgres instances on a small VPS or home server. Set `VITE_API_URL` and a strict `FRONTEND_ORIGIN`. This keeps user database credentials and LLM traffic inside infrastructure you control.

### Option B — Single self-hosted box

Run the frontend build, API, app Postgres, and demo Postgres with Docker Compose behind Caddy/Nginx. Use HTTPS, a firewall, and a non-root user. Do not expose the target database or Ollama port publicly.

### Option C — Free-tier API + managed app Postgres

Use a free-tier LLM and a managed Postgres for the app database, but remember that users' target databases may not be reachable from a serverless environment. This project is a better fit for a long-running API process than for serverless functions.

## 17. Phase 1 deliverables checklist

- [ ] Clean clone starts from the README.
- [ ] Auth works and protected routes reject missing/invalid tokens.
- [ ] Connections are per-user, encrypted, and never return passwords.
- [ ] Connection test reports success/failure and read-only status.
- [ ] New sessions require exactly one connection.
- [ ] Existing sessions reject connection changes.
- [ ] Table selection defaults to all non-system tables and is editable.
- [ ] Schema explorer shows columns, PK/FK, and comments.
- [ ] Relationship explorer shows direct FKs between selected tables.
- [ ] Schema questions answer from metadata.
- [ ] Data questions produce validated read-only SQL and result evidence.
- [ ] SQL outside the table scope is rejected.
- [ ] Read-only transaction, timeout, and row cap are tested.
- [ ] Evidence and turns persist and reload.
- [ ] Session history page and drawer list, open, and delete sessions.
- [ ] Target host guard blocks metadata/link-local hosts and supports `DB_ALLOWED_HOSTS`.
- [ ] LLM outage returns 503.
- [ ] Jest integration tests and one Playwright E2E pass.
- [ ] README, `.env.example`, demo SQL, and seed script exist.

## 18. README template

```markdown
# Database Knowledge Assistant

Connect a PostgreSQL database, pick tables, and ask questions. Answers come
from read-only SQL with the query and results visible, plus schema and
relationship exploration.

## Features
- per-user encrypted PostgreSQL connections
- one connection per chat session
- table scoping with schema explorer
- direct foreign-key relationship explorer
- session history page and drawer with delete
- natural-language data questions -> read-only SQL -> answer
- schema/attribute/relationship Q&A from metadata
- streamed answers with SQL/result evidence

## Stack
React + TypeScript + Vite, Node.js + Express + TypeScript, PostgreSQL,
OpenAI-compatible LLM (Groq/Gemini/OpenRouter/Ollama).

## Setup
1. npm install
2. docker compose up -d
3. apply apps/backend/schema.sql
4. cp .env.example .env and fill secrets
5. npm run seed -w apps/backend
6. npm run dev

## Tests
npm run typecheck
npm test
npm run test:e2e

## Security
Connect with a read-only PostgreSQL role. Target hosts are checked against
blocked link-local/cloud metadata ranges, with optional `DB_ALLOWED_HOSTS`.
This is an internal-tool MVP; see the security checklist before using
confidential data.
```

## 19. Estimated effort and difficulty

| Work item | Hours | Difficulty |
|---|---:|---|
| Repo, frontend/backend, Docker, app DB | 4–5 | Easy–Medium |
| Schema, auth, JWT | 3–4 | Medium |
| Connection CRUD + AES encryption | 4–5 | Medium–Hard |
| Connection test + pool management | 2–3 | Medium |
| Schema introspection + relationships | 4–5 | Medium–Hard |
| Session lifecycle + table scoping | 3–4 | Medium |
| SQL AST guard + read-only execution | 5–6 | Hard |
| NL-to-SQL planner + repair + answer synthesis | 5–6 | Hard |
| Frontend connection/session/schema UI | 6–8 | Medium–Hard |
| SQL/result panel + SSE status | 3–4 | Medium |
| Tests, E2E, README, seed, demo | 5–6 | Medium |
| **Total** | **44–56 hours** | **Medium–Hard** |

Main risks: SQL safety mistakes, schema context overflow, model hallucinating columns, and slow/expensive queries. Test against a real target database early; do not leave safety enforcement for the final day.

## 20. Next steps and demo talking points

Build in this order: (1) foundation and app DB, (2) auth, (3) LLM client, (4) encrypted connections, (5) introspection, (6) sessions and table scope, (7) SQL guard and execution, (8) NL-to-SQL and evidence, (9) UI, (10) tests and demo.

For interviews, emphasize:

- **Safety is the product.** The LLM proposes SQL; a read-only role, AST guard, transaction mode, timeout, row cap, and allowlist decide whether it runs.
- **One session, one connection.** This is a deliberate isolation boundary: evidence, prompts, and table scope cannot leak across databases.
- **Schema-aware, not just SQL-aware.** The assistant can answer relationship and attribute questions without querying data, and it shows the metadata it used.
- **Observable answers.** Every data answer exposes the SQL and rows, so trust is inspectable instead of assumed.
- **Follow-ups reuse context.** Prior SQL is included so “now only for 2024” refines the previous query instead of starting over.
- **No PDF pipeline.** There is no upload, extraction, chunking, embedding, or vector store; the interesting work is connection security and query validation.
- Be honest about the hardening still needed: credential vaulting, SSRF controls, query cancellation, and audit logging.

## 21. Further reading

- [PostgreSQL `information_schema`](https://www.postgresql.org/docs/current/information-schema.html)
- [PostgreSQL system catalogs](https://www.postgresql.org/docs/current/catalogs.html)
- [PostgreSQL `SET TRANSACTION`](https://www.postgresql.org/docs/current/sql-set-transaction.html)
- [PostgreSQL `CREATE ROLE`](https://www.postgresql.org/docs/current/sql-createrole.html)
- [node-postgres pool docs](https://node-postgres.com/apis/pool)
- [pgsql-ast-parser](https://github.com/oguimbal/pgsql-ast-parser)
- [Node.js crypto `createCipheriv`](https://nodejs.org/api/crypto.html#cryptocreatecipherivalgorithm-key-iv-options)
- [Vite guide](https://vite.dev/guide/)
- [Ollama](https://ollama.com/)
