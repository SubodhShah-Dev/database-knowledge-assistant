# Demo Database

Database: `demo_analytics`  
Engine: PostgreSQL 16  
Default dev address: `localhost:5435`  
Owner: `demo_admin`  
Read-only role: `demo_reader`  
Schema source: `apps/backend/demo/target-schema.sql`

## Responsibility

The demo database is a safe, realistic target for:

- Local development and manual exploration.
- Schema introspection and relationship discovery.
- Read-only query execution.
- Backend integration tests.
- Screenshots and demos.

It is not part of the application's persistence and contains no user or session data.

## Local credentials

Use this connection in the UI:

```text
Name:     Demo Analytics
Host:     127.0.0.1
Port:     5435
Database: demo_analytics
User:     demo_reader
Password: demo_reader_password
SSL:      disable
```

`demo_admin` owns the database. `demo_reader` is intentionally limited to read-only access.

## Schema

### `customers`

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | `bigserial` | Primary key |
| `name` | `text` | Not null |
| `email` | `text` | Not null, unique |
| `country` | `text` | Not null |
| `created_at` | `timestamptz` | Not null, default `now()` |

### `products`

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | `bigserial` | Primary key |
| `name` | `text` | Not null |
| `category` | `text` | Not null |
| `price` | `numeric(10,2)` | Not null |

### `orders`

| Column | Type | Constraints |
| --- | --- | --- |
| `id` | `bigserial` | Primary key |
| `customer_id` | `bigint` | Not null, FK `customers(id)` |
| `status` | `text` | Not null |
| `ordered_at` | `timestamptz` | Not null |
| `total` | `numeric(10,2)` | Not null |

### `order_items`

| Column | Type | Constraints |
| --- | --- | --- |
| `order_id` | `bigint` | Not null, FK `orders(id)` on delete cascade |
| `product_id` | `bigint` | Not null, FK `products(id)` |
| `quantity` | `integer` | Not null |
| `unit_price` | `numeric(10,2)` | Not null |

Primary key: `(order_id, product_id)`.

## Relationships

```text
customers 1 ── * orders 1 ── * order_items * ── 1 products
```

Direct foreign keys:

- `orders.customer_id → customers.id`
- `order_items.order_id → orders.id` with cascade
- `order_items.product_id → products.id`

The introspection API reports these relationships and their delete/update actions.

## Seed data

| Table | Rows |
| --- | --- |
| `customers` | 5 |
| `products` | 5 |
| `orders` | 8 |
| `order_items` | 10 |

Sequences are advanced after insert so new rows do not collide.

## Read-only role

`target-schema.sql` creates `demo_reader` if missing and grants:

```sql
GRANT CONNECT ON DATABASE demo_analytics TO demo_reader;
GRANT USAGE ON SCHEMA public TO demo_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO demo_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO demo_reader;
```

## Initialization lifecycle

`docker-compose.yml` mounts the schema into the `demo-postgres` init directory:

```text
./apps/backend/demo/target-schema.sql -> /docker-entrypoint-initdb.d/01-target.sql
```

The script runs only when the `demo_pgdata` volume is first created.

To reset the demo database:

```bash
docker compose down -v
docker compose up -d --wait
```

This also removes the app database volume. Reapply the app schema and seed afterward.

## When and where it is queried

| Context | Query path |
| --- | --- |
| Connection test | `POST /api/connections/:id/test` → PostgreSQL version/role/grants check |
| Schema endpoint | `GET /api/connections/:id/schema` → PostgreSQL introspection |
| New session | `POST /api/conversations` → schema snapshot for default scope |
| Scope edit | `PATCH /api/conversations/:id` → refreshed schema validation |
| Question | `POST /api/questions` → schema snapshot, then read-only query |
| Record counts | `POST /api/questions` → `COUNT(*)` across selected tables |
| Backend tests | Real `demo_analytics` on `127.0.0.1:5435` as `demo_reader` |

The demo database is never written by the app. The API only introspects it and executes read-only queries.

## Test database is separate

Jest uses:

- App database: `database_knowledge_assistant_test` on `localhost:5434`.
- Target database: the shared `demo_analytics` on `localhost:5435`.

There is no separate throwaway demo target database.

## Related docs

- [Database index](./README.md)
- [Target databases](./target-databases.md)
- [Query map](./query-map.md)
- [Docker concept](../../concepts/03-docker-postgres.md)
