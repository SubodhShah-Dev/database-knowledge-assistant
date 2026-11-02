# 03 — Docker, Postgres & environment

> Two Postgres containers, schema as code, a read-only demo role, and one root `.env` — plus the CWD gotcha that can break all of it at once.

**Back to:** [Implementation Walkthrough — Step 0](../history/implementation-walkthrough.md#1-step-0--repository-foundation) · [Concept index](../history/implementation-walkthrough.md#concept-index)

> **Current implementation note:** the compose stack still runs two PostgreSQL 16 containers. The **demo target remains PostgreSQL** even though the app can connect to MySQL/MariaDB/TiDB and MongoDB. SQLite and SQL Server support has been removed; the schema's legacy cleanup block is intentional.

## What it is

- **Docker Compose** runs two PostgreSQL instances: the **app database** (users, connections, sessions, evidence) and a **demo target database** that the app queries like a user-supplied database.
- **Schema as code** (`schema.sql` and `demo/target-schema.sql`) is the single source of truth. Apply it identically to dev and test databases.
- **A read-only role** demonstrates the connection model the product expects: the app should query with a role that cannot write.
- **Environment configuration** keeps secrets and machine-specific values out of code. `.env` is gitignored; `.env.example` documents the shape.

**Prerequisites:** [01 — Monorepo & tooling](01-monorepo-tooling.md) (root scripts reference compose). Docker installed and running.

## Why this project uses it

- "A clean clone can start by following the README" fails immediately if everyone's Postgres version or role grants drift.
- The test suite needs its **own app database** that it can drop and recreate freely.
- The product's central claim is safe read-only access. If the demo target role can write, the demo does not prove the claim.
- Two containers keep the app's own schema mentally separate from a user's data. Mixing them invites accidental queries against `users` or `qa_history`.

## When to use this pattern

- Any app that stores its own state and queries a second, user-owned data source.
- Any project where the safety model depends on database role grants.
- For a single-database app, one container and one schema file are enough.

## How it works here

### `docker-compose.yml`

```yaml
services:
  app-postgres:
    image: postgres:16-alpine
    restart: unless-stopped
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
    restart: unless-stopped
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

Port mapping matters: `5434` is the app database; `5435` is the demo target. The user adds the demo connection with port `5435`, so the app cannot accidentally use its own `DATABASE_URL` as the target.

### Applying the app schema

```bash
# stream through the container (no local psql needed)
docker compose exec -T app-postgres psql -U app_user -d database_knowledge_assistant \
  < apps/backend/schema.sql

# or with local psql
psql "postgres://app_user:local_dev_password@localhost:5434/database_knowledge_assistant" \
  -f apps/backend/schema.sql
```

The schema is idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`) so applying it twice is safe during development.

### The demo target and read-only role

`apps/backend/demo/target-schema.sql` creates sample tables and a reader role:

```sql
CREATE ROLE demo_reader LOGIN PASSWORD 'demo_reader_password';
GRANT CONNECT ON DATABASE demo_analytics TO demo_reader;
GRANT USAGE ON SCHEMA public TO demo_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO demo_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO demo_reader;
```

What each grant does:

- `CONNECT` allows a connection to the database.
- `USAGE ON SCHEMA` allows name resolution in `public`.
- `SELECT ON ALL TABLES` grants reads on existing tables.
- `ALTER DEFAULT PRIVILEGES` grants reads on tables created later by the same role.

The reader has **no** `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, or DDL privileges. The app still opens read-only transactions and validates SQL; the role is the last line of defense, not the only one. See [08 — Read-only SQL execution](08-readonly-sql-execution.md).

### The one-`.env` design (and its CWD trap)

`apps/backend/src/db.ts` loads the repo root explicitly:

```ts
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();
```

Why both calls:

1. The explicit root path works no matter where the process starts (`tsx watch src/server.ts`, `node dist/server.js`, Jest from `apps/backend`).
2. The second, default call is a convenience: a local `apps/backend/.env` can override one key without editing the shared root file. In production, real environment variables win over both because dotenv does not overwrite existing values.

The pitfall: `npm run dev -w apps/backend` sets `process.cwd()` to `apps/backend`. A plain `dotenv.config()` would load the wrong file and leave `DATABASE_URL` undefined. The explicit path is the fix; do not "simplify" it back.

### Env matrix

| Key | Purpose | Default / notes |
|---|---|---|
| `DATABASE_URL` | App database | required |
| `JWT_SECRET` | Signs auth tokens | required, long random |
| `CONNECTION_ENCRYPTION_KEY` | AES-256-GCM key for connection passwords | required, 32 bytes (base64 or hex) |
| `FRONTEND_ORIGIN` | CORS origin | `http://localhost:5173` |
| `LLM_BASE_URL` | OpenAI-compatible provider | required unless using a default |
| `LLM_API_KEY` | Provider key | empty for Ollama |
| `LLM_MODEL` | Provider model id | provider-specific |
| `LLM_TIMEOUT_MS` | LLM request timeout | `60000` |
| `SQL_MAX_ROWS` | Result row cap | `100` |
| `SQL_TIMEOUT_MS` | Target query timeout | `5000` |
| `SQL_SCHEMA_CACHE_MS` | Introspection cache TTL | `300000` |
| `DB_CONNECT_TIMEOUT_MS` | Target connect timeout | `5000` |
| `MAX_CONNECTIONS_PER_USER` | Connection cap | `20` |
| `MAX_SELECTED_TABLES` | Table-scope cap | `100` |
| `DB_ALLOWED_HOSTS` | Optional target host/IP/CIDR allowlist | empty allows any non-blocked host |

Generate the encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Losing this key makes stored connection passwords unrecoverable. Store it in the same secret manager as `JWT_SECRET`; never commit it.

### Test database

`test/globalSetup.cjs` connects to the app Postgres admin database and creates a throwaway `database_knowledge_assistant_test` database, then applies `schema.sql`. The demo target test data can live in a separate schema or a second throwaway database created in the same setup. Keep test setup destructive: it should be able to drop and recreate freely.

## Pitfalls we hit (and fixes)

1. **Wrong CWD.** `npm -w` scripts run from the workspace, not the repo root. Use the explicit root `.env` path in `db.ts`; do not rely on `process.cwd()`.
2. **Docker volume keeps an old schema.** `CREATE TABLE IF NOT EXISTS` will not add a new column to an existing table. For schema changes, add an explicit `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` migration, or drop the dev volume when you intentionally want a clean slate (`docker compose down -v` destroys data).
3. **Demo role can still write through ownership.** If the demo target tables are owned by `demo_reader`, it can alter them despite having no explicit grants. Create tables as `demo_admin` and grant only `SELECT` to `demo_reader`.
4. **`localhost` inside a container is not the host.** The app runs on the host in development, so `127.0.0.1:5435` works. If the API itself is containerized, use the compose service name `demo-postgres:5432` instead.
5. **Secrets in `docker-compose.yml`.** The demo passwords are development-only and clearly labeled. Production must use a secret manager, not committed compose values.
6. **Missing `CONNECTION_ENCRYPTION_KEY`.** Fail at boot, not at the first connection create. A loud error is better than silently storing credentials with a fallback key.

## Verification checklist

```bash
docker compose up -d
docker compose ps                                  # both healthy
docker compose exec -T app-postgres psql -U app_user -d database_knowledge_assistant -c '\dt'
docker compose exec -T demo-postgres psql -U demo_admin -d demo_analytics -c '\dt'
# read-only proof
docker compose exec -T demo-postgres psql -U demo_reader -d demo_analytics \
  -c 'CREATE TABLE should_fail (id int);'          # must fail
# app schema applied
psql "$DATABASE_URL" -c 'SELECT count(*) FROM database_connections;'
```

## Backlinks

- Walkthrough: [Step 0 — Repository foundation](../history/implementation-walkthrough.md#1-step-0--repository-foundation) · [Step 3 — Connections](../history/implementation-walkthrough.md#4-step-3--database-connections-and-encryption)
- Related: [01 — Monorepo & tooling](01-monorepo-tooling.md) · [06 — Database connections & encryption](06-database-connections-encryption.md) · [12 — Testing strategy](12-testing-strategy.md)
