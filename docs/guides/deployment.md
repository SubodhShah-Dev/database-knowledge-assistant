# Deploying Database Knowledge Assistant (Vercel + Railway + Neon)

A start-to-end runbook for running the whole app in production: the React SPA on
Vercel, the Express API on Railway, and PostgreSQL on Neon.

> This file lives in `docs/`, which is gitignored in this repo. Copy it elsewhere if
> you want it tracked in version control.

---

## 1. What gets deployed

| Component | Host     | Artifact                                   |
| --------- | -------- | ------------------------------------------ |
| Web app   | Vercel   | `apps/frontend` → static `dist/`           |
| API       | Railway  | `apps/backend` → `node dist/server.js`     |
| Database  | Neon     | PostgreSQL 16 (app schema + user data)     |
| LLM       | External | Any OpenAI-compatible provider (Groq, …)   |

```
Browser
  │  https://<app>.vercel.app            (static SPA, React Router)
  │  fetch /api/* with Authorization: Bearer <jwt>
  ▼
https://<api>.up.railway.app            (Express, SSE for answers)
  │  DATABASE_URL (sslmode=require)
  ▼
Neon PostgreSQL
```

Notes:

- The frontend and API are **separate origins**. CORS is controlled by
  `FRONTEND_ORIGIN` on the API and `VITE_API_URL` in the frontend.
- Authentication uses a JWT stored in `localStorage` and sent as a bearer token, so
  cross-origin requests work without cookies.
- Answers stream over Server-Sent Events (SSE), so keep the API connection alive
  (Railway is a better fit than free-tier hosts that sleep or impose request timeouts).

---

## 2. Prerequisites

- A GitHub repository containing this project (pushed and accessible to the deploy
  platforms).
- Accounts: [Neon](https://neon.tech), [Railway](https://railway.app),
  [Vercel](https://vercel.com), and an LLM provider.
- Node 22 installed locally (used only for seeding and schema setup).
- The repo configuration from section 3 committed and pushed.

---

## 3. Repo configuration (commit before deploying)

These files make the monorepo deploy cleanly and are already in the repo.

### `apps/frontend/vercel.json` — SPA fallback

React Router paths such as `/settings/models` and `/sessions` must resolve to
`index.html` instead of 404ing on a static host.

```json
{
  "rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]
}
```

### `railway.json` (repo root) — build, start, healthcheck

The API is part of an npm workspace, so Railway must run from the **repo root** and
target the backend workspace.

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build": {
    "builder": "NIXPACKS",
    "buildCommand": "npm ci && npm run build -w apps/backend"
  },
  "deploy": {
    "startCommand": "npm start -w apps/backend",
    "healthcheckPath": "/api/health",
    "restartPolicyType": "ON_FAILURE"
  }
}
```

### Node version pin

`bcrypt@5.x` ships N-API prebuilds; pinning Node avoids a surprise native compile on
the host.

- `.nvmrc` containing `22`
- In root `package.json`:

  ```json
  "engines": { "node": ">=20 <23" }
  ```

### Health endpoint semantics

`GET /api/health` returns **200** with `{ "ok": true, "database": "connected" }`
when Postgres is reachable, and **503** with `{ "ok": false, "database": "disconnected" }`
when it is not. This lets Railway's healthcheck catch database outages.

---

## 4. Database — Neon

1. Create a Neon project (PostgreSQL 16).
2. Copy the **direct** connection string (the host without `-pooler`), keeping
   `?sslmode=require`. Example shape:

   ```
   postgres://USER:PASSWORD@ep-xxxx.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```

3. Open the Neon SQL editor and run the entire `apps/backend/schema.sql`. On a fresh
   database this creates every table, including `user_models`, `user_api_keys`, and
   the `first_name` / `last_name` columns on `users`.

4. **Existing database only:** `schema.sql` is create-only, so new columns are not
   added to tables that already exist. Run these once:

   ```sql
   ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name text;
   ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name text;
   ```

Keep the connection string handy for the API environment variables.

---

## 5. API — Railway

1. Create a new Railway project and deploy from the GitHub repository.
2. Set the service **root directory to the repo root** (not `apps/backend`) so the
   workspace `package-lock.json` is used. `railway.json` supplies the build and start
   commands.
3. Add the environment variables below in the Railway dashboard.
4. Deploy. The service is healthy when `GET /api/health` returns 200.

### Environment variables

| Variable                             | Required | Value / notes                                                    |
| ------------------------------------ | -------- | ---------------------------------------------------------------- |
| `NODE_ENV`                           | yes      | `production`                                                     |
| `PORT`                               | auto     | Injected by Railway                                              |
| `DATABASE_URL`                       | yes      | Neon direct URL with `?sslmode=require`                          |
| `JWT_SECRET`                         | yes      | 32+ random chars                                                 |
| `CONNECTION_ENCRYPTION_KEY`          | yes      | Exactly 32 bytes, base64 or hex                                  |
| `CONNECTION_ENCRYPTION_KEY_VERSION`  | no       | Defaults to `1`; bump only when rotating the key                 |
| `CONNECTION_RECOVERY_PASSPHRASE`     | yes\*    | 12+ chars; \*required at startup in production                   |
| `FRONTEND_ORIGIN`                    | yes      | Exact Vercel URL, e.g. `https://<app>.vercel.app` (no trailing `/`) |
| `LLM_BASE_URL`                       | yes      | e.g. `https://api.groq.com/openai/v1`                            |
| `LLM_API_KEY`                        | yes      | Provider API key                                                 |
| `LLM_MODEL`                          | yes      | e.g. `openai/gpt-oss-120b`                                       |
| `LLM_TIMEOUT_MS`                     | no       | Defaults to `60000`                                              |
| `SQL_MAX_ROWS`                       | no       | Defaults to `100`                                                |
| `SQL_TIMEOUT_MS`                     | no       | Defaults to `5000`                                               |
| `SQL_SCHEMA_CACHE_MS`                | no       | Defaults to `300000`                                             |
| `DB_CONNECT_TIMEOUT_MS`              | no       | Defaults to `5000`                                               |
| `MYSQL_CONNECT_TIMEOUT_MS`           | no       | Defaults to `15000`                                              |
| `MYSQL_RECORD_COUNT_TIMEOUT_MS`      | no       | Defaults to `30000`                                              |
| `DB_ALLOWED_HOSTS`                   | no       | Comma-separated host/IP/CIDR allowlist; empty allows any host     |
| `MAX_CONNECTIONS_PER_USER`           | no       | Defaults to `20`                                                 |
| `MAX_SELECTED_TABLES`                | no       | Defaults to `100`                                                |

The API refuses to start with a missing/weak `JWT_SECRET`, a
`CONNECTION_ENCRYPTION_KEY` that does not decode to 32 bytes, or (in production) a
missing recovery passphrase — see `apps/backend/src/services/securityConfig.ts`.

### Generate secrets locally

```bash
# JWT_SECRET (any 32+ char random string)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# CONNECTION_ENCRYPTION_KEY (exactly 32 bytes, base64)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# CONNECTION_RECOVERY_PASSPHRASE (12+ chars)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

> **Back up `CONNECTION_ENCRYPTION_KEY` and `CONNECTION_RECOVERY_PASSPHRASE` offline**
> (password manager, encrypted USB), separately from the repo and database. Losing
> them makes every stored database credential, MongoDB URI, and provider API key
> unrecoverable.

---

## 6. Seed the default model

The seed creates the default model row. In production it deliberately skips the demo
users. Run it once from a local checkout pointed at Neon:

```bash
DATABASE_URL='postgres://USER:PASSWORD@ep-xxxx.neon.tech/neondb?sslmode=require' \
NODE_ENV=production \
LLM_MODEL='openai/gpt-oss-120b' \
LLM_BASE_URL='https://api.groq.com/openai/v1' \
npm run seed
```

This is idempotent (`ON CONFLICT` upsert) and safe to rerun when changing the default
model. Create the first real user through the signup form on the deployed site.

---

## 7. Frontend — Vercel

1. Import the GitHub repository into Vercel.
2. Configure the project:
   - **Root Directory:** `apps/frontend`
   - **Framework preset:** Vite
   - **Build Command:** `npm run build`
   - **Output Directory:** `dist`
3. Add environment variables (these are **build-time** for Vite, so set them before
   deploying):

   | Variable                 | Value                                  |
   | ------------------------ | -------------------------------------- |
   | `VITE_API_URL`           | `https://<api>.up.railway.app` (no trailing `/`) |
   | `VITE_SHOW_DEMO_ACCOUNTS`| `false`                                |

4. Deploy and copy the production URL (for example `https://<app>.vercel.app`).

---

## 8. Close the CORS loop

1. In Railway, set `FRONTEND_ORIGIN` to the exact Vercel production URL, with scheme
   and no trailing slash.
2. Redeploy the API so the new value is picked up.

`cors()` accepts a single origin string. Adding a custom domain later requires either
pointing `FRONTEND_ORIGIN` at it or changing the code to allow a list.

---

## 9. Verification checklist

```bash
# 1. API is up and connected to Postgres
curl -s https://<api>.up.railway.app/api/health
# → {"ok":true,"message":"API is running","database":"connected",...}

# 2. Frontend loads and can reach the API
#    Open https://<app>.vercel.app, sign up / log in, watch the Network tab.
```

In the browser:

- Sign up with a real email, log out, and log back in.
- Add a database connection and confirm Save + Test succeed.
- Start a session and ask one question; the answer streams in (SSE) and shows the
  query and results.
- Open `/settings/models` and `/settings/api-keys` directly (paste the URL in a new
  tab) — they must render, not 404.
- Add a user-defined provider under **My Models** and use it for a question.
- Check `railway logs` for errors; there must be no `SecurityConfigError` at startup.

---

## 10. Troubleshooting

| Symptom                                        | Cause / fix                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| API exits at startup with `SecurityConfigError`| Missing/weak `JWT_SECRET`, bad-length `CONNECTION_ENCRYPTION_KEY`, or missing `CONNECTION_RECOVERY_PASSPHRASE` in production. |
| Browser CORS error on `/api/*`                 | `FRONTEND_ORIGIN` does not exactly match the site origin, or has a trailing slash. Update and redeploy. |
| 404 when refreshing `/settings/models`         | SPA rewrite missing or `vercel.json` not in the Vercel root directory.      |
| Login returns 500 after an upgrade            | Schema is behind: run the `ALTER TABLE users ...` statements from section 4.|
| Answers fail with 503                          | LLM provider unreachable or misconfigured; check `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`. |
| SSE answers cut off                            | Host sleep/request timeouts; use Railway (or a paid tier) instead of a free sleeping instance. |
| `bcrypt` build failure on deploy              | Node version drift; ensure `.nvmrc`/`engines` pin Node 22.                  |
| DB connection test fails                       | The API host must be able to reach the target DB. Check `DB_ALLOWED_HOSTS` and cloud firewalls. |

---

## 11. Security and ongoing operations

- Never commit `.env` or real secrets; `.env` is gitignored — set values in the
  platform dashboards.
- Back up `CONNECTION_ENCRYPTION_KEY` and `CONNECTION_RECOVERY_PASSPHRASE` offline.
- To rotate the encryption key: bump `CONNECTION_ENCRYPTION_KEY_VERSION`, deploy the
  new key, and re-encrypt existing secrets using the recovery flow
  (`POST /api/recovery/validate`, then restart).
- Schema changes to `apps/backend/schema.sql` are create-only. For an existing
  database, also apply explicit `ALTER TABLE` / `CREATE INDEX` statements and then
  restart the API.
- Redeploy flow: push to the default branch → Railway and Vercel rebuild
  automatically. If the schema changed, apply the migration first.
