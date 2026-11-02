# Target Databases

Target databases are user-supplied data sources. The app introspects their schema and runs bounded, read-only queries. It does not write to them.

## Supported engines

| Engine | Driver | Connection shape | Introspection | Query execution |
| --- | --- | --- | --- | --- |
| PostgreSQL | `pg` | host, port, database, user, password, SSL mode | `pg_class`, `pg_constraint`, `pg_attribute`, `pg_attrdef` | One read-only `SELECT` in a read-only transaction |
| MySQL/MariaDB/TiDB | `mysql2` | host, port, database, user, password, SSL mode | `information_schema` tables, columns, key usage | One read-only `SELECT`, or internal exact-count operation |
| MongoDB | `mongodb` | connection URI | `listCollections` plus sampled fields | Allowlisted aggregation or `countDocuments` |

Not supported: SQL Server and SQLite.

## Connection model

SQL engines store:

- `host`
- `port`
- `database_name`
- `username`
- `password_encrypted`
- `ssl_mode`

MongoDB stores:

- `connection_uri_encrypted`
- derived host, port, username, and database where possible

All secrets are encrypted with AES-256-GCM before storage. `toTargetConfig` decrypts only inside the API.

## What “schema” means

### PostgreSQL

The snapshot includes:

- Tables, partitioned tables, and views in non-system schemas where the role has `USAGE` and `SELECT`.
- Columns, types, nullability, defaults, and comments.
- Primary keys.
- Foreign keys and direct relationships.
- Delete/update actions.
- Row estimates.

### MySQL-compatible

The snapshot includes:

- Base tables and views in the current database (`DATABASE()`).
- Columns, types, nullability, defaults, and primary keys.
- Foreign keys from `information_schema.key_column_usage`.
- Relationships. Delete/update actions are reported as `NO ACTION` because they are not introspected.

### MongoDB

The snapshot includes:

- Collections excluding `system.*`.
- Field names and BSON types inferred from a 20-document sample per collection.
- `_id` marked as a primary key.
- No relationships.

Fields absent from the sample may not appear in the session picker.

## Schema cache

- Snapshots are cached per connection.
- TTL: `SQL_SCHEMA_CACHE_MS` (default 300000 ms).
- `?refresh=1` bypasses the cache.
- Connection update/delete invalidates the snapshot.
- Scope edits refresh the snapshot before validating tables.

## Scope

Each session stores a `selected_tables` array of `{ schema, table }`.

- Default: all tables if the count is within `MAX_SELECTED_TABLES` (default 100).
- Every query must reference only selected tables/collections.
- A table missing from the current snapshot invalidates the session scope.
- MongoDB scope uses collection names; `schema` is the database name.

## Connection testing

`POST /api/connections/:id/test`:

### PostgreSQL

- `SELECT version()`
- `SHOW transaction_read_only`
- `pg_roles` flags for the current role
- write-privilege check across visible tables

### MySQL-compatible

- `SELECT VERSION()`

### MongoDB

- `ping`

Create and update connection do **not** connect to the target. They only validate the host/SSRF rules and URI shape.

## Query execution

### PostgreSQL

`runReadOnlyQuery`:

1. Acquire a pool client.
2. `BEGIN TRANSACTION READ ONLY`.
3. Set `statement_timeout` and `idle_in_transaction_session_timeout`.
4. Wrap the query as `SELECT * FROM (<sql>) AS _session_query LIMIT maxRows + 1`.
5. Roll back.
6. Normalize values to JSON-safe forms.

The target pool also sets `default_transaction_read_only=on`.

### MySQL-compatible

`runDatabaseQuery`:

1. Open a connection with a connect timeout.
2. `SET TRANSACTION READ ONLY` (TiDB “noop” errors are tolerated).
3. Begin a transaction.
4. Run a wrapped `SELECT ... LIMIT maxRows + 1`, or loop exact `COUNT(*)` for record-count questions.
5. Roll back.
6. Close the connection.

### MongoDB

`runDatabaseQuery`:

- `countDocuments` for record-count questions.
- Aggregation pipeline with `$limit maxRows + 1` for data questions.
- `maxTimeMS` enforced.
- Cursor closed after reading.
- Results capped at 5 MB.

Allowed aggregation stages include `$match`, `$project`, `$sort`, `$limit`, `$skip`, `$group`, `$unwind`, `$count`, `$addFields`, `$set`, `$unset`, `$replaceRoot`, `$replaceWith`, `$bucket`, `$bucketAuto`, and `$sample`.

Rejected operators include `$where`, `$function`, `$accumulator`, `$out`, `$merge`, `$lookup`, `$unionWith`, `$graphLookup`, `$documents`, `$search`, `$vectorSearch`, `$collStats`, `$indexStats`, `$currentOp`, `$listSessions`, and `$planCacheStats`.

## Limits

| Setting | Default | Hard cap |
| --- | --- | --- |
| `SQL_MAX_ROWS` | 100 | 1000 |
| `SQL_TIMEOUT_MS` | 5000 | 60000 |
| `DB_CONNECT_TIMEOUT_MS` | 5000 | — |
| `MYSQL_CONNECT_TIMEOUT_MS` | 15000 | — |
| `MYSQL_RECORD_COUNT_TIMEOUT_MS` | 30000 | — |
| MongoDB result bytes | — | 5 MB |

## Host safety

`hostGuard.ts`:

- Blocks link-local, multicast, reserved, and cloud-metadata addresses.
- Normalizes IPv4-mapped IPv6.
- Rejects Unix socket paths.
- Resolves hostnames and checks every address.
- Supports optional `DB_ALLOWED_HOSTS` for hostnames, IPs, and CIDRs.
- DNS rebinding remains a residual risk.

## Pool and client lifecycle

| Engine | Lifecycle |
| --- | --- |
| PostgreSQL | Per-connection pool, max 2 connections, idle 30s, max 20 cached pools |
| MySQL | Per-query connection, closed after execution |
| MongoDB | Per-connection client cache, max 20 clients |
| Schema | Per-connection snapshot cache with TTL and invalidation |

## When and where queried

| Trigger | Code path | Operation |
| --- | --- | --- |
| Create/update connection | `validateConnectionTarget` → `assertNetworkHost` | Host/DNS validation only |
| Test connection | `testDatabaseConnection` (`databaseAdapters.ts:690`) | Version/role/ping |
| Schema endpoint | `getConnectionSchema` (`connectionAccess.ts:56`) | Introspection |
| New session | `getConnectionSchema` | Default scope validation |
| Scope edit | `getConnectionSchema(..., true)` | Refreshed scope validation |
| Question | `getConnectionSchema` then `runDatabaseQuery` (`databaseAdapters.ts:895`) | Introspection + read-only query |
| Record-count question | `buildTableRecordCountQuery` (`databaseAdapters.ts:32`) | Exact counts |

## Related docs

- [Database index](./README.md)
- [Application database](./application-database.md)
- [Demo database](./demo-database.md)
- [Query map](./query-map.md)
- [Read-only execution concept](../../concepts/08-readonly-sql-execution.md)
- [Schema introspection concept](../../concepts/07-schema-introspection-relationships.md)
