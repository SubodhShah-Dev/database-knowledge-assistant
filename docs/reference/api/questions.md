# Questions API and SSE

Source: `apps/backend/src/routes/questions.routes.ts`

## `POST /api/questions`

Plans, validates, executes, and streams an answer for one question in a session.

### Request

```json
{
  "question": "How many orders were placed last month?",
  "conversationId": 1,
  "mode": "auto"
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `question` | yes | Trimmed, non-empty, max 2000 characters |
| `conversationId` | yes | Positive integer |
| `mode` | no | `auto`, `data`, or `schema`; defaults to `auto` |

### Pre-stream validation

The route returns normal JSON before opening the stream when:

| Status | Condition |
| --- | --- |
| `400` | Missing question, invalid mode, question too long, invalid conversation id |
| `404` | Session or connection not found |
| `422` | Invalid table scope or query validation failure |
| `502` | Schema introspection or target database failure |
| `503` | LLM unavailable before streaming |
| `504` | MySQL-compatible connection timeout before the question can run |

### Flow

1. Load the conversation and owned connection.
2. Load or refresh the schema snapshot.
3. Validate the saved table scope against the snapshot.
4. Load the last six Q&A turns for context.
5. Resolve the session model or the Auto model chain.
6. Plan:
   - `schema` mode answers from metadata.
   - Record-count questions use exact counts across selected tables/collections.
   - Otherwise the LLM returns `data`, `schema`, or `clarify`.
7. For `data`, validate the query against the engine and scope.
8. On validation failure, ask the LLM to repair once.
9. Open the SSE stream.
10. Emit `status`/`evidence`/`token` events.
11. Persist the turn and evidence in one transaction.
12. Emit `done` or `error`.

### SSE response

Headers:

```http
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

Event sequence:

```text
status (planning)
  -> status (running_query)      # data mode only
  -> evidence
  -> token*
  -> done
```

Schema mode skips `running_query`. Clarify mode emits a token answer and then `done`.

#### `status`

```json
{ "phase": "planning", "label": "Understanding the question" }
```

```json
{ "phase": "running_query", "label": "Running read-only query" }
```

#### `evidence`

```json
{
  "evidence": {
    "kind": "query",
    "sql": "SELECT ...",
    "columns": [{ "name": "count", "dataType": "int8" }],
    "rows": [[8]],
    "rowCount": 1,
    "truncated": false,
    "executionMs": 12,
    "tables": [{ "schema": "public", "table": "orders" }],
    "language": "sql"
  }
}
```

Schema evidence uses `kind: "schema"` with tables, columns, and relationships.

#### `token`

```json
{ "text": "There were " }
```

#### `done`

```json
{
  "conversationId": 1,
  "messageId": 42,
  "answer": "There were 8 orders...",
  "model": "openai/gpt-oss-120b",
  "mode": "data"
}
```

#### `error`

```json
{
  "error": "The query took too long and was cancelled.",
  "code": "timeout",
  "sql": "SELECT ..."
}
```

Post-stream error codes:

| Code | Meaning |
| --- | --- |
| `timeout` | Target query exceeded its timeout |
| `db_error` | Target database rejected or failed the query |
| `validation_failed` | Query failed validation and repair did not produce a valid plan |
| `llm_unavailable` | Provider failed during streaming |
| `empty_answer` | Model produced no answer text |
| `persist_failed` | Answer could not be saved |

### Answer modes

| Mode | Behavior |
| --- | --- |
| `auto` | Planner decides data, schema, or clarify |
| `data` | Planner is asked for a query; record-count questions use exact counts |
| `schema` | Answers from schema metadata only; record-count questions return a clarification |

### Record-count questions

When the question is detected as a table/collection record-count comparison:

- Selected tables or collections are counted exactly.
- PostgreSQL/MySQL use `COUNT(*)`.
- MongoDB uses `countDocuments`.
- Relationship counts are included when the question asks for them.
- MySQL-compatible record-count queries use `MYSQL_RECORD_COUNT_TIMEOUT_MS` (default 30000).

### Client path

`streamQuestion` at `apps/frontend/src/api/client.ts:211`, used by `ChatPage.tsx:250`.

The client:

- Sends `Authorization`, `Content-Type: application/json`, and `Accept: text/event-stream`.
- Parses SSE blocks split on blank lines.
- Dispatches `status`, `evidence`, `token`, `done`, and `error`.
- Clears auth and redirects on `401`.
- Supports `AbortSignal`.

### Abort behavior

If the client disconnects:

- The API aborts the upstream LLM request.
- The turn is not persisted.
- The stream stops.

## Related docs

- [API index](./README.md)
- [Conversations](./conversations.md)
- [Target databases](../databases/target-databases.md)
- [Read-only execution concept](../../concepts/08-readonly-sql-execution.md)
