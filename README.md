# Database Knowledge Assistant

Connect PostgreSQL, MySQL-compatible databases (including MariaDB and TiDB), SQL Server, SQLite, or MongoDB; choose the tables or collections the assistant may use; and ask questions in plain English. Answers include the generated SQL or MongoDB aggregation, result rows, and answer context.

## Status

Phase 1 is complete. The app covers authentication, encrypted database connections, schema introspection, session scope, streaming natural-language queries, query and schema evidence, and scope editing.

## Features

- Email/password authentication with JWT sessions.
- Encrypted connection secrets (AES-256-GCM); passwords and MongoDB URIs are never returned to the browser.
- PostgreSQL, MySQL/MariaDB/TiDB, SQL Server, SQLite, and MongoDB connections.
- Connection testing with engine-specific status and read-only guidance.
- Schema introspection for SQL tables and columns, plus sampled MongoDB collection fields.
- Sessions locked to one connection, with an explicit table scope.
- Streaming answers over SSE: plan, evidence, tokens, and a final saved turn.
- Per-question answer modes: Auto, Data, and Schema; clarification remains automatic when needed.
- Administrator-managed OpenAI-compatible provider/model configurations with encrypted API keys.
- Per-session model selection, including Auto mode with ordered failover for rate limits, quota errors, timeouts, and temporary provider failures before streaming begins.
- Data answers show generated SQL or MongoDB aggregation, result rows, execution time, truncation, and scope.
- Schema questions answer from metadata without running SQL. Schema evidence is labeled "Answer Context".
- Record-count comparisons run exact counts across the session's selected tables or collections.
- Relationship exploration from real foreign keys only.
- Session context drawer for table scope, schema refresh, and relationship review.
- Markdown answers, mobile layouts, and light/dark themes.

## Stack

- React 18 + TypeScript + Vite
- Node.js + Express + TypeScript
- PostgreSQL 16
- MySQL-compatible server, SQL Server, SQLite, or MongoDB for external target connections
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
  |     |-- engine-specific planner prompt
  |     |-- SQL / MongoDB query validation + scope allowlist
  |     |-- database-specific target adapter
  |     |-- answer stream
  |     `-- evidence persistence
  |
  |-- app PostgreSQL (users, connections, sessions, history)
  `-- target PostgreSQL / MySQL-compatible / SQL Server / SQLite / MongoDB
```

The LLM only proposes a plan. The server validates the engine-specific query, enforces the session's table/collection scope, executes it with a bounded result set, and persists evidence with the answer. Use database accounts with read-only privileges for network database engines; SQL Server and MongoDB rely on those account privileges in addition to query validation.

SQLite files must be on the API host, within `SQLITE_ALLOWED_DIR`, and no larger than `SQLITE_MAX_FILE_SIZE_MB`. SQLite questions execute against an in-memory copy, leaving the original file unchanged.
MongoDB queries use a restricted aggregation pipeline. Write stages, cross-collection lookup stages, and JavaScript-based operators are rejected.

## Prerequisites

- Node.js 20+
- npm 10+
- Docker with Compose
- An OpenAI-compatible LLM endpoint and API key for real answers

## Local setup

```bash
cp .env.example .env
npm install

npm run setup
```

`npm run setup` starts the Docker databases and waits until they are healthy, applies the app database schema, seeds the demo accounts and default model, then starts the API and frontend together. Set your LLM provider credentials in `.env` before running it if you want live model responses.

Docker services can also be managed individually with `npm run docker:up`, `npm run docker:down`, `npm run docker:ps`, and `npm run docker:logs`. Use `npm run db:setup` to reapply the app schema and seed data without restarting the application.

For an existing deployment, rerun `apps/backend/schema.sql` against the app database to add new columns, including answer-mode history and encrypted provider-key support, before restarting the API.

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

Administrators can configure OpenAI-compatible endpoints and model API keys under **AI providers** in the app. Keys are encrypted with `CONNECTION_ENCRYPTION_KEY` and are never returned to the browser. Choose **Auto** for a session to try the preferred configured model first and fall back to the remaining priority order. A manually selected model stays pinned to that option. Existing environment-based `LLM_BASE_URL`, `LLM_MODEL`, and `LLM_API_KEY` settings continue to serve as the default when no configured model is available.

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
- PostgreSQL queries run inside a read-only transaction; MySQL-compatible queries request a read-only transaction; SQLite runs against an in-memory copy. SQL Server and MongoDB should use read-only accounts.
- Engine-specific structural guards accept only one scoped, read-only SQL query or an allowlisted MongoDB aggregation.
- Every referenced table must be in the session's saved table scope.
- `pgsql-ast-parser` is used for structural validation, not string matching.
- Results are capped by `SQL_MAX_ROWS`; query execution has an engine-specific timeout bounded by `SQL_TIMEOUT_MS`. MySQL-compatible record-count comparisons use a dedicated 30-second query timeout by default because exact counts may scan large TiDB tables; configure `MYSQL_RECORD_COUNT_TIMEOUT_MS` to override it.
- MySQL-compatible connections use `MYSQL_CONNECT_TIMEOUT_MS` (15 seconds by default) and retry one transient connection timeout. `DB_CONNECT_TIMEOUT_MS` remains the fallback override.
- The planner can return `clarify` instead of guessing when a request is ambiguous.
- Database values and comments are treated as untrusted data in prompts.
- Server errors return a generic message; internal details are logged server-side.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run setup` | Start Docker databases, initialize and seed the app database, then run API and web app together |
| `npm run dev` | Run API and web app together |
| `npm run dev:api` | Run only the API |
| `npm run dev:web` | Run only the Vite app |
| `npm run docker:up` | Start Docker Compose services and wait for health checks |
| `npm run docker:down` | Stop Docker Compose services without removing database volumes |
| `npm run docker:ps` | Show Docker Compose service status |
| `npm run docker:logs` | Follow Docker Compose service logs |
| `npm run db:setup` | Apply the app database schema and seed demo data |
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

- SQL engines support one read-only SELECT per question; multi-statement and DDL queries are rejected.
- The MySQL-compatible adapter is intended for MySQL, MariaDB, and TiDB; verify behavior with the server versions and SQL features you deploy.
- SQL Server and MongoDB should use explicitly read-only database accounts; their servers do not share PostgreSQL's transaction-level read-only mode.
- MongoDB schema discovery infers fields from a small document sample, so fields absent from that sample may not appear in the session picker.
- SQLite is local to the API host and uses an in-memory copy; it is not intended for large database files.
- Relationships come from direct foreign keys only; they are not inferred from column names.
- A session's connection is immutable. Start a new session to switch databases.
- External databases are supported when the API can reach the host. There is no SSH tunnel or bastion support.
- SSRF protection blocks link-local/cloud metadata addresses and supports an optional `DB_ALLOWED_HOSTS` allowlist; DNS rebinding remains a residual risk.
- No RAG, document upload, embeddings, admin console, or usage dashboard in Phase 1.

## Troubleshooting

- **Port already in use**: stop the process on `4000` or `5173`; E2E uses separate ports `4100` and `5273`.
- **`ECONNREFUSED` from the browser**: the Vite dev server binds to `127.0.0.1`. Use `http://127.0.0.1:5173` or `http://localhost:5173`.
- **Connection test fails**: confirm `docker compose ps` is healthy and use `127.0.0.1:5435` for the PostgreSQL demo database. SQLite also requires `SQLITE_ALLOWED_DIR`.
- **A host is rejected**: link-local/cloud metadata addresses are blocked. Set `DB_ALLOWED_HOSTS` only when you want to restrict connections to specific hosts or CIDRs.
- **Answers fail with 503**: the LLM provider is missing or unreachable. Check `LLM_BASE_URL`, `LLM_API_KEY`, and the seeded model configuration.
- **Schema looks stale**: use Refresh schema in the session drawer, or lower `SQL_SCHEMA_CACHE_MS` for development.
- **E2E cannot start**: make sure the app database schema is applied and the Docker databases are healthy.
