# Configuration

Single source of truth for environment variables, defaults, and hard limits.
Copy `.env.example` to `.env` for local development, or set the same keys in your
hosting platform for production.

## Loading order

- The API reads environment variables from the process environment. Locally it
  loads the repository-root `.env` explicitly, so running a workspace command
  still finds the right file.
- The web app reads `VITE_*` variables at build time.
- `.env.example` and `.env.production.example` list every supported key with
  placeholder values. Never commit real secrets.

## Required variables

| Variable | Local | Production | Notes |
| --- | --- | --- | --- |
| `JWT_SECRET` | yes | yes | At least 32 characters; weak placeholders are rejected at startup. |
| `CONNECTION_ENCRYPTION_KEY` | yes | yes | Must decode to exactly 32 bytes (base64 or hex). |
| `CONNECTION_RECOVERY_PASSPHRASE` | no | yes | At least 12 characters; required at startup when `NODE_ENV=production`. |
| `DATABASE_URL` | yes | yes | App PostgreSQL connection string. Production must not use the local default password. |
| `LLM_API_KEY` | for live answers | for live answers | Any OpenAI-compatible provider key. |

Generate the three secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Back up `CONNECTION_ENCRYPTION_KEY` and `CONNECTION_RECOVERY_PASSPHRASE` offline,
separate from the repository and the app database. Losing both makes every stored
connection secret and provider key unrecoverable.

## Application and server

| Variable | Default | Purpose |
| --- | --- | --- |
| `NODE_ENV` | `development` | Set to `production` for deployed environments; enables stricter startup validation. |
| `PORT` | `4000` | API listen port. Platforms such as Render and Railway inject this. |
| `DATABASE_URL` | local compose URL | App PostgreSQL connection. |
| `FRONTEND_ORIGIN` | `http://localhost:5173` | CORS origin for the web app. |
| `JWT_SECRET` | — | JWT signing secret. |
| `CONNECTION_ENCRYPTION_KEY` | — | AES-256-GCM key-encrypting key for stored secrets. |
| `CONNECTION_ENCRYPTION_KEY_VERSION` | `1` | Key version; bump when rotating the encryption key. |

## LLM provider

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLM_BASE_URL` | — | OpenAI-compatible base URL, for example `https://api.groq.com/openai/v1`. |
| `LLM_API_KEY` | — | Provider API key. |
| `LLM_MODEL` | `openai/gpt-oss-120b` | Default model id; the seed writes it to the `models` table. |
| `LLM_TIMEOUT_MS` | `60000` | Upstream request timeout. |

Administrators can also manage providers and models under **AI providers** in the
app. Stored API keys are envelope-encrypted; environment values remain the fallback.

## Target database safety

| Variable | Default | Hard limit |
| --- | --- | --- |
| `SQL_MAX_ROWS` | `100` | Capped at `1000` |
| `SQL_TIMEOUT_MS` | `5000` | Capped at `60000` |
| `SQL_SCHEMA_CACHE_MS` | `300000` | — |
| `SQL_INTROSPECTION_TIMEOUT_MS` | `5000` | — |
| `DB_CONNECT_TIMEOUT_MS` | `5000` | — |
| `MYSQL_CONNECT_TIMEOUT_MS` | `15000` | Falls back to `DB_CONNECT_TIMEOUT_MS` |
| `MYSQL_RECORD_COUNT_TIMEOUT_MS` | `30000` | — |
| `DB_ALLOWED_HOSTS` | empty | Comma-separated hostnames, IPs, or CIDRs; empty allows any host except blocked link-local/cloud metadata addresses. |
| `MAX_CONNECTIONS_PER_USER` | `20` | — |
| `MAX_SELECTED_TABLES` | `100` | — |

## Frontend (build-time)

| Variable | Default | Purpose |
| --- | --- | --- |
| `VITE_API_URL` | empty | Browser API base URL. Empty uses the Vite proxy or same-origin `/api`. |
| `VITE_SHOW_DEMO_ACCOUNTS` | `false` | Show demo credentials on the login page (development only). |

## Tests

| Variable | Default | Purpose |
| --- | --- | --- |
| `TEST_DATABASE_URL` | local test database | Jest app database override. |
| `TEST_ADMIN_URL` | local admin connection | Used by Jest global setup to create and drop the test database. |

## Startup validation

`apps/backend/src/services/securityConfig.ts` refuses to start when:

- `JWT_SECRET` is missing, a known placeholder, or shorter than 32 characters;
- `CONNECTION_ENCRYPTION_KEY` is missing, does not decode to 32 bytes, or cannot
  initialize AES-256-GCM;
- `CONNECTION_RECOVERY_PASSPHRASE` is missing in production or shorter than 12
  characters;
- `DATABASE_URL` uses the local development password in production.

## Related

- [Quickstart](../getting-started/quickstart.md)
- [Deployment guide](../guides/deployment.md)
- [Docker, Postgres & environment](../concepts/03-docker-postgres.md)
- [Security checklist](../concepts/13-security-checklist.md)
