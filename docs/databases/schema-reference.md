# Schema Reference

Canonical DDL for the app database and the demo target database. The source files are authoritative:

- `apps/backend/schema.sql`
- `apps/backend/demo/target-schema.sql`

## Application schema

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS database_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  engine text NOT NULL DEFAULT 'postgres'
    CHECK (engine IN ('postgres', 'mysql', 'mongodb')),
  name text NOT NULL,
  host text NOT NULL,
  port integer NOT NULL DEFAULT 5432,
  database_name text NOT NULL,
  connection_uri_encrypted text,
  username text NOT NULL,
  password_encrypted text NOT NULL,
  ssl_mode text NOT NULL DEFAULT 'prefer'
    CHECK (ssl_mode IN ('disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);

CREATE INDEX IF NOT EXISTS database_connections_owner_idx
  ON database_connections (owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS conversations (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES database_connections(id) ON DELETE RESTRICT,
  title text NOT NULL,
  selected_tables jsonb NOT NULL DEFAULT '[]',
  model_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversations_user_updated_idx
  ON conversations (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS conversations_connection_idx
  ON conversations (connection_id);

CREATE TABLE IF NOT EXISTS qa_history (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id bigint NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  question text NOT NULL,
  answer text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '[]',
  model text,
  answer_mode text CHECK (answer_mode IN ('data', 'schema', 'clarify')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS qa_history_conv_idx
  ON qa_history (conversation_id, id);

CREATE TABLE IF NOT EXISTS models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  model_id text NOT NULL UNIQUE,
  base_url text,
  api_key_encrypted text,
  is_enabled boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS models_single_default
  ON models ((true)) WHERE is_default;

CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

### Migration/cleanup behavior

`schema.sql` also contains:

- `ALTER TABLE qa_history ADD COLUMN IF NOT EXISTS answer_mode ...`
- `ALTER TABLE models ADD COLUMN IF NOT EXISTS api_key_encrypted text`
- A `DO` block that deletes legacy SQLite/SQL Server connections and drops `sqlite_path`.
- A guarded replacement of the engine check constraint.

Those statements exist to upgrade older databases. They do not mean SQLite or SQL Server are supported.

## Table summary

| Table | Primary key | Important constraints |
| --- | --- | --- |
| `users` | `id` | `email` unique; role check |
| `database_connections` | `id` | `(owner_id, name)` unique; engine/SSL checks; owner cascade |
| `conversations` | `id` | connection restrict; user cascade; `selected_tables` JSONB |
| `qa_history` | `id` | conversation cascade; user cascade; answer-mode check |
| `models` | `id` | `model_id` unique; one default |
| `app_settings` | `key` | Unused |

## Demo target schema

```sql
CREATE TABLE IF NOT EXISTS customers (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  country text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  category text NOT NULL,
  price numeric(10,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id bigserial PRIMARY KEY,
  customer_id bigint NOT NULL REFERENCES customers(id),
  status text NOT NULL,
  ordered_at timestamptz NOT NULL,
  total numeric(10,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  order_id bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id bigint NOT NULL REFERENCES products(id),
  quantity integer NOT NULL,
  unit_price numeric(10,2) NOT NULL,
  PRIMARY KEY (order_id, product_id)
);
```

### Demo role and grants

```sql
CREATE ROLE demo_reader LOGIN PASSWORD 'demo_reader_password';
GRANT CONNECT ON DATABASE demo_analytics TO demo_reader;
GRANT USAGE ON SCHEMA public TO demo_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO demo_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO demo_reader;
```

The actual file creates the role only if missing.

## Relationship reference

| From | To | On delete |
| --- | --- | --- |
| `database_connections.owner_id` | `users.id` | CASCADE |
| `conversations.user_id` | `users.id` | CASCADE |
| `conversations.connection_id` | `database_connections.id` | RESTRICT |
| `qa_history.user_id` | `users.id` | CASCADE |
| `qa_history.conversation_id` | `conversations.id` | CASCADE |
| `orders.customer_id` | `customers.id` | NO ACTION |
| `order_items.order_id` | `orders.id` | CASCADE |
| `order_items.product_id` | `products.id` | NO ACTION |

`conversations.model_id` has no foreign key.

## JSONB shapes

### `conversations.selected_tables`

```json
[
  { "schema": "public", "table": "orders" },
  { "schema": "public", "table": "customers" }
]
```

### `qa_history.evidence`

Query evidence:

```json
{
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
```

Schema evidence:

```json
{
  "kind": "schema",
  "tables": [],
  "relationships": [],
  "selectedTables": [],
  "focus": null
}
```

## Related docs

- [Application database](./application-database.md)
- [Demo database](./demo-database.md)
- [Query map](./query-map.md)
