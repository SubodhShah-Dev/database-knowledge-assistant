# Deploying Database Knowledge Assistant (Vercel + Render + Neon)

A start-to-end runbook for running the whole app in production: the React SPA on
Vercel, the Express API on Render, and PostgreSQL on Neon.

---

## 1. What gets deployed

| Component | Host     | Artifact                                   |
| --------- | -------- | ------------------------------------------ |
| Web app   | Vercel   | `apps/frontend` → static `dist/`           |
| API       | Render   | `apps/backend` → `node dist/server.js`     |
| Database  | Neon     | PostgreSQL 16 (app schema + user data)     |
| LLM       | External | Any OpenAI-compatible provider (Groq, …)   |

```
Browser
  │  https://<app>.vercel.app            (static SPA, React Router)
  │  fetch /api/* with Bearer JWT (HttpOnly cookie on same-site hosts)
  ▼
https://<service>.onrender.com          (Express, SSE for answers)
  │  DATABASE_URL (Neon pooled, sslmode=require)
  ▼
Neon PostgreSQL
```

Notes:

- The frontend and API are **separate origins**. CORS is controlled by
  `FRONTEND_ORIGIN` on the API and `VITE_API_URL` in the frontend. The API enables
  credentialed CORS and the client sends `credentials: 'include'`.
- Authentication sets an HttpOnly `SameSite=Strict` cookie, but `SameSite=Strict`
  cookies are not sent between `*.vercel.app` and `*.onrender.com` because they are
  different sites. In production the SPA authenticates with the JWT it stores in
  `localStorage` and sends as `Authorization: Bearer`. The cookie path is used in
  local development and would work again if the app and API share a custom domain.
- Answers stream over Server-Sent Events (SSE). Render supports streaming, but the
  **free** web service spins down after 15 minutes without inbound traffic and takes
  about a minute to wake on the next request. Paid instances stay always-on.
- See the [configuration reference](../reference/configuration.md) for the complete
  variable list, defaults, and startup validation.

---

## 2. Prerequisites

- A GitHub repository containing this project (pushed and accessible to the deploy
  platforms).
- Accounts: [Neon](https://neon.tech), [Render](https://render.com),
  [Vercel](https://vercel.com), and an LLM provider.
- Node 22 installed locally (used only for seeding and schema setup).
- The repo configuration from section 3 committed and pushed.
- A Render account does not require a credit card for the Free compute plan.

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

### `render.yaml` (repo root) — build, start, healthcheck

The API is part of an npm workspace, so Render must build from the **repo root** and
target the backend workspace.

```yaml
services:
  - type: web
    name: dka-api
    runtime: node
    plan: free
    region: ohio
    buildCommand: npm ci --include=dev && npm run build -w apps/backend
    startCommand: npm start -w apps/backend
    healthCheckPath: /api/health
    autoDeployTrigger: commit
    envVars:
      - key: NODE_ENV
        value: production
      - key: DATABASE_URL
        sync: false
      - key: JWT_SECRET
        sync: false
      - key: CONNECTION_ENCRYPTION_KEY
        sync: false
      - key: CONNECTION_ENCRYPTION_KEY_VERSION
        value: "1"
      - key: CONNECTION_RECOVERY_PASSPHRASE
        sync: false
      - key: FRONTEND_ORIGIN
        sync: false
      - key: LLM_BASE_URL
        value: https://api.groq.com/openai/v1
      - key: LLM_API_KEY
        sync: false
      - key: LLM_MODEL
        value: openai/gpt-oss-120b
```

The `--include=dev` flag is required: Render exposes `NODE_ENV=production` during the
build, and a plain `npm ci` then omits `typescript` and `@types/*`, which live in
`devDependencies`, so the `tsc` build would fail.

Do **not** add `PORT` to the Blueprint. Render injects it at runtime.

### Node version pin

`bcrypt@5.x` ships N-API prebuilds; pinning Node avoids a surprise native compile on
the host. Render's default Node version moves forward over time (24.x for services
created after 2026-10-21), so the pin matters.

- `.nvmrc` containing `22`
- In root `package.json`:

  ```json
  "engines": { "node": ">=20 <23" }
  ```

### Health endpoint semantics

`GET /api/health` returns **200** with `{ "ok": true, "database": "connected" }`
when Postgres is reachable, and **503** with `{ "ok": false, "database": "disconnected" }`
when it is not. This lets Render's healthcheck catch database outages.

---

## 4. Database — Neon

1. Create a Neon project (PostgreSQL 16).
2. Copy both connection strings from the Neon dashboard:
   - **Pooled** (host contains `-pooler`): used by the deployed API as `DATABASE_URL`.
   - **Direct** (host without `-pooler`): used locally for schema setup and seeding.
   Keep `?sslmode=require` on both. Example shapes:

   ```
   # pooled
   postgres://USER:PASSWORD@ep-xxxx-pooler.us-east-2.aws.neon.tech/neondb?sslmode=require
   # direct
   postgres://USER:PASSWORD@ep-xxxx.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```

3. Open the Neon SQL editor (or use `psql` with the direct URL) and run the entire
   `apps/backend/schema.sql`. On a fresh database this creates every table, including
   `user_models`, `user_api_keys`, and the `first_name` / `last_name` columns on
   `users`.

4. **Existing database only:** `schema.sql` is create-only, so new columns are not
   added to tables that already exist. Run these once:

   ```sql
   ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name text;
   ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name text;
   ```

Keep the pooled string for the Render environment variables and the direct string for
section 6.

---

## 5. API — Render

1. In the Render Dashboard, choose **New → Blueprint** and connect the GitHub
   repository. Render reads `render.yaml` from the repo root and creates the
   `dka-api` web service.
2. Leave the root directory at the repo root. Render uses the workspace
   `package-lock.json` and the build/start commands from `render.yaml`. Before the
   first deploy, set `region` to the Render region closest to Neon (`ohio` is used
   here because the Neon project is in `us-east-2`); Render cannot change a
   service's region later.
3. On the first Blueprint sync, Render prompts for every variable marked
   `sync: false` (section 5, environment variables). Fill them in.
4. Deploy. The service is healthy when `GET /api/health` returns 200. The public URL
   looks like `https://<service>.onrender.com`.

### Environment variables

Set these at minimum:

| Variable | Value / notes |
| --- | --- |
| `NODE_ENV` | `production` (already in `render.yaml`) |
| `DATABASE_URL` | Neon **pooled** URL with `?sslmode=require` |
| `JWT_SECRET` | 32+ random characters |
| `CONNECTION_ENCRYPTION_KEY` | Exactly 32 bytes, base64 or hex |
| `CONNECTION_RECOVERY_PASSPHRASE` | 12+ characters; required at startup in production |
| `FRONTEND_ORIGIN` | Exact Vercel URL, e.g. `https://<app>.vercel.app` (no trailing `/`) |
| `LLM_BASE_URL` | e.g. `https://api.groq.com/openai/v1` |
| `LLM_API_KEY` | Provider API key |
| `LLM_MODEL` | e.g. `openai/gpt-oss-120b` |

Optional tuning such as `SQL_MAX_ROWS`, `SQL_TIMEOUT_MS`, `DB_ALLOWED_HOSTS`, and
`CONNECTION_ENCRYPTION_KEY_VERSION` is documented once in the
[configuration reference](../reference/configuration.md). `PORT` is injected by
Render.

The API refuses to start with a missing/weak `JWT_SECRET`, a
`CONNECTION_ENCRYPTION_KEY` that does not decode to 32 bytes, or (in production) a
missing recovery passphrase — see `apps/backend/src/services/securityConfig.ts`.

### Free plan limits (and when to upgrade)

- 750 free instance hours per workspace per calendar month; only running instances
  consume them.
- 512 MB RAM / 0.1 CPU.
- Spins down after 15 minutes with no inbound traffic; the next request waits about a
  minute while it wakes.
- HTTP responses, including SSE streams, can stay open for up to 100 minutes.
- Render may restart a free service at any time, and the filesystem is ephemeral
  (this app keeps all state in Neon, so that is fine).
- There is a service-initiated traffic threshold for unusually high outbound volume.

For an always-on demo or real production use, switch the service to the Starter plan
($7/month). Everything else in this guide stays the same.

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
users. Run it once from a local checkout pointed at Neon, using the **direct**
(non-pooled) URL:

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

   | Variable                 | Value                                           |
   | ------------------------ | ----------------------------------------------- |
   | `VITE_API_URL`           | `https://<service>.onrender.com` (no trailing `/`) |
   | `VITE_SHOW_DEMO_ACCOUNTS`| `false`                                         |

4. Deploy and copy the production URL (for example `https://<app>.vercel.app`).

---

## 8. Close the CORS loop

1. In the Render Dashboard, open the `dka-api` service and set `FRONTEND_ORIGIN` to
   the exact Vercel production URL, with scheme and no trailing slash.
2. Save. Render redeploys when environment variables change; if it does not start a
   deploy automatically, trigger a manual deploy so the new value is picked up.

`cors()` accepts a single origin string. Adding a custom domain later requires either
pointing `FRONTEND_ORIGIN` at it or changing the code to allow a list.

---

## 9. Verification checklist

```bash
# 1. API is up and connected to Postgres
curl -s https://<service>.onrender.com/api/health
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
- Check **Render → Logs** for errors; there must be no `SecurityConfigError` at
  startup.
- The first request after 15 idle minutes may take about a minute on the free plan.

---

## 10. Troubleshooting

| Symptom                                        | Cause / fix                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| API exits at startup with `SecurityConfigError`| Missing/weak `JWT_SECRET`, bad-length `CONNECTION_ENCRYPTION_KEY`, or missing `CONNECTION_RECOVERY_PASSPHRASE` in production. |
| Build fails with `tsc: not found`              | `npm ci` skipped devDependencies; keep `--include=dev` in `render.yaml`.     |
| Browser CORS error on `/api/*`                 | `FRONTEND_ORIGIN` does not exactly match the site origin, or has a trailing slash. Update and redeploy. |
| 404 when refreshing `/settings/models`         | SPA rewrite missing or `vercel.json` not in the Vercel root directory.      |
| Login returns 500 after an upgrade            | Schema is behind: run the `ALTER TABLE users ...` statements from section 4.|
| Answers fail with 503                          | LLM provider unreachable or misconfigured; check `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`. |
| First request is slow / SSE stalls on wake     | Render free service spun down after 15 idle minutes; the next request takes ~1 min. Upgrade to Starter for always-on. |
| `bcrypt` build failure on deploy              | Node version drift; ensure `.nvmrc`/`engines` pin Node 22.                  |
| DB connection test fails                       | The API host must be able to reach the target DB. Check `DB_ALLOWED_HOSTS` and cloud firewalls. |

---

## 11. Security and ongoing operations

- Never commit `.env` or real secrets; `.env` is gitignored — set values in the
  platform dashboards and in Render's `sync: false` prompts.
- Back up `CONNECTION_ENCRYPTION_KEY` and `CONNECTION_RECOVERY_PASSPHRASE` offline.
- To rotate the encryption key: bump `CONNECTION_ENCRYPTION_KEY_VERSION`, deploy the
  new key, and re-encrypt existing secrets using the recovery flow
  (`POST /api/recovery/validate`, then restart).
- Schema changes to `apps/backend/schema.sql` are create-only. For an existing
  database, also apply explicit `ALTER TABLE` / `CREATE INDEX` statements and then
  restart the API.
- Redeploy flow: push to the default branch → Render and Vercel rebuild
  automatically. If the schema changed, apply the migration first.

---

## 12. Railway fallback (signups paused)

Railway paused new signups after the October 21 security incident and has not
announced a reopening date ([status.railway.com](https://status.railway.com)).
Existing accounts continue to work, so the previous configuration is kept as a
fallback:

- `railway.json` at the repo root builds and starts the backend with Nixpacks.
- The rest of this runbook applies unchanged; only the host and URLs differ:
  `https://<service>.up.railway.app` instead of `https://<service>.onrender.com`.
- Set the same environment variables in the Railway dashboard, point the Railway
  service at the repo root, and use `railway logs` instead of Render logs.
- If you switch hosts, update `VITE_API_URL` on Vercel and `FRONTEND_ORIGIN` on the
  API, then redeploy both.

Do not run both hosts against the same Neon database at the same time unless you
intend to serve traffic from both.
