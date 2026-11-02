# Local Setup

Detailed local lifecycle for the API, web app, app database, and demo target
database. For the shortest path, start with the [Quickstart](quickstart.md).

## Docker services

| Service | Host port | Database | Role | Purpose |
| --- | --- | --- | --- | --- |
| `app-postgres` | `5434` | `database_knowledge_assistant` | `app_user` | Application system of record |
| `demo-postgres` | `5435` | `demo_analytics` | `demo_admin`, read-only `demo_reader` | Sample target for development and tests |

Manage the services with:

```bash
npm run docker:up      # start and wait for health
npm run docker:down    # stop
npm run docker:ps      # status
npm run docker:logs    # follow logs
```

The demo target schema is applied from `apps/backend/demo/target-schema.sql` the
first time the `demo-postgres` volume is created. To recreate it, remove the
volume and start the service again.

## Schema and seed

```bash
npm run db:setup   # apply apps/backend/schema.sql and run the seed
npm run seed       # seed demo users and the default model only
```

The app schema is applied directly from `apps/backend/schema.sql`; there is no
migration framework. For an existing deployment, rerun the file against the app
database before restarting the API so new columns and constraints are added.

The seed is idempotent. In development it creates:

| Account | Password | Role |
| --- | --- | --- |
| `demo@example.com` | `DemoPassword123!` | user |
| `admin@example.com` | `AdminPassword123!` | admin |

Production seeding deliberately skips the demo users.

## Ports and URLs

| Process | URL |
| --- | --- |
| Web app | `http://localhost:5173` |
| API | `http://localhost:4000` |
| API health | `http://localhost:4000/api/health` |
| Demo target PostgreSQL | `127.0.0.1:5435` |
| App PostgreSQL | `127.0.0.1:5434` |

The Vite dev server binds to `127.0.0.1`. If the browser reports `ECONNREFUSED`,
use `http://127.0.0.1:5173` instead of `localhost`.

## Troubleshooting

- **Port already in use:** stop the process on `4000` or `5173`. E2E uses separate ports `4100` and `5273`.
- **Connection test fails:** confirm `npm run docker:ps` is healthy and use `127.0.0.1:5435` for the demo database.
- **A host is rejected:** link-local and cloud metadata addresses are blocked. Set `DB_ALLOWED_HOSTS` only to restrict connections further.
- **Answers fail with `503`:** the LLM provider is missing or unreachable. Check `LLM_BASE_URL`, `LLM_API_KEY`, and the seeded model configuration.
- **Credentials cannot be decrypted:** `CONNECTION_ENCRYPTION_KEY` changed without the matching recovery record. Restore the key or use the recovery passphrase.

## Related

- [Configuration reference](../reference/configuration.md)
- [Docker, Postgres & environment](../concepts/03-docker-postgres.md)
- [Setup, seed, and E2E lifecycle](../concepts/17-setup-seed-e2e.md)
- [Demo data](demo-data.md)
