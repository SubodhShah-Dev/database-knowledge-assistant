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

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'demo_reader') THEN
    CREATE ROLE demo_reader LOGIN PASSWORD 'demo_reader_password';
  END IF;
END;
$$;

GRANT CONNECT ON DATABASE demo_analytics TO demo_reader;
GRANT USAGE ON SCHEMA public TO demo_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO demo_reader;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO demo_reader;

INSERT INTO customers (id, name, email, country, created_at) VALUES
  (1, 'Ada Lovelace', 'ada@example.com', 'UK', '2026-01-12T10:00:00Z'),
  (2, 'Grace Hopper', 'grace@example.com', 'US', '2026-02-03T10:00:00Z'),
  (3, 'Alan Turing', 'alan@example.com', 'UK', '2026-02-21T10:00:00Z'),
  (4, 'Katherine Johnson', 'katherine@example.com', 'US', '2026-03-15T10:00:00Z'),
  (5, 'Linus Torvalds', 'linus@example.com', 'FI', '2026-04-02T10:00:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO products (id, name, category, price) VALUES
  (1, 'Analytics Starter', 'software', 49.00),
  (2, 'Analytics Pro', 'software', 199.00),
  (3, 'Data Connector', 'addon', 79.00),
  (4, 'Priority Support', 'service', 149.00),
  (5, 'Training Workshop', 'service', 499.00)
ON CONFLICT (id) DO NOTHING;

INSERT INTO orders (id, customer_id, status, ordered_at, total) VALUES
  (1, 1, 'paid', '2026-09-02T09:15:00Z', 49.00),
  (2, 2, 'paid', '2026-09-07T14:20:00Z', 278.00),
  (3, 3, 'pending', '2026-09-12T11:05:00Z', 199.00),
  (4, 4, 'paid', '2026-09-18T16:40:00Z', 648.00),
  (5, 5, 'refunded', '2026-09-24T08:30:00Z', 79.00),
  (6, 1, 'paid', '2026-10-01T10:10:00Z', 199.00),
  (7, 2, 'paid', '2026-10-08T13:45:00Z', 499.00),
  (8, 3, 'pending', '2026-10-15T15:25:00Z', 149.00)
ON CONFLICT (id) DO NOTHING;

INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
  (1, 1, 1, 49.00),
  (2, 2, 1, 199.00),
  (2, 3, 1, 79.00),
  (3, 2, 1, 199.00),
  (4, 5, 1, 499.00),
  (4, 4, 1, 149.00),
  (5, 3, 1, 79.00),
  (6, 2, 1, 199.00),
  (7, 5, 1, 499.00),
  (8, 4, 1, 149.00)
ON CONFLICT (order_id, product_id) DO NOTHING;

SELECT setval(pg_get_serial_sequence('customers', 'id'), (SELECT max(id) FROM customers));
SELECT setval(pg_get_serial_sequence('products', 'id'), (SELECT max(id) FROM products));
SELECT setval(pg_get_serial_sequence('orders', 'id'), (SELECT max(id) FROM orders));
