import type { Pool } from 'pg';

export class TargetDbTimeoutError extends Error {
  constructor() {
    super('The query took too long and was cancelled.');
    this.name = 'TargetDbTimeoutError';
  }
}

export type QueryColumn = { name: string; dataType: number };
export type QueryResult = {
  columns: QueryColumn[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
  executionMs: number;
};

function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) {
    return { __type: 'buffer', base64: value.toString('base64') };
  }
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) result[key] = toJsonSafe(item);
    return result;
  }
  return value;
}

export async function runReadOnlyQuery(
  pool: Pool,
  sql: string,
  options: { maxRows: number; timeoutMs: number }
): Promise<QueryResult> {
  const maxRows = Math.max(1, Math.min(Number(options.maxRows) || 100, 1000));
  const timeoutMs = Math.max(1, Math.min(Number(options.timeoutMs) || 5000, 60_000));
  const client = await pool.connect();

  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query("SELECT set_config('statement_timeout', $1, true)", [String(timeoutMs)]);
    await client.query("SELECT set_config('idle_in_transaction_session_timeout', $1, true)", [
      String(timeoutMs)
    ]);

    const started = Date.now();
    const result = await client.query({
      text: `SELECT * FROM (${sql}) AS _session_query LIMIT ${maxRows + 1}`,
      rowMode: 'array'
    });
    const executionMs = Date.now() - started;

    await client.query('ROLLBACK');

    const truncated = result.rows.length > maxRows;
    return {
      columns: result.fields.map(field => ({ name: field.name, dataType: field.dataTypeID })),
      rows: result.rows.slice(0, maxRows).map(row => row.map(toJsonSafe)),
      rowCount: truncated ? maxRows : result.rows.length,
      truncated,
      executionMs
    };
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error?.code === '57014') throw new TargetDbTimeoutError();
    throw error;
  } finally {
    client.release();
  }
}
