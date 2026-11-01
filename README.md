# Database Knowledge Assistant

Connect PostgreSQL, MySQL-compatible databases (including MariaDB and TiDB), or MongoDB; choose the tables or collections the assistant may use; and ask questions in plain English. Answers include the generated SQL or MongoDB aggregation, result rows, and answer context.

## Status

Phase 1 is complete. The current implementation also includes multi-engine targets, MongoDB, administrator-managed providers, and per-session model selection. See [Current State](docs/database-knowledge-assistant/CURRENT_STATE.md) for the authoritative implementation snapshot.

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

`npm run setup` starts the Docker databases and waits until they are healthy, applies the app database schema, seeds the demo accounts and default model, then starts the API and frontend together. Set your LLM provider credentials in `.env` before running it if you want live model responses.

Docker services can also be managed individually with `npm run docker:up`, `npm run docker:down`, `npm run docker:ps`, and `npm run docker:logs`. Use `npm run db:setup` to reapply the app schema and seed data without restarting the application.

For an existing deployment, rerun `apps/backend/schema.sql` against the app database to add new columns, including answer-mode history and encrypted provider-key support, before restarting the API.

Open `http://localhost:5173`. The API listens on `http://localhost:4000`.

The demo target database is initialized from `apps/backend/demo/target-schema.sql` the first time the `demo-postgres` volume is created.

### Required environment

At minimum, set these in `.env`:

```bash
JWT_SECRET=<32+ character random secret>
CONNECTION_ENCRYPTION_KEY=<32-byte base64 or hex key>
CONNECTION_RECOVERY_PASSPHRASE=<recovery passphrase, 12+ chars, required in production>
LLM_API_KEY=<provider key>
```

Generate an encryption key and recovery passphrase:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

- `CONNECTION_ENCRYPTION_KEY` encrypts connection passwords, MongoDB URIs, and provider API keys. Back it up offline, separate from the app database and repository.
- `CONNECTION_RECOVERY_PASSPHRASE` wraps a backup of the key-encrypting key stored in the `recovery_keys` table. If `CONNECTION_ENCRYPTION_KEY` is lost, supply this passphrase to recover all credentials. Back it up offline as well.
- `CONNECTION_ENCRYPTION_KEY_VERSION` (optional, defaults to `1`) tracks the key-encrypting key version for rotation. Bump it when rotating `CONNECTION_ENCRYPTION_KEY`; existing wrapped data keys are re-wrapped under the new version without re-encrypting plaintext.

See `.env.example` for every setting, including model, SQL row/timeout limits, schema cache, and connection limits.

Administrators can configure OpenAI-compatible endpoints and model API keys under **AI providers** in the app. Keys are envelope-encrypted with `CONNECTION_ENCRYPTION_KEY` (wrapped per-secret data key) and are never returned to the browser.

**Key rotation:** bump `CONNECTION_ENCRYPTION_KEY_VERSION` and provide the new `CONNECTION_ENCRYPTION_KEY`; all stored data-encryption keys are re-wrapped under the new version without re-encrypting the underlying secrets.

**Key loss recovery:** if `CONNECTION_ENCRYPTION_KEY` is lost, configure `CONNECTION_RECOVERY_PASSPHRASE` and use `POST /api/recovery/setup` (admin) to store a wrapped backup of the key-encrypting key. Then, if the key is lost, supply the recovery passphrase to unwrap the backup and decrypt all credentials. Back up both values offline, separate from the app database and repository.

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

The Playwright suite currently covers signing in, opening the connection dialog, switching database types, creating a PostgreSQL connection, testing it, and editing a connection. The seeded demo account and demo database remain available for manual end-to-end exploration.

The E2E run temporarily points the seeded default model at the local stub and restores the `.env` model configuration during teardown. It expects the Docker databases and app schema from the setup steps to exist.

## API overview

Full request/response details, responsibilities, and client call sites live in [docs/apis/README.md](docs/apis/README.md).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness check |
| `POST` | `/api/auth/signup` | Create an account |
| `POST` | `/api/auth/login` | Sign in |
| `GET` | `/api/models` | List enabled answer models |
| `GET` | `/api/models/admin` | List provider configurations (admin) |
| `POST` | `/api/models` | Create a provider configuration (admin) |
| `PUT/DELETE` | `/api/models/:id` | Update or delete a provider configuration (admin) |
| `GET/POST` | `/api/connections` | List or create connections |
| `GET/PATCH/DELETE` | `/api/connections/:id` | Read, update, or delete a connection |
| `POST` | `/api/connections/:id/test` | Test connectivity |
| `GET` | `/api/connections/:id/schema` | Read the cached schema |
| `GET/POST` | `/api/conversations` | List or create sessions |
| `GET/PATCH/DELETE` | `/api/conversations/:id` | Read, edit scope/title/model, or delete |
| `POST` | `/api/questions` | Ask a question; responds with SSE |
| `GET` | `/api/recovery/status` | Recovery configuration and record status |
| `POST` | `/api/recovery/setup` | Create a recovery record (admin) |
| `POST` | `/api/recovery/validate` | Validate a recovery passphrase |
| `POST` | `/api/recovery/rotate` | Rotate the recovery passphrase (admin) |

SSE event order is `status` -> `evidence` -> `token`* -> `done`. Errors after the stream starts arrive as `error` events; validation and provider failures before the stream return JSON.

Database schemas, query locations, and the demo dataset are documented in [docs/databases/README.md](docs/databases/README.md). The original build narrative lives in the [Roadmap & Developer Guide](docs/database-knowledge-assistant/Database%20Knowledge%20Assistant%20%E2%80%94%20Roadmap%20&%20Developer%20Guide.md) and [Implementation Walkthrough](docs/database-knowledge-assistant/Implementation_Walkthrough.md).

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

## Deployment (Free Tier)

### Recommended Stack

| Component | Platform | Free Tier |
|-----------|----------|-----------|
| Frontend | **Vercel** | Unlimited personal projects, custom domains, SSL |
| Backend | **Railway** | $5/month credit (covers small apps) or **Render** (750 hrs/mo) |
| Database | **Neon** | 0.5 GB Postgres, branching, autoscaling |
| LLM | **Groq** | Free tier: 14,400 req/day |

### Quick Deploy

1. **Push to GitHub** (private repo recommended)

2. **Neon Database**
   - Create project at [neon.tech](https://neon.tech)
   - Copy connection string (with `?sslmode=require`)
   - Run `apps/backend/schema.sql` in Neon SQL editor

3. **Railway Backend**
   - New Project → GitHub Repo → Select `apps/backend` folder
   - Add environment variables from `.env.production.example`
   - Set `DATABASE_URL` to Neon connection string
   - Set `FRONTEND_ORIGIN` to your Vercel URL (after step 4)
   - Deploy → get backend URL (e.g., `https://your-app.railway.app`)

4. **Vercel Frontend**
   - Import GitHub repo → Select `apps/frontend` folder
   - Add Environment Variable: `VITE_API_URL=https://your-backend.railway.app`
   - Deploy → get frontend URL (e.g., `https://your-app.vercel.app`)

5. **Update CORS**
   - In Railway backend env vars: set `FRONTEND_ORIGIN=https://your-app.vercel.app`
   - Redeploy backend

### Environment Variables

See `.env.production.example` for all required production variables. **Never commit real secrets.**

Generate secrets locally:
```bash
# JWT_SECRET (32+ chars)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# CONNECTION_ENCRYPTION_KEY (32 bytes base64)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# CONNECTION_RECOVERY_PASSPHRASE (12+ chars, back up OFFLINE)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### Key Backup (Critical)

- `CONNECTION_ENCRYPTION_KEY` + `CONNECTION_RECOVERY_PASSPHRASE` → **store offline** (password manager, encrypted USB)
- Without both, **all stored credentials are unrecoverable** if the encryption key is lost
- Use `POST /api/recovery/setup` (admin) to create a recovery record after deployment

## Troubleshooting

- **Port already in use**: stop the process on `4000` or `5173`; E2E uses separate ports `4100` and `5273`.
- **`ECONNREFUSED` from the browser**: the Vite dev server binds to `127.0.0.1`. Use `http://127.0.0.1:5173` or `http://localhost:5173`.
- **Connection test fails**: confirm `docker compose ps` is healthy and use `127.0.0.1:5435` for the PostgreSQL demo database.
- **A host is rejected**: link-local/cloud metadata addresses are blocked. Set `DB_ALLOWED_HOSTS` only when you want to restrict connections to specific hosts or CIDRs.
- **Answers fail with 503**: the LLM provider is missing or unreachable. Check `LLM_BASE_URL`, `LLM_API_KEY`, and the seeded model configuration.
- **Schema looks stale**: use Refresh schema in the session drawer, or lower `SQL_SCHEMA_CACHE_MS` for development.
- **E2E cannot start**: make sure the app database schema is applied and the Docker databases are healthy.
- **Recovering credentials if `CONNECTION_ENCRYPTION_KEY` is lost**: supply `CONNECTION_RECOVERY_PASSPHRASE` and use `POST /api/recovery/validate` to confirm it unlocks the stored wrapped key, then restart the API so the recovered key-encrypting key can decrypt all connection passwords, MongoDB URIs, and provider API keys. Without a recovery record and passphrase, credentials are unrecoverable.
