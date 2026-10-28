import { pool } from '../db';
import { decryptSecret } from './connectionCrypto';
import { getPool, type SslMode, type TargetConfig } from './connectionPool';
import { getSchemaSnapshot, type SchemaSnapshot } from './introspection';

export type OwnedConnection = {
  id: string;
  owner_id: string;
  name: string;
  host: string;
  port: number;
  database_name: string;
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
    host: row.host,
    port: row.port,
    database: row.database_name,
    user: row.username,
    password: decryptSecret(row.password_encrypted),
    sslMode: row.ssl_mode
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
  const targetPool = getPool(connection, config);
  return getSchemaSnapshot(targetPool, connection.id, config, refresh);
}
