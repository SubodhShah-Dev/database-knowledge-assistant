# Conversations API

Source: `apps/backend/src/routes/conversations.routes.ts`

A conversation is a session tied to exactly one connection. The connection is immutable for the life of the session.

## Conversation shape

```json
{
  "id": 1,
  "title": "Revenue by country",
  "connectionId": "uuid",
  "selectedTables": [{ "schema": "public", "table": "orders" }],
  "modelId": "uuid-or-null",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

List responses also include:

```json
{
  "connection": {
    "id": "uuid",
    "name": "Demo Analytics",
    "database": "demo_analytics"
  }
}
```

Detail responses add `turns`.

## `GET /api/conversations`

Lists owned sessions, newest updated first.

- Joins `conversations` with `database_connections` to include connection name/database.
- `200` with an array of conversation summaries.

Client: `listConversations` at `apps/frontend/src/api/client.ts:144`, used by `useSessions.ts:41` and consumed by `SessionsPage` and `SessionsDrawer`.

## `POST /api/conversations`

Creates a session.

### Request

```json
{
  "connectionId": "uuid",
  "tables": [{ "schema": "public", "table": "orders" }],
  "modelId": "uuid-or-model-id"
}
```

`tables` and `modelId` are optional.

### Behavior

- Requires `connectionId` and verifies ownership.
- Loads the target schema snapshot.
- If `tables` is omitted, defaults to all tables when the count is within `MAX_SELECTED_TABLES` (default 100).
- Validates that every selected table exists in the snapshot.
- Validates `modelId` against enabled models, accepting either the row UUID or the provider model identifier.
- Inserts the session with title `New session`.
- Returns `201` with the session and connection summary.

### Responses

| Status | Meaning |
| --- | --- |
| `201` | Created |
| `400` | Missing `connectionId`, or malformed table entries |
| `404` | Connection not found |
| `422` | Invalid table scope or unavailable model |
| `502` | Schema introspection failed |

Client: `createConversation` at `client.ts:152`, used by `NewSessionPage.tsx:124`.

## `GET /api/conversations/:id`

Returns session detail.

- `200` with the session, connection summary, and `turns`.
- `404` if the session or connection is missing.

Turn shape:

```json
{
  "id": 42,
  "question": "How many orders?",
  "answer": "...",
  "evidence": [],
  "model": "openai/gpt-oss-120b",
  "mode": "data",
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

Client: `getConversation` at `client.ts:148`, used by `ChatPage.tsx:144`.

## `PATCH /api/conversations/:id`

Updates title, table scope, or model.

### Request

```json
{
  "title": "New title",
  "tables": [{ "schema": "public", "table": "orders" }],
  "modelId": null
}
```

All fields are optional. `connectionId` is rejected.

### Behavior

- Rejects `connectionId` with `400`; start a new session to change connections.
- Title must be non-empty and at most 200 characters.
- `modelId` accepts an enabled model UUID or model identifier; `null` clears the pinned model.
- When `tables` is supplied, refreshes the schema and validates the new scope.
- Updates `updated_at`.

### Responses

| Status | Meaning |
| --- | --- |
| `200` | Updated |
| `400` | `connectionId` supplied, invalid title, or malformed table entries |
| `404` | Session or connection not found |
| `422` | Invalid scope or unavailable model |
| `502` | Schema introspection failed |

Client: `updateConversation` at `client.ts:163`, used by:

- `useSessions.ts:76` for renaming
- `ChatPage.tsx:407` for model selection
- `ChatPage.tsx:447` for title updates
- `SessionContextDrawer.tsx:167` for table scope

## `DELETE /api/conversations/:id`

Deletes the session. `qa_history` cascades.

- `200` `{ "ok": true }`
- `404` if not found

Client: `deleteConversation` at `client.ts:173`, used by `useSessions.ts:57` and consumed by `SessionsPage` and `SessionsDrawer`.

## Scope rules

- `selectedTables` is a JSON array of `{ schema, table }`.
- Duplicate tables are rejected.
- `MAX_SELECTED_TABLES` defaults to 100.
- An empty scope is rejected when creating or asking.
- Tables must still exist when the session is created, edited, or used.

## Related docs

- [API index](./README.md)
- [Questions and SSE](./questions.md)
- [Application database](../databases/application-database.md)
