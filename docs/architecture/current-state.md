# Current State — Database Knowledge Assistant

> This document describes the repository as it exists now. The [Roadmap & Developer Guide](../history/roadmap-and-developer-guide.md) and [Implementation Walkthrough](../history/implementation-walkthrough.md) are the original Phase 1 build narrative; where they disagree with this page, this page is authoritative.

## 1. Snapshot

| Area | Current implementation |
| --- | --- |
| Product scope | Authenticated database chat with schema-aware planning, read-only execution, evidence, and saved sessions |
| App database | PostgreSQL 16 (`database_knowledge_assistant`) |
| Target engines | PostgreSQL, MySQL / MariaDB / TiDB, MongoDB |
| Unsupported engines | SQL Server and SQLite are not supported |
| LLM integration | OpenAI-compatible chat completions, configured by env or the admin **AI providers** screen |
| Model selection | Per-session model, plus Auto mode with ordered failover |
| Answer modes | `auto`, `data`, `schema`; automatic `clarify` plans |
| Streaming | Server-Sent Events (`status`, `evidence`, `token`, `done`, `error`) |
| Frontend | React 18 + TypeScript + Vite |
| Backend | Node.js + Express + TypeScript |
| Tests | Jest + Supertest integration tests, Playwright E2E |
| App schema management | `apps/backend/schema.sql` applied directly; no migration framework |

## 2. Runtime topology

```text
Browser
  |
  | REST + SSE (JWT bearer token)
  v
Express API
  |-- auth / connections / conversations / models / questions
  |-- app PostgreSQL
  |     users, database_connections, conversations, qa_history, models, app_settings
  |-- target database adapters
  |     PostgreSQL: pg
  |     MySQL-compatible: mysql2
  |     MongoDB: mongodb
  `-- OpenAI-compatible LLM
        planner, repair, answer, failover
```

The browser never connects to a database directly. The API owns all database access, decrypts credentials, validates target queries, and persists evidence.

## 3. Backend components

| Component | Responsibility |
| --- | --- |
| `apps/backend/src/app.ts` | Express app, CORS/helmet/JSON, route mounting, global error mapping |
| `apps/backend/src/server.ts` | HTTP listener |
| `apps/backend/src/db.ts` | App PostgreSQL pool from `DATABASE_URL` |
| `apps/backend/src/middleware/auth.ts` | JWT verification, `requireAuth`, `requireAdmin` |
| `apps/backend/src/routes/auth.routes.ts` | Signup and login |
| `apps/backend/src/routes/connections.routes.ts` | Connection CRUD, test, schema |
| `apps/backend/src/routes/conversations.routes.ts` | Session CRUD, scope, model |
| `apps/backend/src/routes/questions.routes.ts` | Question orchestration and SSE |
| `apps/backend/src/routes/models.routes.ts` | Public model list and admin provider CRUD |
| `apps/backend/src/services/connectionCrypto.ts` | AES-256-GCM encryption for secrets |
| `apps/backend/src/services/connectionAccess.ts` | Ownership lookup, config conversion, schema dispatch |
| `apps/backend/src/services/connectionPool.ts` | PostgreSQL target test/pool lifecycle |
| `apps/backend/src/services/databaseAdapters.ts` | MySQL/MongoDB adapters, engine-specific validation, execution, introspection |
| `apps/backend/src/services/introspection.ts` | PostgreSQL schema introspection and cache |
| `apps/backend/src/services/sqlGuard.ts` | PostgreSQL AST validation and table references |
| `apps/backend/src/services/sqlExecution.ts` | Read-only PostgreSQL execution, row cap, timeout |
| `apps/backend/src/services/sessionScope.ts` | Selected-table normalization and validation |
| `apps/backend/src/services/hostGuard.ts` | SSRF/host allowlist checks |
| `apps/backend/src/services/agent.ts` | Planner/repair prompts, evidence builders, answer messages |
| `apps/backend/src/services/llm.ts` | OpenAI-compatible chat/stream client, timeouts, failover |
| `apps/backend/src/services/modelConfig.ts` | Resolve enabled models and decrypt provider keys |

## 4. Data model

The canonical schema is `apps/backend/schema.sql`. See [database documentation](../reference/databases/README.md) for full columns, constraints, and query locations.

| Table | Responsibility |
| --- | --- |
| `users` | Accounts and roles (`user`, `admin`) |
| `database_connections` | Encrypted target-connection metadata |
| `conversations` | Session, immutable connection, selected table scope, selected model |
| `qa_history` | Question, answer, evidence, model, answer mode |
| `models` | Provider/model registry, encrypted API keys, default/priority order |
| `app_settings` | Reserved key/value table; currently unused |

Important relationships:

- `database_connections.owner_id → users.id` with cascade.
- `conversations.user_id → users.id` with cascade.
- `conversations.connection_id → database_connections.id` with restrict.
- `qa_history.conversation_id → conversations.id` with cascade.
- `qa_history.user_id → users.id` with cascade.
- `conversations.model_id` is a soft reference; there is no foreign key to `models`.

## 5. API surface

Full details live in [docs/apis](../reference/api/README.md). Summary:

| Group | Endpoints |
| --- | --- |
| Health | `GET /api/health` |
| Auth | `POST /api/auth/signup`, `POST /api/auth/login` |
| Connections | `GET/POST /api/connections`, `GET/PATCH/DELETE /api/connections/:id`, `POST /api/connections/:id/test`, `GET /api/connections/:id/schema` |
| Conversations | `GET/POST /api/conversations`, `GET/PATCH/DELETE /api/conversations/:id` |
| Questions | `POST /api/questions` (SSE) |
| Models | `GET /api/models`, `GET /api/models/admin`, `POST /api/models`, `PUT/DELETE /api/models/:id` |

Implemented but unused by the frontend:

- `GET /api/health`
- `GET /api/connections/:id`

## 6. Target-engine behavior

| Engine | Introspection | Query form | Safety |
| --- | --- | --- | --- |
| PostgreSQL | `pg_class`, `pg_constraint`, `pg_attribute`, `pg_attrdef` | One read-only `SELECT` | AST validation, read-only transaction, `statement_timeout`, row cap |
| MySQL/MariaDB/TiDB | `information_schema` tables, columns, keys | One read-only `SELECT` or internal record-count operation | Dialect validation, read-only transaction request, timeout, row cap |
| MongoDB | `listCollections` plus sampled document fields | Allowlisted aggregation pipeline or `countDocuments` | Stage/operator allowlist, `maxTimeMS`, row and byte caps |

Schema snapshots are cached per connection. The TTL is `SQL_SCHEMA_CACHE_MS` (default 300000 ms). `?refresh=1` bypasses the cache. Connection updates and deletes invalidate cached pools, clients, and snapshots.

## 7. Question lifecycle

1. Validate `question`, `conversationId`, and `mode`.
2. Load the conversation and its owned connection.
3. Load or refresh the schema snapshot and validate the saved table scope.
4. Load the last six turns.
5. Resolve the session model or the Auto model chain.
6. Plan:
   - record-count questions use an exact count operation
   - `schema` mode answers from metadata
   - otherwise the LLM returns `data`, `schema`, or `clarify`
7. Validate the generated query against the engine and scope.
8. On validation failure, ask the LLM to repair once.
9. Stream `status`, then `evidence`, then answer `token`s.
10. Persist the turn and evidence in one transaction.
11. Stream `done` or an `error` event.

If the client disconnects, the upstream LLM request is aborted and the turn is not persisted.

## 8. Configuration

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | App PostgreSQL connection |
| `JWT_SECRET` | JWT signing secret |
| `CONNECTION_ENCRYPTION_KEY` | 32-byte key for AES-256-GCM secrets |
| `FRONTEND_ORIGIN` | CORS origin |
| `VITE_API_URL` | Optional browser API base; empty uses the Vite proxy |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_TIMEOUT_MS` | Default OpenAI-compatible provider |
| `SQL_MAX_ROWS` | Result row cap (default 100, hard cap 1000) |
| `SQL_TIMEOUT_MS` | Query timeout (default 5000, hard cap 60000) |
| `SQL_SCHEMA_CACHE_MS` | Schema cache TTL |
| `DB_CONNECT_TIMEOUT_MS` | Target connection timeout |
| `MYSQL_CONNECT_TIMEOUT_MS` | MySQL-compatible connection timeout |
| `MYSQL_RECORD_COUNT_TIMEOUT_MS` | MySQL-compatible record-count timeout |
| `DB_ALLOWED_HOSTS` | Optional target hostname/IP/CIDR allowlist |
| `MAX_CONNECTIONS_PER_USER` | Connection limit |
| `MAX_SELECTED_TABLES` | Session table-scope limit |

Provider/model settings can also be stored in the `models` table through the admin **AI providers** screen. Stored API keys are encrypted; environment values remain the fallback.

## 9. Tests and local lifecycle

| Layer | Behavior |
| --- | --- |
| Jest setup | Drops and recreates `database_knowledge_assistant_test`, then applies `schema.sql` |
| Backend integration tests | Use the real app test database and the real `demo_analytics` target database |
| LLM in tests | Mocked, except adapter/unit tests |
| Playwright E2E | Starts the LLM stub, API, and Vite app; seeds the app database; uses the normal `DATABASE_URL` |
| Demo target | `demo_analytics` on `localhost:5435`, initialized from `apps/backend/demo/target-schema.sql` |

Commands:

```bash
npm run typecheck
npm test
npm run test:e2e
npm run build
```

## 10. Deliberate gaps

These are not part of the current implementation:

- SQL Server and SQLite target support.
- RAG, document upload, embeddings, or vector search.
- CSV export, saved queries, query cancellation from the browser, or multi-hop join discovery.
- Sharing connections between users or workspace roles.
- Usage dashboards, audit events, or rate limiting.
- Deployment automation, HTTPS termination, or cookie-based auth.

## 11. Where to read next

- [API reference](../reference/api/README.md)
- [Database reference](../reference/databases/README.md)
- [Roadmap & Developer Guide](../history/roadmap-and-developer-guide.md)
- [Implementation Walkthrough](../history/implementation-walkthrough.md)
- [Concepts index](../concepts/README.md)
- [Multi-engine adapters](../concepts/14-multi-engine-adapters.md)
- [Provider registry and failover](../concepts/15-provider-registry-and-failover.md)
- [Schema evolution](../concepts/16-schema-evolution.md)
- [Setup, seed, and E2E lifecycle](../concepts/17-setup-seed-e2e.md)
