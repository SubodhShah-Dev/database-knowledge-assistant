# Query Map

Where the code reads and writes each database.

## Application database

The app database is accessed through the shared `pg.Pool` in `apps/backend/src/db.ts`.

### Auth

| Trigger | Code | Operation |
| --- | --- | --- |
| Signup | `auth.routes.ts:27` | `INSERT INTO users` |
| Login | `auth.routes.ts:46` | `SELECT ... FROM users` |

### Connections

| Trigger | Code | Operation |
| --- | --- | --- |
| List | `connections.routes.ts:115` | `SELECT` safe columns |
| Create | `connections.routes.ts:134,142` | count + `INSERT database_connections` |
| Read | `connections.routes.ts:202` | `SELECT` safe columns |
| Schema load | `connections.routes.ts:178` | `SELECT * FROM database_connections` |
| Update | `connections.routes.ts:216,225,237` | select + session count + `UPDATE` |
| Delete | `connections.routes.ts:279,288,299,304` | transaction across connections/conversations |
| Test | `connections.routes.ts:323` | `SELECT * FROM database_connections` |
| Ownership helper | `connectionAccess.ts:30` | `SELECT * FROM database_connections` |

### Conversations

| Trigger | Code | Operation |
| --- | --- | --- |
| List | `conversations.routes.ts:70` | join conversations/connections |
| Create | `conversations.routes.ts:52,113`; `connectionAccess.ts:30` | validate model, insert session |
| Read | `conversations.routes.ts:41,147` | session + `qa_history` |
| Update | `conversations.routes.ts:207` | `UPDATE conversations` |
| Delete | `conversations.routes.ts:226` | `DELETE FROM conversations` |

### Questions

| Trigger | Code | Operation |
| --- | --- | --- |
| Load session | `questions.routes.ts:220` | `SELECT * FROM conversations` |
| Load history | `questions.routes.ts:116` | `SELECT ... FROM qa_history LIMIT 6` |
| Resolve model | `modelConfig.ts:13,27` | `SELECT ... FROM models` |
| Persist turn | `questions.routes.ts:150,158` | insert `qa_history` + update conversation title |

### Models and seed

| Trigger | Code | Operation |
| --- | --- | --- |
| Public list | `models.routes.ts:100` | enabled models |
| Admin list | `models.routes.ts:115` | all models |
| Create | `models.routes.ts:131,133` | clear default + insert |
| Update | `models.routes.ts:158,175,178` | lock + update + default reset |
| Delete | `models.routes.ts:204` | delete |
| Seed | `seed.ts:7,15,20,22` | upsert users + default model |

### Not queried

- `app_settings` is defined in `schema.sql` but has no code references.
- `GET /api/health` does not touch the app database.
- Connection create/update validates the target host but does not query the target.

## Target databases

### Connection save

| Trigger | Code | Operation |
| --- | --- | --- |
| Create connection | `connections.routes.ts` → `validateConnectionTarget` | host/DNS validation only |
| Update connection | `connections.routes.ts` → `validateConnectionTarget` | host/DNS validation only |

No target connection is opened during save.

### Test

| Trigger | Code | Operation |
| --- | --- | --- |
| `POST /api/connections/:id/test` | `databaseAdapters.ts:690` | PostgreSQL version/role/grants; MySQL `VERSION()`; MongoDB `ping` |

### Schema

| Trigger | Code | Operation |
| --- | --- | --- |
| `GET /api/connections/:id/schema` | `connectionAccess.ts:56` | engine-specific introspection |
| `POST /api/conversations` | `getConnectionSchema` | default scope validation |
| `PATCH /api/conversations/:id` with tables | `getConnectionSchema(..., true)` | refreshed scope validation |
| `POST /api/questions` | `getConnectionSchema` | scope validation before planning |

PostgreSQL introspection lives in `introspection.ts:65`; MySQL/MongoDB introspection lives in `databaseAdapters.ts:753`.

### Execution

| Trigger | Code | Operation |
| --- | --- | --- |
| Data question | `databaseAdapters.ts:895` | PostgreSQL/MySQL read-only query or MongoDB aggregation |
| Record-count question | `databaseAdapters.ts:32` | exact counts across selected tables/collections |
| PostgreSQL execution | `sqlExecution.ts:35` | read-only transaction, timeout, row cap |
| MySQL execution | `databaseAdapters.ts` | read-only transaction request, timeout, row cap |
| MongoDB execution | `databaseAdapters.ts` | allowlisted pipeline or `countDocuments` |

### Cache and invalidation

| Concern | Location |
| --- | --- |
| PostgreSQL schema cache | `introspection.ts` |
| MySQL/MongoDB schema cache | `databaseAdapters.ts` |
| PostgreSQL pools | `connectionPool.ts:122` |
| Mongo clients | `databaseAdapters.ts` |
| Invalidate all target state | `databaseAdapters.ts:1082` |
| Invalidate PostgreSQL schema cache | `introspection.ts` |

## Tests and E2E

| Layer | Database use |
| --- | --- |
| Jest setup | Drops/creates `database_knowledge_assistant_test`, applies `schema.sql` |
| Backend integration tests | App test database on `localhost:5434`; demo target on `localhost:5435` |
| Demo target credentials | `127.0.0.1:5435/demo_analytics`, `demo_reader` |
| Playwright E2E | Seeds and runs against the normal `DATABASE_URL`; the current spec exercises connection creation, testing, and editing |
| E2E teardown | Reseeds the app database |

Test target references:

- `apps/backend/test/connections.test.ts:20-23`
- `apps/backend/test/questions.test.ts:49-52`
- `apps/backend/test/schema.test.ts:22-25`
- `apps/backend/test/sqlExecution.test.ts:7-12`
- `apps/backend/test/conversations.test.ts:9-12`

## Related docs

- [Database index](./README.md)
- [Application database](./application-database.md)
- [Demo database](./demo-database.md)
- [Target databases](./target-databases.md)
- [API client call map](../api/client-call-map.md)
