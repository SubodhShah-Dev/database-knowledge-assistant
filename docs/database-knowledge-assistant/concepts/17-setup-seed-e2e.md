# 17 — Setup, seed, and E2E lifecycle

> One command starts the local stack. Jest uses a throwaway app database and the real demo target. Playwright starts its own API and Vite servers on separate ports with an LLM stub.

**Back to:** [Concept index](README.md) · [Application database](../../databases/application-database.md)

## Fresh setup

```bash
npm install
cp .env.example .env
npm run setup
```

`npm run setup` is:

```text
docker compose up -d --wait
→ apply apps/backend/schema.sql to database_knowledge_assistant
→ npm run seed
→ start API and Vite together
```

Set the LLM credentials in `.env` before running it for live answers.

## Services

| Service | Local port |
| --- | --- |
| Frontend (dev) | `5173` |
| Backend (dev) | `4000` |
| App PostgreSQL | `5434` |
| Demo PostgreSQL | `5435` |
| Playwright frontend | `5273` |
| Playwright API | `4100` |
| Playwright LLM stub | `4010` |

## What `db:setup` does

The root script pipes `apps/backend/schema.sql` into the app container:

```bash
docker compose exec -T app-postgres psql -U app_user -d database_knowledge_assistant \
  < apps/backend/schema.sql
npm run seed
```

`apps/backend/src/seed.ts` then:

1. Seeds the admin user.
2. Seeds the demo connection pointing at `demo_analytics`.
3. Seeds provider/model rows.
4. Prints the seeded credentials.

`npm run seed` can be rerun without recreating containers.

## Jest lifecycle

`apps/backend/test/globalSetup.cjs`:

- Reads `TEST_DATABASE_URL`.
- Drops and recreates `database_knowledge_assistant_test`.
- Applies `schema.sql`.

It does **not** seed users or demo data. Integration tests create their own fixtures and use the real `demo_analytics` target on `localhost:5435`.

## Playwright lifecycle

`apps/frontend/playwright.config.ts` starts three servers:

- `e2e/llm-stub.mjs` on port `4010`.
- The backend on port `4100`, after running `npm run seed -w apps/backend`.
- Vite on port `5273`.

The backend is pointed at the stub with `LLM_BASE_URL` and `LLM_API_KEY`. `e2e/global-teardown.ts` restores the original model configuration. The suite logs in through the normal UI and does not call the production provider.

## Useful commands

```bash
npm run typecheck
npm test
npm run test:e2e
npm run build
```

## Pitfalls

- `docker compose down -v` deletes both database volumes; rerun `npm run db:setup`.
- Jest recreates only the test app database, not the demo database.
- Playwright uses its own ports, so it can run beside the dev servers.
- The demo target is PostgreSQL only; multi-engine support is exercised through adapter tests, not the seeded demo.
- `.env` is generated from `.env.example` and must not be committed.
- The current E2E spec defaults to `test@example.com` / `password123` and the old `/chat` route; the seed creates `demo@example.com` / `DemoPassword123!` and chat lives at `/c/:id`. Align the fixture or set `E2E_USER_EMAIL` / `E2E_USER_PASSWORD` before expecting a green run.

## Related docs

- [Application database](../../databases/application-database.md)
- [Demo database](../../databases/demo-database.md)
- [Testing strategy](12-testing-strategy.md)
- [Schema evolution](16-schema-evolution.md)
