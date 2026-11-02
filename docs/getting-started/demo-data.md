# Demo Data

The compose stack includes a sample analytics database so you can exercise the
full flow without connecting to a real system.

## Connect from the UI

Create a connection with these values:

```text
Name:     Demo Analytics
Engine:   PostgreSQL
Host:     127.0.0.1
Port:     5435
Database: demo_analytics
User:     demo_reader
Password: demo_reader_password
SSL:      disable
```

`demo_reader` has `SELECT` only, which is what the app expects from a target
database. Use `demo_admin` / `demo_admin_password` only when you need to modify
the demo schema.

## What is inside

The demo database contains `customers`, `products`, `orders`, and `order_items`
with foreign keys between them, plus seed rows for common question types.

- [Demo database reference](../reference/databases/demo-database.md) — schema, seed data, and grants.
- [Schema reference](../reference/databases/schema-reference.md) — canonical DDL for the app and demo databases.
- [Query map](../reference/databases/query-map.md) — where each database is queried in the code.

## Related

- [Quickstart](quickstart.md)
- [Local setup](local-setup.md)
- [Demo database concept](../concepts/03-docker-postgres.md)
