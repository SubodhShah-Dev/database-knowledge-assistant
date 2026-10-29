# Database Knowledge Assistant

Connect a PostgreSQL database, choose the tables the assistant may use, and ask questions in plain English. Every answer is grounded in read-only SQL with the generated query, returned rows, and schema context visible in the UI.

## Status

Phase 1 is complete. The app covers authentication, encrypted database connections, schema introspection, session table scope, streaming NL-to-SQL answers, SQL and schema evidence, and scope editing.

## Features

- Email/password authentication with JWT sessions.
- Encrypted PostgreSQL credentials (AES-256-GCM); passwords are never returned to the browser.
- Connection testing with a read-only warning when the role can write.
- Schema introspection with tables, columns, primary keys, foreign keys, comments, and estimated row counts.
- Sessions locked to one connection, with an explicit table scope.
- Streaming answers over SSE: plan, evidence, tokens, and a final saved turn.
- Data answers show generated SQL, result rows, execution time, truncation, and referenced tables.
- Schema questions answer from metadata without running SQL.
- Relationship exploration from real foreign keys only.
- Session context drawer for table scope, schema refresh, and relationship review.
- Markdown answers, mobile layouts, and light/dark themes.

## Stack

- React 18 + TypeScript + Vite
- Node.js + Express + TypeScript
- PostgreSQL 16
- OpenAI-compatible LLM API
- Jest + Supertest for backend tests
- Playwright for the browser journey

## Architecture

```text
Browser
  |
  |  REST + SSE
  v
Express API
  |-- auth / connections / conversations / models
  |-- question orchestration
  |     |-- planner prompt
  |     |-- SQL AST validation + table allowlist
  |     |-- read-only target query
  |     |-- answer stream
  |     `-- evidence persistence
  |
  |-- app PostgreSQL (users, connections, sessions, history)
  `-- target PostgreSQL (customer database, read-only role)
```

The LLM only proposes a plan. The server validates the SQL, runs it in a read-only transaction against the target database, and persists the evidence with the answer.

## Prerequisites

- Node.js 20+
- npm 10+
- Docker with Compose
- An OpenAI-compatible LLM endpoint and API key for real answers

## Local setup

```bash
cp .env.example .env
npm install

docker compose up -d
docker compose exec -T app-postgres psql -U app_user -d database_knowledge_assistant < apps/backend/schema.sql

npm run seed -w apps/backend
npm run dev
```

Open `http://localhost:5173`. The API listens on `http://localhost:4000`.

The demo target database is initialized from `apps/backend/demo/target-schema.sql` the first time the `demo-postgres` volume is created.

### Required environment

At minimum, set these in `.env`:

```bash
JWT_SECRET=replace_with_a_strong_secret
CONNECTION_ENCRYPTION_KEY=<32-byte base64 or hex key>
LLM_API_KEY=<provider key>
```

Generate an encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

See `.env.example` for every setting, including model, SQL row/timeout limits, schema cache, and connection limits.

## Demo data

The compose stack exposes two databases:

| Service | Host port | Database | Role |
| --- | --- | --- | --- |
| `app-postgres` | `5434` | `database_knowledge_assistant` | `app_user` |
| `demo-postgres` | `5435` | `demo_analytics` | `demo_admin` |

Use this connection in the UI:

```text
Name:     Demo Analytics
Host:     127.0.0.1
Port:     5435
Database: demo_analytics
User:     demo_reader
Password: demo_reader_password
SSL:      disable
```

Seeded app users:

| User | Password | Role |
| --- | --- | --- |
| `demo@example.com` | `DemoPassword123!` | user |
| `admin@example.com` | `AdminPassword123!` | admin |

The demo target contains `customers`, `products`, `orders`, and `order_items` with foreign keys and sample rows.

## Safety model

- Credentials are encrypted before storage and decrypted only inside the API.
- Target hosts are checked against blocked link-local/cloud metadata ranges, with optional `DB_ALLOWED_HOSTS` allowlisting.
- Target queries run as the saved role inside `BEGIN TRANSACTION READ ONLY`.
- The SQL guard accepts exactly one `SELECT`, CTE, or `UNION` statement.
- Every referenced table must be in the session's saved table scope.
- `pgsql-ast-parser` is used for structural validation, not string matching.
- Results are capped by `SQL_MAX_ROWS`; queries are cancelled after `SQL_TIMEOUT_MS`.
- The planner can return `clarify` instead of guessing when a request is ambiguous.
- Database values and comments are treated as untrusted data in prompts.
- Server errors return a generic message; internal details are logged server-side.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run API and web app together |
| `npm run dev:api` | Run only the API |
| `npm run dev:web` | Run only the Vite app |
| `npm run typecheck` | Typecheck both workspaces |
| `npm test` | Backend Jest/Supertest suite |
| `npm run test:e2e` | Playwright browser journey |
| `npm run build` | Build backend and frontend |
| `npm run seed -w apps/backend` | Seed demo users and the default model |

## Tests

```bash
npm run typecheck
npm test
npm run test:e2e
npm run build
```

`npm test` runs the backend integration suite against the real app and demo databases with the LLM mocked. It covers auth, ownership, connection encryption, session scope, SQL validation, read-only execution, row caps, timeouts, SSE error paths, and persistence.

`npm run test:e2e` starts an isolated stack:

- LLM stub: `http://127.0.0.1:4010`
- API: `http://127.0.0.1:4100`
- Web: `http://127.0.0.1:5273`

The Playwright journey signs up a fresh user, adds and tests the demo connection, starts a session, asks a data question and a schema question, verifies SQL/schema evidence, reloads to prove persistence, edits the table scope, exercises an LLM outage and retry, browses and deletes the session from history, checks the mobile layout, and signs out.

The E2E run temporarily points the seeded default model at the local stub and restores the `.env` model configuration during teardown. It expects the Docker databases and app schema from the setup steps to exist.

## API overview

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/signup` | Create an account |
| `POST` | `/api/auth/login` | Sign in |
| `GET` | `/api/models` | List enabled answer models |
| `GET/POST` | `/api/connections` | List or create connections |
| `PATCH/DELETE` | `/api/connections/:id` | Update or delete a connection |
| `POST` | `/api/connections/:id/test` | Test connectivity |
| `GET` | `/api/connections/:id/schema` | Read the cached schema |
| `GET/POST` | `/api/conversations` | List or create sessions |
| `GET/PATCH/DELETE` | `/api/conversations/:id` | Read, edit scope/title/model, or delete |
| `POST` | `/api/questions` | Ask a question; responds with SSE |

SSE event order is `status` -> `evidence` -> `token`* -> `done`. Errors after the stream starts arrive as `error` events; validation and provider failures before the stream return JSON.

## Project structure

```text
apps/
  backend/
    src/routes/          auth, connections, conversations, models, questions
    src/services/        agent, LLM, SQL guard, execution, introspection, crypto
    demo/                demo target schema and seed data
    schema.sql           app database schema
    test/                Jest integration tests
  frontend/
    src/pages/           login, connections, history, new session, chat
    src/components/      shell, forms, table picker, evidence, drawers, markdown
    src/api/             REST client and SSE parser
    e2e/                 Playwright journey and deterministic LLM stub
```

## Limitations

- PostgreSQL only.
- One statement per question; no multi-statement or DDL support.
- Relationships come from direct foreign keys only; they are not inferred from column names.
- A session's connection is immutable. Start a new session to switch databases.
- External PostgreSQL is supported when the API can reach the host. There is no SSH tunnel or bastion support.
- SSRF protection blocks link-local/cloud metadata addresses and supports an optional `DB_ALLOWED_HOSTS` allowlist; DNS rebinding remains a residual risk.
- No RAG, document upload, embeddings, admin console, or usage dashboard in Phase 1.

## Troubleshooting

- **Port already in use**: stop the process on `4000` or `5173`; E2E uses separate ports `4100` and `5273`.
- **`ECONNREFUSED` from the browser**: the Vite dev server binds to `127.0.0.1`. Use `http://127.0.0.1:5173` or `http://localhost:5173`.
- **Connection test fails**: confirm `docker compose ps` is healthy and use `127.0.0.1:5435` for the demo database.
- **A host is rejected**: link-local/cloud metadata addresses are blocked. Set `DB_ALLOWED_HOSTS` only when you want to restrict connections to specific hosts or CIDRs.
- **Answers fail with 503**: the LLM provider is missing or unreachable. Check `LLM_BASE_URL`, `LLM_API_KEY`, and the seeded model configuration.
- **Schema looks stale**: use Refresh schema in the session drawer, or lower `SQL_SCHEMA_CACHE_MS` for development.
- **E2E cannot start**: make sure the app database schema is applied and the Docker databases are healthy.
