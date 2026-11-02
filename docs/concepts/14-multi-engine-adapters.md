# 14 — Multi-engine adapters

> One session model, one scope model, one evidence model — three target engines behind engine-specific adapters.

**Back to:** [Concept index](README.md) · [Target databases](../reference/databases/target-databases.md)

## What it is

The app supports:

- PostgreSQL via `pg`
- MySQL/MariaDB/TiDB via `mysql2`
- MongoDB via `mongodb`

Each engine has different connection fields, schema metadata, query grammar, and execution semantics. The adapter layer keeps those differences out of the routes.

## Where it lives

| Concern | File |
| --- | --- |
| Engine dispatch and validation | `apps/backend/src/services/databaseAdapters.ts` |
| PostgreSQL pools and test | `apps/backend/src/services/connectionPool.ts` |
| PostgreSQL introspection | `apps/backend/src/services/introspection.ts` |
| PostgreSQL execution | `apps/backend/src/services/sqlExecution.ts` |
| PostgreSQL AST guard | `apps/backend/src/services/sqlGuard.ts` |
| Ownership and schema dispatch | `apps/backend/src/services/connectionAccess.ts` |
| Host/SSRF guard | `apps/backend/src/services/hostGuard.ts` |

## Connection shape

SQL engines use:

```json
{
  "engine": "postgres",
  "host": "127.0.0.1",
  "port": 5435,
  "database": "demo_analytics",
  "username": "demo_reader",
  "password": "demo_reader_password",
  "sslMode": "disable"
}
```

MongoDB uses:

```json
{
  "engine": "mongodb",
  "connectionUri": "mongodb+srv://user:password@cluster.example/db"
}
```

The API derives host, port, username, and database from the URI where possible.

## Schema discovery

| Engine | Source | Notes |
| --- | --- | --- |
| PostgreSQL | `pg_class`, `pg_constraint`, `pg_attribute`, `pg_attrdef` | Full columns, PK/FK, relationships, comments, row estimates |
| MySQL | `information_schema` | Current database only; FK actions reported as `NO ACTION` |
| MongoDB | `listCollections` + `$sample` | Field types inferred from 20 documents; no relationships |

## Query validation

| Engine | Guard |
| --- | --- |
| PostgreSQL | `pgsql-ast-parser`; one `SELECT`-class statement; scope allowlist |
| MySQL | `node-sql-parser`; one `SELECT`-class statement; scope allowlist |
| MongoDB | JSON shape validation; allowlisted stages/operators; one collection |

## Execution

| Engine | Read-only strategy | Limits |
| --- | --- | --- |
| PostgreSQL | `BEGIN TRANSACTION READ ONLY`, `default_transaction_read_only=on`, rollback | `SQL_MAX_ROWS`, `SQL_TIMEOUT_MS` |
| MySQL | `SET TRANSACTION READ ONLY` (TiDB noop tolerated), begin/rollback | Same, plus MySQL-specific timeouts |
| MongoDB | Allowlisted aggregation or `countDocuments`; no writes | `maxTimeMS`, row cap, 5 MB cap |

## Record counts

`buildTableRecordCountQuery` produces:

- PostgreSQL: `SELECT COUNT(*) ... UNION ALL ...`
- MySQL: internal `tableRecordCounts` operation with per-table `COUNT(*)`
- MongoDB: internal `countDocuments` operation

The result is normalized into the same evidence shape.

## Pitfalls

- MySQL does not expose FK delete/update actions through the introspection queries used here.
- MongoDB has no declared schema; fields missing from the sample may be invisible.
- TiDB may reject `SET TRANSACTION READ ONLY` with a noop error; the adapter tolerates that specific error.
- PostgreSQL `search_path` is fixed to `public` during introspection.
- The demo target remains PostgreSQL even though other engines are supported.

## Verification

```bash
npm run typecheck
npm test
```

Adapter unit tests cover SQL/Mongo validation and scope rejection. Integration tests use the demo PostgreSQL target.

## Related docs

- [Connections API](../reference/api/connections.md)
- [Questions API](../reference/api/questions.md)
- [Schema reference](../reference/databases/schema-reference.md)
- [Query map](../reference/databases/query-map.md)
