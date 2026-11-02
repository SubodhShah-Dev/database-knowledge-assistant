# Application Database

Database: `database_knowledge_assistant`  
Engine: PostgreSQL 16  
Default dev address: `localhost:5434`  
Role: `app_user`  
Schema source: `apps/backend/schema.sql`

## Responsibility

The application database is the system of record. It stores:

- User accounts and roles.
- Encrypted target-connection metadata.
- Sessions and their selected table/collection scope.
- Q&A turns, answers, evidence, model, and answer mode.
- Provider/model registry and priority order.
- A reserved settings table.

It never stores target data, query result sets, or database credentials in plaintext.

## Schema

### `users`

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | `uuid` | Primary key, `gen_random_uuid()` |
| `email` | `text` | Not null, unique |
| `password_hash` | `text` | Not null |
| `role` | `text` | Not null, default `user`, check `user/admin` |
| `created_at` | `timestamptz` | Not null, default `now()` |

### `database_connections`

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | `uuid` | Primary key |
| `owner_id` | `uuid` | Not null, FK `users(id)` on delete cascade |
| `engine` | `text` | Not null, default `postgres`, check `postgres/mysql/mongodb` |
| `name` | `text` | Not null |
| `host` | `text` | Not null |
| `port` | `integer` | Not null, default `5432` |
| `database_name` | `text` | Not null |
| `connection_uri_encrypted` | `text` | Nullable; MongoDB URI |
| `username` | `text` | Not null |
| `password_encrypted` | `text` | Not null |
| `ssl_mode` | `text` | Not null, default `prefer`, check disable/allow/prefer/require/verify-ca/verify-full |
| `created_at` | `timestamptz` | Not null, default `now()` |
| `updated_at` | `timestamptz` | Not null, default `now()` |

Unique: `(owner_id, name)`.

### `conversations`

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | `bigserial` | Primary key |
| `user_id` | `uuid` | Not null, FK `users(id)` on delete cascade |
| `connection_id` | `uuid` | Not null, FK `database_connections(id)` on delete restrict |
| `title` | `text` | Not null |
| `selected_tables` | `jsonb` | Not null, default `[]` |
| `model_id` | `uuid` | Nullable, soft reference to `models.id` |
| `created_at` | `timestamptz` | Not null, default `now()` |
| `updated_at` | `timestamptz` | Not null, default `now()` |

`connection_id` is immutable through the API. A session cannot switch connections.

### `qa_history`

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | `bigserial` | Primary key |
| `user_id` | `uuid` | Not null, FK `users(id)` on delete cascade |
| `conversation_id` | `bigint` | Not null, FK `conversations(id)` on delete cascade |
| `question` | `text` | Not null |
| `answer` | `text` | Not null |
| `evidence` | `jsonb` | Not null, default `[]` |
| `model` | `text` | Nullable |
| `answer_mode` | `text` | Nullable, check `data/schema/clarify` |
| `created_at` | `timestamptz` | Not null, default `now()` |

`answer_mode` is added by `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for existing deployments.

### `models`

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | `uuid` | Primary key |
| `label` | `text` | Not null |
| `model_id` | `text` | Not null, unique |
| `base_url` | `text` | Nullable |
| `api_key_encrypted` | `text` | Nullable |
| `is_enabled` | `boolean` | Not null, default `true` |
| `is_default` | `boolean` | Not null, default `false` |
| `sort_order` | `integer` | Not null, default `0` |
| `created_at` | `timestamptz` | Not null, default `now()` |

A partial unique index enforces at most one default model.

### `app_settings`

| Column | Type | Constraints |
| --- | --- | --- |
| `key` | `text` | Primary key |
| `value` | `text` | Not null |
| `updated_at` | `timestamptz` | Not null, default `now()` |

Defined in `schema.sql`, but no application code currently reads or writes it.

## Relationships and delete behavior

```text
users
  ├── database_connections   (owner_id, CASCADE)
  ├── conversations          (user_id, CASCADE)
  └── qa_history             (user_id, CASCADE)

database_connections
  └── conversations          (connection_id, RESTRICT)

conversations
  └── qa_history             (conversation_id, CASCADE)

models
  └── conversations.model_id (soft reference, no FK)
```

Deleting a connection with sessions is blocked unless `?force=true`, which deletes the user's sessions first. Deleting a session cascades its history.

## Indexes

| Index | Purpose |
| --- | --- |
| `database_connections_owner_idx` | List connections by owner/recency |
| `conversations_user_updated_idx` | Session history ordering |
| `conversations_connection_idx` | Session counts and connection deletion checks |
| `qa_history_conv_idx` | Load turns for a session |
| `models_single_default` | Enforce one default model |

## Encrypted fields

| Field | Content |
| --- | --- |
| `database_connections.password_encrypted` | Target password |
| `database_connections.connection_uri_encrypted` | MongoDB URI |
| `models.api_key_encrypted` | Provider API key |

Encryption uses AES-256-GCM with `CONNECTION_ENCRYPTION_KEY`. Stored format:

```text
v1:<iv-base64>:<auth-tag-base64>:<ciphertext-base64>
```

Decryption happens only inside the API. Safe connection responses expose `has_password` instead of ciphertext.

## Schema management

- `apps/backend/schema.sql` is the source of truth.
- `npm run db:setup` applies it through the app Postgres container and then runs `npm run seed`.
- Jest `globalSetup.cjs` applies the same schema to a throwaway test database.
- There is no migration version table. The schema file is written to be safely reapplied: `IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, and guarded constraint changes.
- The `DO` block removes legacy SQLite/SQL Server rows and columns. It is intentional cleanup, not current engine support.

## When and where it is queried

Full details are in the [query map](./query-map.md). Summary:

| Area | Main sites |
| --- | --- |
| Auth | `auth.routes.ts:27,46` |
| Connections | `connections.routes.ts` and `connectionAccess.ts:30` |
| Sessions | `conversations.routes.ts` |
| Questions | `questions.routes.ts:116,150,158,220` and `modelConfig.ts:13,27` |
| Models | `models.routes.ts` |
| Seed | `seed.ts:7,15,20,22` |

## Related docs

- [Database index](./README.md)
- [Schema reference](./schema-reference.md)
- [Query map](./query-map.md)
- [Connections API](../api/connections.md)
- [Auth concept](../../concepts/05-auth-jwt.md)
