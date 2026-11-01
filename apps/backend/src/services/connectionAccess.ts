import { pool } from '../db';
import { decryptSecret } from './connectionCrypto';
import { getPool, type SslMode, type TargetConfig } from './connectionPool';
import { getSchemaSnapshot, type SchemaSnapshot } from './introspection';
import { getDatabaseSchema } from './databaseAdapters';

export type DatabaseEngine = 'postgres' | 'mysql' | 'mongodb';

export type OwnedConnection = {
  id: string;
  owner_id: string;
  engine: DatabaseEngine;
  name: string;
  host: string;
  port: number;
  database_name: string;
  connection_uri_encrypted: string | null;
  username: string;
  password_encrypted: string;
  ssl_mode: SslMode;
  created_at: string;
  updated_at: string;
};

export async function getOwnedConnection(
  userId: string,
  connectionId: string
): Promise<OwnedConnection | null> {
  const { rows } = await pool.query<OwnedConnection>(
    'SELECT * FROM database_connections WHERE id = $1 AND owner_id = $2',
    [connectionId, userId]
  );
  return rows[0] ?? null;
}

export function toTargetConfig(row: OwnedConnection): TargetConfig {
  return {
    engine: row.engine ?? 'postgres',
    host: row.host,
    port: row.port,
    database: row.database_name,
    user: row.username,
    password: decryptSecret(row.password_encrypted),
    sslMode: row.ssl_mode,
    connectionUri: row.connection_uri_encrypted
      ? decryptSecret(row.connection_uri_encrypted)
      : undefined
  };
}

export function getTargetPool(connection: OwnedConnection) {
  const config = toTargetConfig(connection);
  return getPool(connection, config);
}

export async function getConnectionSchema(
  connection: OwnedConnection,
  refresh = false
): Promise<SchemaSnapshot> {
  const config = toTargetConfig(connection);
  if (config.engine !== 'postgres') {
    return getDatabaseSchema(connection.id, config, refresh);
  }
  const targetPool = getPool(connection, config);
  return getSchemaSnapshot(targetPool, connection.id, config, refresh);
}
