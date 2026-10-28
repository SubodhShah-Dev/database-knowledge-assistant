import { Pool } from 'pg';
import { runReadOnlyQuery, TargetDbTimeoutError } from '../src/services/sqlExecution';

let targetPool: Pool;

beforeAll(() => {
  targetPool = new Pool({
    host: '127.0.0.1',
    port: 5435,
    database: 'demo_analytics',
    user: 'demo_reader',
    password: 'demo_reader_password',
    ssl: false
  });
});

afterAll(async () => {
  await targetPool.end();
});

describe('read-only query execution', () => {
  test('returns columns and normalizes values', async () => {
    const result = await runReadOnlyQuery(targetPool, 'SELECT * FROM customers ORDER BY id', {
      maxRows: 2,
      timeoutMs: 2000
    });

    expect(result.rowCount).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.columns.map(column => column.name)).toEqual([
      'id',
      'name',
      'email',
      'country',
      'created_at'
    ]);
    expect(result.rows[0][0]).toBe('1');
    expect(result.rows[0][4]).toMatch(/^2026-01-12T10:00:00/);
  });

  test('does not truncate when rows fit', async () => {
    const result = await runReadOnlyQuery(targetPool, 'SELECT id FROM products ORDER BY id', {
      maxRows: 10,
      timeoutMs: 2000
    });
    expect(result.rowCount).toBe(5);
    expect(result.truncated).toBe(false);
  });

  test('times out long queries', async () => {
    await expect(
      runReadOnlyQuery(targetPool, 'SELECT pg_sleep(0.5)', { maxRows: 10, timeoutMs: 50 })
    ).rejects.toBeInstanceOf(TargetDbTimeoutError);
  });
});
