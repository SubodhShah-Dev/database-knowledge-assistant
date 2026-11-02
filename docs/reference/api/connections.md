# Connections API

Source: `apps/backend/src/routes/connections.routes.ts`

All routes require authentication and operate only on the caller's connections.

## Connection shape

List, create, get, and update responses use safe columns only:

```json
{
  "id": "uuid",
  "engine": "postgres",
  "name": "Demo Analytics",
  "host": "127.0.0.1",
  "port": 5435,
  "database_name": "demo_analytics",
  "username": "demo_reader",
  "ssl_mode": "disable",
  "has_password": true,
  "has_sessions": false,
  "created_at": "2026-01-01T00:00:00.000Z",
  "updated_at": "2026-01-01T00:00:00.000Z"
}
```

Ciphertext, plaintext passwords, and MongoDB URIs are never returned.

## Supported engines

| Engine | Required fields |
| --- | --- |
| `postgres` | `host`, `port`, `database`, `username`, `password`, `sslMode` |
| `mysql` | `host`, `port`, `database`, `username`, `password`, `sslMode` |
| `mongodb` | `connectionUri`; `database` may come from the URI |

`sqlite` and `sqlserver` are rejected.

## `GET /api/connections`

Lists owned connections, newest first.

- `200` with an array of safe connection objects.

Client: `listConnections` at `apps/frontend/src/api/client.ts:110`, used by `ConnectionsPage.tsx:37` and `NewSessionPage.tsx:45`.

## `POST /api/connections`

Validates, encrypts, and stores a connection.

### Request

```json
{
  "engine": "postgres",
  "name": "Demo Analytics",
  "host": "127.0.0.1",
  "port": 5435,
  "database": "demo_analytics",
  "username": "demo_reader",
  "password": "demo_reader_password",
  "sslMode": "disable"
}
```

### Behavior

- Validates name, host, database, username, password, port, engine, and SSL mode.
- Parses MongoDB URIs and derives host, port, username, and database when possible.
- Runs host/SSRF validation. It does **not** connect to the target.
- Enforces `MAX_CONNECTIONS_PER_USER` (default 20).
- Encrypts the password and, for MongoDB, the URI.
- Returns the safe connection object.

### Responses

| Status | Meaning |
| --- | --- |
| `201` | Created |
| `400` | Invalid input, host rejected, or invalid target configuration |
| `409` | Duplicate name for this user |
| `422` | Connection limit reached |

Client: `createConnection` at `client.ts:114`, used by `ConnectionsPage.tsx:54`.

## `GET /api/connections/:id`

Returns one owned connection.

- `200` with the safe connection object.
- `404` if missing or owned by another user.

Client wrapper: none. The endpoint is implemented but currently unused.

## `PATCH /api/connections/:id`

Updates a connection. Omitted fields fall back to existing values.

### Request

Same fields as create. `password` may be omitted to keep the current password. For MongoDB, `connectionUri` may be omitted to keep the current URI.

### Behavior

- Rejects changing `engine` when the connection has sessions (`409`).
- Re-encrypts a supplied password or URI.
- Invalidates cached pools, clients, and schema snapshots.
- Returns the safe connection object.

### Responses

| Status | Meaning |
| --- | --- |
| `200` | Updated |
| `400` | Invalid input or host rejected |
| `404` | Not found |
| `409` | Duplicate name, or engine change with sessions |

Client: `updateConnection` at `client.ts:121`, used by `ConnectionsPage.tsx:52`.

## `DELETE /api/connections/:id`

Deletes a connection.

- Without `?force=true`, returns `409` if sessions exist.
- With `?force=true`, deletes the user's sessions for that connection first, then the connection.
- Cascades `qa_history` through the session delete.
- Invalidates cached pools, clients, and schema snapshots.
- `200` `{ "ok": true }`; `404` if missing.

Client: `deleteConnection` at `client.ts:128`, used by `ConnectionsPage.tsx:83` and `:92`.

## `POST /api/connections/:id/test`

Loads the stored connection, decrypts secrets, and tests the target.

### PostgreSQL

Runs:

- `SELECT version()`
- `SHOW transaction_read_only`
- role flags from `pg_roles`
- a write-privilege check across visible tables

Returns:

```json
{
  "ok": true,
  "serverVersion": "PostgreSQL ...",
  "sessionReadOnly": false,
  "roleIsSuperuser": false,
  "warning": "This role can write to at least one table. Use a read-only role for safety."
}
```

### MySQL-compatible

Runs `SELECT VERSION()` and returns read-only guidance.

### MongoDB

Runs `ping` against the configured database.

### Failure

Connection failures return `200` with:

```json
{ "ok": false, "error": "The database rejected the username or password." }
```

Missing connection returns `404`.

Client: `testConnection` at `client.ts:134`, used by `ConnectionsPage.tsx:64`.

## `GET /api/connections/:id/schema`

Returns the target schema snapshot.

### Query

- `?refresh=1` or `?refresh=true` bypasses the cache.

### Response

```json
{
  "connection": { "id": "uuid", "name": "Demo Analytics", "database": "demo_analytics" },
  "tables": [
    {
      "schema": "public",
      "name": "orders",
      "type": "table",
      "comment": null,
      "rowEstimate": 8,
      "columns": [
        {
          "name": "id",
          "dataType": "bigint",
          "nullable": false,
          "defaultValue": null,
          "isPrimaryKey": true,
          "isForeignKey": false,
          "comment": null
        }
      ]
    }
  ],
  "relationships": [
    {
      "name": "orders_customer_id_fkey",
      "from": { "schema": "public", "table": "orders", "columns": ["customer_id"] },
      "to": { "schema": "public", "table": "customers", "columns": ["id"] },
      "onDelete": "NO ACTION",
      "onUpdate": "NO ACTION"
    }
  ],
  "introspectedAt": "2026-01-01T00:00:00.000Z"
}
```

### Responses

| Status | Meaning |
| --- | --- |
| `200` | Snapshot returned |
| `404` | Connection not found |
| `502` | Target introspection failed; safe message returned |

Client: `getSchema` at `client.ts:138`, used by `NewSessionPage.tsx:79` and `SessionContextDrawer.tsx:81`.

## Related docs

- [API index](./README.md)
- [Target databases](../databases/target-databases.md)
- [Connection encryption concept](../../concepts/06-database-connections-encryption.md)
