import type { Pool } from 'pg';
import type { TargetConfig } from './connectionPool';

export type ColumnMeta = {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  comment: string | null;
};

export type TableMeta = {
  schema: string;
  name: string;
  type: 'table' | 'view';
  comment: string | null;
  rowEstimate: number | null;
  columns: ColumnMeta[];
};

export type Relationship = {
  name: string;
  from: { schema: string; table: string; columns: string[] };
  to: { schema: string; table: string; columns: string[] };
  onDelete: string;
  onUpdate: string;
};

export type SchemaSnapshot = {
  tables: TableMeta[];
  relationships: Relationship[];
  introspectedAt: string;
};

type CacheEntry = {
  snapshot: SchemaSnapshot;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();

const ACTION_NAMES: Record<string, string> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT'
};

function cacheTtlMs(): number {
  const value = Number(process.env.SQL_SCHEMA_CACHE_MS || 300_000);
  return Number.isFinite(value) && value >= 0 ? value : 300_000;
}

export function invalidateSchemaCache(connectionId: string) {
  cache.delete(connectionId);
}

export function clearSchemaCache() {
  cache.clear();
}

export async function getSchemaSnapshot(
  pool: Pool,
  connectionId: string,
  config: TargetConfig,
  refresh = false
): Promise<SchemaSnapshot> {
  const cached = cache.get(connectionId);
  if (!refresh && cached && cached.expiresAt > Date.now()) return cached.snapshot;

  const snapshot = await introspectSchema(pool, config);
  cache.set(connectionId, { snapshot, expiresAt: Date.now() + cacheTtlMs() });
  return snapshot;
}

async function introspectSchema(pool: Pool, config: TargetConfig): Promise<SchemaSnapshot> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('statement_timeout', $1, true)", [
      String(Number(process.env.SQL_INTROSPECTION_TIMEOUT_MS || 5000))
    ]);
    await client.query("SELECT set_config('search_path', 'public', true)");

    const tablesResult = await client.query<{
      schema: string;
      name: string;
      type: 'table' | 'view';
      comment: string | null;
      row_estimate: string | number;
    }>(`
      SELECT n.nspname AS schema,
             c.relname AS name,
             CASE WHEN c.relkind = 'v' THEN 'view' ELSE 'table' END AS type,
             obj_description(c.oid, 'pg_class') AS comment,
             c.reltuples::bigint AS row_estimate
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'v')
        AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname NOT LIKE 'pg_%'
        AND has_schema_privilege(current_user, n.oid, 'USAGE')
        AND has_table_privilege(current_user, c.oid, 'SELECT')
      ORDER BY n.nspname, c.relname
    `);

    const tables = tablesResult.rows.map<TableMeta>(row => {
      const estimate = Number(row.row_estimate);
      return {
        schema: row.schema,
        name: row.name,
        type: row.type,
        comment: row.comment,
        rowEstimate: Number.isFinite(estimate) && estimate >= 0 ? estimate : null,
        columns: []
      };
    });

    const tableMap = new Map(tables.map(table => [`${table.schema}.${table.name}`, table]));
    const schemas = [...new Set(tables.map(table => table.schema))];
    if (schemas.length === 0) {
      await client.query('ROLLBACK');
      return { tables: [], relationships: [], introspectedAt: new Date().toISOString() };
    }

    const constraintsResult = await client.query<{
      name: string;
      type: 'p' | 'f';
      from_schema: string;
      from_table: string;
      to_schema: string | null;
      to_table: string | null;
      from_columns: string[];
      to_columns: string[] | null;
      confdeltype: string;
      confupdtype: string;
    }>(
      `
      SELECT con.conname AS name,
             con.contype AS type,
             src_ns.nspname AS from_schema,
             src.relname AS from_table,
             dst_ns.nspname AS to_schema,
             dst.relname AS to_table,
             ARRAY(
               SELECT a.attname
               FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
               ORDER BY k.ord
             )::text[] AS from_columns,
             ARRAY(
               SELECT a.attname
               FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
               JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
               ORDER BY k.ord
             )::text[] AS to_columns,
             con.confdeltype,
             con.confupdtype
      FROM pg_constraint con
      JOIN pg_class src ON src.oid = con.conrelid
      JOIN pg_namespace src_ns ON src_ns.oid = src.relnamespace
      LEFT JOIN pg_class dst ON dst.oid = con.confrelid
      LEFT JOIN pg_namespace dst_ns ON dst_ns.oid = dst.relnamespace
      WHERE con.contype IN ('p', 'f')
        AND src_ns.nspname = ANY($1::text[])
      `,
      [schemas]
    );

    const primaryKeys = new Map<string, Set<string>>();
    const foreignKeys = new Map<string, Set<string>>();
    const relationships: Relationship[] = [];

    for (const row of constraintsResult.rows) {
      const sourceKey = `${row.from_schema}.${row.from_table}`;
      if (!tableMap.has(sourceKey)) continue;

      if (row.type === 'p') {
        primaryKeys.set(sourceKey, new Set(row.from_columns));
        continue;
      }

      const existing = foreignKeys.get(sourceKey) ?? new Set<string>();
      for (const column of row.from_columns) existing.add(column);
      foreignKeys.set(sourceKey, existing);

      const targetKey = row.to_schema && row.to_table ? `${row.to_schema}.${row.to_table}` : '';
      if (!targetKey || !tableMap.has(targetKey)) continue;

      relationships.push({
        name: row.name,
        from: { schema: row.from_schema, table: row.from_table, columns: row.from_columns },
        to: {
          schema: row.to_schema as string,
          table: row.to_table as string,
          columns: row.to_columns ?? []
        },
        onDelete: ACTION_NAMES[row.confdeltype] ?? 'NO ACTION',
        onUpdate: ACTION_NAMES[row.confupdtype] ?? 'NO ACTION'
      });
    }

    const columnsResult = await client.query<{
      table_schema: string;
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: boolean;
      column_default: string | null;
      comment: string | null;
    }>(
      `
      SELECT n.nspname AS table_schema,
             c.relname AS table_name,
             a.attname AS column_name,
             format_type(a.atttypid, a.atttypmod) AS data_type,
             NOT a.attnotnull AS is_nullable,
             pg_get_expr(d.adbin, d.adrelid) AS column_default,
             col_description(c.oid, a.attnum) AS comment
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE n.nspname = ANY($1::text[])
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND c.relkind IN ('r', 'p', 'v')
      ORDER BY n.nspname, c.relname, a.attnum
      `,
      [schemas]
    );

    for (const row of columnsResult.rows) {
      const key = `${row.table_schema}.${row.table_name}`;
      const table = tableMap.get(key);
      if (!table) continue;
      table.columns.push({
        name: row.column_name,
        dataType: row.data_type,
        nullable: row.is_nullable,
        defaultValue: row.column_default,
        isPrimaryKey: primaryKeys.get(key)?.has(row.column_name) ?? false,
        isForeignKey: foreignKeys.get(key)?.has(row.column_name) ?? false,
        comment: row.comment
      });
    }

    await client.query('ROLLBACK');
    return {
      tables,
      relationships: relationships.sort((a, b) => a.name.localeCompare(b.name)),
      introspectedAt: new Date().toISOString()
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
