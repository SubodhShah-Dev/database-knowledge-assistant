# System Overview

A compact map of the runtime shape. For the authoritative inventory and component
list, see [Current state](current-state.md).

## Topology

```text
Browser (React + TypeScript, Vite)
  |
  | REST + SSE (HttpOnly JWT cookie; Bearer fallback)
  v
Express API (Node.js + TypeScript)
  |-- auth / connections / conversations / questions / models / recovery
  |-- App PostgreSQL
  |     users, database_connections, conversations, qa_history, models, app_settings
  |-- Target adapters
  |     PostgreSQL (pg), MySQL-compatible (mysql2), MongoDB (mongodb)
  `-- OpenAI-compatible LLM
        planner, repair, answer, failover
```

The browser never opens a database connection. The API decrypts target
credentials, validates every query, executes it read-only, and persists evidence.

## Responsibilities

| Layer | Owns |
| --- | --- |
| Web app | Authentication flow, connection and session UI, schema/relationship explorers, SSE rendering |
| API | Auth, ownership checks, encryption, schema introspection, planning, validation, execution, persistence |
| App database | Accounts, encrypted connection metadata, sessions, table scope, Q&A history, evidence, model registry |
| Target database | The user's data and permissions; queried read-only |
| LLM provider | Query planning and answer synthesis; never receives raw credentials |

## Key invariants

- A session is bound to exactly one connection; the connection cannot be changed.
- Every question is scoped to the session's saved tables or collections.
- SQL runs inside a read-only transaction with a timeout and row cap; MongoDB uses
  an allowlisted pipeline and a read-only account.
- Credentials are envelope-encrypted and never returned to the browser.
- Other users' resources return `404`, not `403`.

## Next

- [Request lifecycle](request-lifecycle.md)
- [Current state](current-state.md)
- [API reference](../reference/api/README.md)
- [Database reference](../reference/databases/README.md)
