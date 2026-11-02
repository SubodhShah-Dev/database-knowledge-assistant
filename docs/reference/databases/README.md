# Database Reference

> What databases the app uses, what each one is responsible for, what schema it has, and when the code queries it.

## Inventory

| Database | Engine | Dev address | Owner / role | Responsibility |
| --- | --- | --- | --- | --- |
| `database_knowledge_assistant` | PostgreSQL 16 | `localhost:5434` | `app_user` | Application system of record |
| `demo_analytics` | PostgreSQL 16 | `localhost:5435` | `demo_admin`; read-only `demo_reader` | Sample target for local development, tests, and demos |
| `database_knowledge_assistant_test` | PostgreSQL 16 | `localhost:5434` | `app_user` | Ephemeral Jest database, recreated per run |
| User target databases | PostgreSQL, MySQL/MariaDB/TiDB, MongoDB | User-supplied | User-supplied | External data sources introspected and queried read-only |

The app supports exactly three target engines:

- PostgreSQL
- MySQL-compatible servers (MySQL, MariaDB, TiDB)
- MongoDB

SQL Server and SQLite are **not** supported.

## Topology

```text
Browser
  |
  | REST + SSE
  v
Express API
  |
  |-- app PostgreSQL
  |     users, database_connections, conversations, qa_history, models, app_settings
  |
  |-- target database
  |     PostgreSQL / MySQL-compatible / MongoDB
  |     schema introspection + read-only queries
  |
  `-- LLM provider
        planning + answer generation
```

The browser never opens a database connection. The API decrypts target credentials, validates every query, and writes only to the app database.

## Responsibilities

| Database | Owns | Does not own |
| --- | --- | --- |
| App database | Accounts, encrypted connection metadata, sessions, table scope, Q&A history, evidence, model registry | User data, target schema, query results |
| Demo database | Sample customers/products/orders data and a read-only role | Application state |
| Target databases | The user's actual data and permissions | App users, sessions, or evidence |
| Test database | Isolated app-schema copy for Jest | Production data |

## Configuration

| Variable | Database |
| --- | --- |
| `DATABASE_URL` | App PostgreSQL |
| `TEST_DATABASE_URL` | Jest app database override |
| `TEST_ADMIN_URL` | Jest admin connection for create/drop |
| `SQL_SCHEMA_CACHE_MS` | Target schema cache TTL |
| `SQL_MAX_ROWS`, `SQL_TIMEOUT_MS` | Target query limits |
| `DB_CONNECT_TIMEOUT_MS`, `MYSQL_CONNECT_TIMEOUT_MS`, `MYSQL_RECORD_COUNT_TIMEOUT_MS` | Target connection/query timeouts |
| `DB_ALLOWED_HOSTS` | Target host allowlist |
| `MAX_CONNECTIONS_PER_USER`, `MAX_SELECTED_TABLES` | Connection/scope limits |

## Documentation map

- [Application database](./application-database.md) — system of record, tables, lifecycle, query locations.
- [Demo database](./demo-database.md) — sample schema, seed data, read-only role.
- [Target databases](./target-databases.md) — supported engines, introspection, execution, safety.
- [Schema reference](./schema-reference.md) — canonical DDL and table-by-table details.
- [Query map](./query-map.md) — every app and target database query site.

## Related docs

- [API reference](../api/README.md)
- [Current state](../../architecture/current-state.md)
- [Docker, Postgres & environment](../../concepts/03-docker-postgres.md)
