import initSqlJs from 'sql.js';
import { parentPort, workerData } from 'node:worker_threads';

type WorkerInput = {
  bytes: Uint8Array;
  query: string;
  maxResultBytes: number;
};

function jsonSafe(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { __type: 'buffer', base64: Buffer.from(value).toString('base64') };
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

async function run() {
  const { bytes, query, maxResultBytes } = workerData as WorkerInput;
  const SQL = await initSqlJs({
    locateFile: filename => require.resolve(`sql.js/dist/${filename}`)
  });
  const db = new SQL.Database(bytes);
  try {
    db.run('PRAGMA query_only = ON');
    db.run('BEGIN');
    const statement = db.prepare(query);
    try {
      const columns = statement.getColumnNames().map(name => ({ name, dataType: 'SQLite' }));
      const rows: unknown[][] = [];
      let bytesUsed = 0;
      let truncated = false;
      while (statement.step()) {
        const row = statement.get().map(jsonSafe);
        const rowSize = Buffer.byteLength(JSON.stringify(row));
        if (bytesUsed + rowSize > maxResultBytes) {
          truncated = true;
          break;
        }
        rows.push(row);
        bytesUsed += rowSize;
      }
      parentPort?.postMessage({ columns, rows, truncated });
    } finally {
      statement.free();
    }
    db.run('ROLLBACK');
  } finally {
    db.close();
  }
}

void run().catch(error => {
  parentPort?.postMessage({ error: error instanceof Error ? error.message : 'SQLite query failed.' });
});
