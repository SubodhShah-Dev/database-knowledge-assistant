# Database Knowledge Assistant

Connect PostgreSQL, MySQL-compatible databases (including MariaDB and TiDB), or MongoDB; choose the tables or collections the assistant may use; and ask questions in plain English. Answers include the generated SQL or MongoDB aggregation, result rows, and answer context.

## Status

Phase 1 is complete. The current implementation also includes multi-engine targets, MongoDB, administrator-managed providers, and per-session model selection. See [Current State](docs/architecture/current-state.md) for the authoritative implementation snapshot.

## Documentation

Full documentation lives in [`docs/`](docs/README.md). Start with the [getting-started guide](docs/getting-started/README.md), check the [current state](docs/architecture/current-state.md), or look up the [API](docs/reference/api/README.md) and [database](docs/reference/databases/README.md) references.

## Features

- Email/password authentication with JWT sessions stored in `HttpOnly` `SameSite=Strict` cookies (Bearer `Authorization` header also accepted).
- Envelope-encrypted connection secrets: each secret gets a random per-secret data-encryption key wrapped by the `CONNECTION_ENCRYPTION_KEY` key-encrypting key. Passwords, MongoDB URIs, and provider API keys are never returned to the browser.
- Credential recovery via `CONNECTION_RECOVERY_PASSPHRASE`: a backup of the key-encrypting key is wrapped by a key derived from this passphrase and stored in the `recovery_keys` table, so all credentials can be recovered if `CONNECTION_ENCRYPTION_KEY` is lost.
- PostgreSQL, MySQL/MariaDB/TiDB, and MongoDB connections.
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
- MySQL-compatible server or MongoDB for external target connections
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
   |-- auth / connections / conversations / models / recovery
   |-- question orchestration
  |     |-- engine-specific planner prompt
  |     |-- SQL / MongoDB query validation + scope allowlist
  |     |-- database-specific target adapter
  |     |-- answer stream
  |     `-- evidence persistence
  |
  |-- app PostgreSQL (users, connections, sessions, history)
  `-- target PostgreSQL / MySQL-compatible / MongoDB
```

The LLM only proposes a plan. The server validates the engine-specific query, enforces the session's table/collection scope, executes it with a bounded result set, and persists evidence with the answer. Use database accounts with read-only privileges for all target databases. PostgreSQL and MySQL-compatible connections also request read-only transactions; MongoDB relies on account privileges.

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

Before running, set at least `JWT_SECRET`, `CONNECTION_ENCRYPTION_KEY`,
`CONNECTION_RECOVERY_PASSPHRASE`, and `LLM_API_KEY` in `.env`. `npm run setup`
starts the databases, applies the schema, seeds demo data, and runs the API and
web app together. Open `http://localhost:5173`; the API listens on
`http://localhost:4000`.

Back up `CONNECTION_ENCRYPTION_KEY` and `CONNECTION_RECOVERY_PASSPHRASE` offline,
separate from the repository. Losing both makes all stored credentials unrecoverable.

See [Quickstart](docs/getting-started/quickstart.md),
[Local setup](docs/getting-started/local-setup.md), and the
[Configuration reference](docs/reference/configuration.md) for details.

## Demo data

The compose stack includes `demo_analytics` on port `5435`. Connect with
`demo_reader` / `demo_reader_password`. See
[Demo data](docs/getting-started/demo-data.md) for the full connection and the
[Database reference](docs/reference/databases/README.md) for its schema.

## Safety model

- Credentials are envelope-encrypted before storage and decrypted only inside the API. Each secret uses a random per-secret data key wrapped by `CONNECTION_ENCRYPTION_KEY`.
- `CONNECTION_RECOVERY_PASSPHRASE` wraps a backup of the key-encrypting key stored in `recovery_keys`, enabling recovery of all credentials if `CONNECTION_ENCRYPTION_KEY` is lost.
- Key rotation: bump `CONNECTION_ENCRYPTION_KEY_VERSION` and provide the new `CONNECTION_ENCRYPTION_KEY`; wrapped data keys are re-wrapped without re-encrypting plaintext.
- Target hosts are checked against blocked link-local/cloud metadata ranges, with optional `DB_ALLOWED_HOSTS` allowlisting.
- PostgreSQL queries run inside a read-only transaction; MySQL-compatible queries request a read-only transaction; MongoDB relies on read-only account privileges.
- Engine-specific structural guards accept only one scoped, read-only SQL query or an allowlisted MongoDB aggregation.
- Every referenced table must be in the session's saved table scope.
- `pgsql-ast-parser` is used for structural validation, not string matching.
- Results are capped by `SQL_MAX_ROWS`; query execution has an engine-specific timeout bounded by `SQL_TIMEOUT_MS`. MySQL-compatible record-count comparisons use a dedicated 30-second query timeout by default because exact counts may scan large TiDB tables; configure `MYSQL_RECORD_COUNT_TIMEOUT_MS` to override it.
- MySQL-compatible connections use `MYSQL_CONNECT_TIMEOUT_MS` (15 seconds by default) and retry one transient connection timeout. `DB_CONNECT_TIMEOUT_MS` remains the fallback override.
- The planner can return `clarify` instead of guessing when a request is ambiguous.
- Database values and comments are treated as untrusted data in prompts.
- Server errors return a generic message; internal details are logged server-side.

## Scripts

| Command                        | Purpose                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `npm run setup`                | Start Docker databases, initialize and seed the app database, then run API and web app together |
| `npm run dev`                  | Run API and web app together                                                                    |
| `npm run dev:api`              | Run only the API                                                                                |
| `npm run dev:web`              | Run only the Vite app                                                                           |
| `npm run docker:up`            | Start Docker Compose services and wait for health checks                                        |
| `npm run docker:down`          | Stop Docker Compose services without removing database volumes                                  |
| `npm run docker:ps`            | Show Docker Compose service status                                                              |
| `npm run docker:logs`          | Follow Docker Compose service logs                                                              |
| `npm run db:setup`             | Apply the app database schema and seed demo data                                                |
| `npm run typecheck`            | Typecheck both workspaces                                                                       |
| `npm test`                     | Backend Jest/Supertest suite                                                                    |
| `npm run test:e2e`             | Playwright browser journey                                                                      |
| `npm run build`                | Build backend and frontend                                                                      |
| `npm run seed -w apps/backend` | Seed demo users and the default model                                                           |

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

The Playwright suite currently covers signing in, opening the connection dialog, switching database types, creating a PostgreSQL connection, testing it, and editing a connection. The seeded demo account and demo database remain available for manual end-to-end exploration.

The E2E run temporarily points the seeded default model at the local stub and restores the `.env` model configuration during teardown. It expects the Docker databases and app schema from the setup steps to exist.

## API overview

Full request/response details, responsibilities, and client call sites live in [docs/reference/api/README.md](docs/reference/api/README.md).

| Method             | Path                          | Purpose                                           |
| ------------------ | ----------------------------- | ------------------------------------------------- |
| `GET`              | `/api/health`                 | Liveness check                                    |
| `POST`             | `/api/auth/signup`            | Create an account                                 |
| `POST`             | `/api/auth/login`             | Sign in                                           |
| `GET`              | `/api/models`                 | List enabled answer models                        |
| `GET`              | `/api/models/admin`           | List provider configurations (admin)              |
| `POST`             | `/api/models`                 | Create a provider configuration (admin)           |
| `PUT/DELETE`       | `/api/models/:id`             | Update or delete a provider configuration (admin) |
| `GET/POST`         | `/api/connections`            | List or create connections                        |
| `GET/PATCH/DELETE` | `/api/connections/:id`        | Read, update, or delete a connection              |
| `POST`             | `/api/connections/:id/test`   | Test connectivity                                 |
| `GET`              | `/api/connections/:id/schema` | Read the cached schema                            |
| `GET/POST`         | `/api/conversations`          | List or create sessions                           |
| `GET/PATCH/DELETE` | `/api/conversations/:id`      | Read, edit scope/title/model, or delete           |
| `POST`             | `/api/questions`              | Ask a question; responds with SSE                 |
| `GET`              | `/api/recovery/status`        | Recovery configuration and record status          |
| `POST`             | `/api/recovery/setup`         | Create a recovery record (admin)                  |
| `POST`             | `/api/recovery/validate`      | Validate a recovery passphrase                    |
| `POST`             | `/api/recovery/rotate`        | Rotate the recovery passphrase (admin)            |

SSE event order is `status` -> `evidence` -> `token`\* -> `done`. Errors after the stream starts arrive as `error` events; validation and provider failures before the stream return JSON.

Database schemas, query locations, and the demo dataset are documented in [docs/reference/databases/README.md](docs/reference/databases/README.md). The original build narrative lives in the [Roadmap & Developer Guide](docs/history/roadmap-and-developer-guide.md) and [Implementation Walkthrough](docs/history/implementation-walkthrough.md).

## Project structure

```text
apps/
  backend/
    src/routes/          auth, connections, conversations, models, questions, recovery
    src/services/        agent, LLM, SQL guard, execution, introspection, crypto, key recovery
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
- MongoDB should use an explicitly read-only database account; it does not use PostgreSQL's transaction-level read-only mode.
- MongoDB schema discovery infers fields from a small document sample, so fields absent from that sample may not appear in the session picker.
- SQL Server and SQLite are not supported target engines.
- Relationships come from direct foreign keys only; they are not inferred from column names.
- A session's connection is immutable. Start a new session to switch databases.
- External databases are supported when the API can reach the host. There is no SSH tunnel or bastion support.
- SSRF protection blocks link-local/cloud metadata addresses and supports an optional `DB_ALLOWED_HOSTS` allowlist; DNS rebinding remains a residual risk.
- `CONNECTION_RECOVERY_PASSPHRASE` is required at startup in production. Back up both `CONNECTION_ENCRYPTION_KEY` and `CONNECTION_RECOVERY_PASSPHRASE` offline; losing `CONNECTION_ENCRYPTION_KEY` without a recovery record makes all stored credentials unrecoverable.
- No RAG, document upload, embeddings, or usage dashboard. Provider/model administration is available under **AI providers**.

## Deployment

Deploy the SPA to Vercel, the API to Render, and PostgreSQL to Neon. The full
runbook is in the [deployment guide](docs/guides/deployment.md); variables and
defaults are in the [configuration reference](docs/reference/configuration.md).

Quick outline:

1. Push to GitHub.
2. Create a Neon PostgreSQL project and apply `apps/backend/schema.sql`.
3. Create a Render Blueprint from the repo; it reads `render.yaml` and deploys
   `apps/backend`. Fill the secrets from `.env.production.example` and set
   `DATABASE_URL` (Neon pooled URL) and `FRONTEND_ORIGIN`.
4. Deploy `apps/frontend` to Vercel with `VITE_API_URL` pointing at the API.
5. Set `FRONTEND_ORIGIN` to the Vercel URL and redeploy the API.

Render's free web service sleeps after 15 minutes idle and takes about a minute to
wake; use a paid instance for an always-on API. Railway new signups are currently
paused, so Render is the only configured API host.

**Back up** `CONNECTION_ENCRYPTION_KEY` and `CONNECTION_RECOVERY_PASSPHRASE` offline.
Without both, stored credentials are unrecoverable if the encryption key is lost.

## Troubleshooting

- **Port already in use**: stop the process on `4000` or `5173`; E2E uses separate ports `4100` and `5273`.
- **`ECONNREFUSED` from the browser**: the Vite dev server binds to `127.0.0.1`. Use `http://127.0.0.1:5173` or `http://localhost:5173`.
- **Connection test fails**: confirm `docker compose ps` is healthy and use `127.0.0.1:5435` for the PostgreSQL demo database.
- **A host is rejected**: link-local/cloud metadata addresses are blocked. Set `DB_ALLOWED_HOSTS` only when you want to restrict connections to specific hosts or CIDRs.
- **Answers fail with 503**: the LLM provider is missing or unreachable. Check `LLM_BASE_URL`, `LLM_API_KEY`, and the seeded model configuration.
- **Schema looks stale**: use Refresh schema in the session drawer, or lower `SQL_SCHEMA_CACHE_MS` for development.
- **E2E cannot start**: make sure the app database schema is applied and the Docker databases are healthy.
- **Recovering credentials if `CONNECTION_ENCRYPTION_KEY` is lost**: supply `CONNECTION_RECOVERY_PASSPHRASE` and use `POST /api/recovery/validate` to confirm it unlocks the stored wrapped key, then restart the API so the recovered key-encrypting key can decrypt all connection passwords, MongoDB URIs, and provider API keys. Without a recovery record and passphrase, credentials are unrecoverable.
