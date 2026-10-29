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
    CHECK (engine IN ('postgres', 'mysql', 'sqlserver', 'sqlite', 'mongodb')),
  name text NOT NULL,
  host text NOT NULL,
  port integer NOT NULL DEFAULT 5432,
  database_name text NOT NULL,
  sqlite_path text,
  connection_uri_encrypted text,
  username text NOT NULL,
  password_encrypted text NOT NULL,
  ssl_mode text NOT NULL DEFAULT 'prefer'
    CHECK (ssl_mode IN ('disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);
ALTER TABLE database_connections
  ADD COLUMN IF NOT EXISTS engine text NOT NULL DEFAULT 'postgres',
  ADD COLUMN IF NOT EXISTS sqlite_path text,
  ADD COLUMN IF NOT EXISTS connection_uri_encrypted text;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'database_connections'::regclass
      AND conname = 'database_connections_engine_check'
  ) THEN
    ALTER TABLE database_connections
      ADD CONSTRAINT database_connections_engine_check
      CHECK (engine IN ('postgres', 'mysql', 'sqlserver', 'sqlite', 'mongodb'));
  END IF;
END
$$;
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
ALTER TABLE qa_history
  ADD COLUMN IF NOT EXISTS answer_mode text
    CHECK (answer_mode IN ('data', 'schema', 'clarify'));
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
ALTER TABLE models ADD COLUMN IF NOT EXISTS api_key_encrypted text;
CREATE UNIQUE INDEX IF NOT EXISTS models_single_default
  ON models ((true)) WHERE is_default;

CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
