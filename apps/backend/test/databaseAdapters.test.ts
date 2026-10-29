import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import initSqlJs from 'sql.js';
import { SqlValidationError } from '../src/services/sqlGuard';
import {
  buildTableRecordCountQuery,
  isTiDBReadOnlyNoopError,
  parseMongoUri,
  referencedDatabaseTables,
  runDatabaseQuery,
  validateDatabaseQuery
} from '../src/services/databaseAdapters';

function expectRejected(query: string, engine: Parameters<typeof validateDatabaseQuery>[1], allowed: Array<{ schema: string; table: string }>) {
  expect(() => validateDatabaseQuery(query, engine, allowed)).toThrow(SqlValidationError);
}

describe('database query guards', () => {
  test('recognizes only TiDB READ ONLY no-op errors for transaction fallback', () => {
    expect(
      isTiDBReadOnlyNoopError({
        code: 'ER_NOT_SUPPORTED_YET',
        sqlMessage:
          'function READ ONLY has only noop implementation in tidb now, use tidb_enable_noop_functions to enable these functions'
      })
    ).toBe(true);
    expect(
      isTiDBReadOnlyNoopError({
        code: 'ER_NOT_SUPPORTED_YET',
        sqlMessage: 'Some other unsupported statement'
      })
    ).toBe(false);
    expect(
      isTiDBReadOnlyNoopError({
        code: 'ER_PARSE_ERROR',
        sqlMessage: 'READ ONLY function has only noop implementation'
      })
    ).toBe(false);
  });

  test.each(['postgres', 'mysql', 'sqlserver', 'sqlite'] as const)(
    'builds scoped table record counts for %s',
    engine => {
      const tables = [
        { schema: engine === 'sqlite' ? 'main' : 'analytics', table: 'order_items' },
        { schema: engine === 'sqlite' ? 'main' : 'analytics', table: 'orders' }
      ];
      const query = buildTableRecordCountQuery(tables, engine);

      expect(query).toContain('record_count');
      expect(query).toContain('UNION ALL');
      expect(validateDatabaseQuery(query, engine, tables)).toBe(query);
      expect(referencedDatabaseTables(query, engine, tables)).toEqual(tables);
    }
  );

  test('builds a scoped per-table count operation for MySQL relationship comparisons', () => {
    const tables = [
      { schema: 'Mero_Ghar_TiDB', table: 'owners' },
      { schema: 'Mero_Ghar_TiDB', table: 'houses' }
    ];
    const query = buildTableRecordCountQuery(
      tables,
      'mysql',
      new Map([
        ['Mero_Ghar_TiDB.owners', 1],
        ['Mero_Ghar_TiDB.houses', 2]
      ])
    );
    const parsed = JSON.parse(query);

    expect(validateDatabaseQuery(query, 'mysql', tables)).toBe(query);
    expect(parsed).toEqual({
      operation: 'tableRecordCounts',
      tables: [
        { ...tables[0], relationshipCount: 1 },
        { ...tables[1], relationshipCount: 2 }
      ]
    });
    expect(referencedDatabaseTables(query, 'mysql', tables)).toEqual(tables);
    expectRejected(
      JSON.stringify({
        operation: 'tableRecordCounts',
        tables: [{ schema: 'Mero_Ghar_TiDB', table: 'outside_scope', relationshipCount: 0 }]
      }),
      'mysql',
      tables
    );
  });

  test('builds a MongoDB count operation for all selected collections', () => {
    const tables = [
      { schema: 'analytics', table: 'orders' },
      { schema: 'analytics', table: 'customers' }
    ];
    const query = buildTableRecordCountQuery(
      tables,
      'mongodb',
      new Map([
        ['analytics.orders', 2],
        ['analytics.customers', 1]
      ])
    );
    const parsed = JSON.parse(query);

    expect(validateDatabaseQuery(query, 'mongodb', tables)).toBe(query);
    expect(parsed.operation).toBe('countDocuments');
    expect(parsed.collections).toEqual([
      { ...tables[0], relationshipCount: 2 },
      { ...tables[1], relationshipCount: 1 }
    ]);
    expect(referencedDatabaseTables(query, 'mongodb', tables)).toEqual(tables);
  });

  test('rejects MongoDB count operations outside the selected scope', () => {
    const query = JSON.stringify({
      operation: 'countDocuments',
      collections: [
        { schema: 'analytics', table: 'orders' },
        { schema: 'analytics', table: 'private_records' }
      ]
    });
    expectRejected(query, 'mongodb', [{ schema: 'analytics', table: 'orders' }]);
  });

  test('parses standard MongoDB seed-list and SRV connection URIs', () => {
    expect(parseMongoUri('mongodb://reader:secret@db1.example:27017,db2.example:27018/analytics?authSource=admin'))
      .toMatchObject({
        hosts: [
          { hostname: 'db1.example', port: 27017 },
          { hostname: 'db2.example', port: 27018 }
        ],
        database: 'analytics',
        username: 'reader',
        srv: false
      });
    expect(parseMongoUri('mongodb+srv://reader:secret@cluster.example/analytics'))
      .toMatchObject({ database: 'analytics', username: 'reader', srv: true });
  });

  test.each([
    ['mysql', 'SELECT * FROM orders', [{ schema: 'analytics', table: 'orders' }]],
    ['sqlserver', 'SELECT * FROM dbo.orders', [{ schema: 'dbo', table: 'orders' }]],
    ['sqlite', 'SELECT * FROM main.orders', [{ schema: 'main', table: 'orders' }]]
  ] as const)('accepts a scoped %s query', (engine, query, allowed) => {
    expect(validateDatabaseQuery(query, engine, [...allowed])).toBe(query);
  });

  test('allows scoped CTEs but rejects multiple statements and out-of-scope tables', () => {
    const allowed = [{ schema: 'analytics', table: 'orders' }];
    expect(
      validateDatabaseQuery(
        'WITH recent AS (SELECT * FROM orders) SELECT * FROM recent',
        'mysql',
        allowed
      )
    ).toContain('WITH recent');
    expectRejected('SELECT * FROM orders; SELECT 1', 'mysql', allowed);
    expectRejected('SELECT * FROM customers', 'mysql', allowed);
    expectRejected('WITH x AS (SELECT * FROM customers) SELECT * FROM x', 'mysql', allowed);
  });

  test('blocks SQL writes, file access, and cross-database SQL Server references', () => {
    expectRejected('DELETE FROM orders', 'sqlite', [{ schema: 'main', table: 'orders' }]);
    expectRejected('SELECT * INTO archive FROM orders', 'mysql', [{ schema: 'analytics', table: 'orders' }]);
    expectRejected('SELECT * FROM otherdb.dbo.orders', 'sqlserver', [{ schema: 'dbo', table: 'orders' }]);
    expectRejected("SELECT load_file('/etc/passwd')", 'mysql', [{ schema: 'analytics', table: 'orders' }]);
    expectRejected('SELECT * FROM orders', 'sqlserver', [{ schema: 'dbo', table: 'orders' }]);
  });

  test('allows safe MongoDB aggregation and blocks collection escapes and write stages', () => {
    const allowed = [{ schema: 'analytics', table: 'orders' }];
    const query = JSON.stringify({
      collection: 'orders',
      pipeline: [{ $match: { status: 'paid' } }, { $limit: 5 }]
    });
    expect(validateDatabaseQuery(query, 'mongodb', allowed)).toBe(query);
    expectRejected(
      JSON.stringify({ collection: 'customers', pipeline: [{ $match: {} }] }),
      'mongodb',
      allowed
    );
    expectRejected(
      JSON.stringify({ collection: 'orders', pipeline: [{ $out: 'archive' }] }),
      'mongodb',
      allowed
    );
    expectRejected(
      JSON.stringify({ collection: 'orders', pipeline: [{ $match: { $where: 'return true' } }] }),
      'mongodb',
      allowed
    );
  });

  test('reports only tables or collections referenced by the generated query', () => {
    const allowed = [
      { schema: 'analytics', table: 'orders' },
      { schema: 'analytics', table: 'line_items' },
      { schema: 'analytics', table: 'customers' }
    ];
    expect(referencedDatabaseTables(
      'SELECT * FROM orders JOIN line_items ON orders.id = line_items.order_id',
      'mysql',
      allowed
    )).toEqual(allowed.slice(0, 2));
    expect(referencedDatabaseTables(
      JSON.stringify({ collection: 'orders', pipeline: [{ $limit: 5 }] }),
      'mongodb',
      allowed
    )).toEqual([allowed[0]]);
  });

  test('runs SQLite queries against a read-only in-memory copy in a worker', async () => {
    const previousAllowedDir = process.env.SQLITE_ALLOWED_DIR;
    const directory = await mkdtemp(path.join(tmpdir(), 'database-assistant-sqlite-'));
    const filename = path.join(directory, 'fixture.db');
    const SQL = await initSqlJs({
      locateFile: file => require.resolve(`sql.js/dist/${file}`)
    });
    const database = new SQL.Database();
    database.run('CREATE TABLE orders (id INTEGER PRIMARY KEY, status TEXT)');
    database.run("INSERT INTO orders (status) VALUES ('paid'), ('pending'), ('cancelled')");
    database.run('CREATE TABLE customers (id INTEGER PRIMARY KEY)');
    database.run('INSERT INTO customers DEFAULT VALUES');
    database.run('INSERT INTO customers DEFAULT VALUES');
    database.run('CREATE TABLE products (id INTEGER PRIMARY KEY)');
    database.run('INSERT INTO products DEFAULT VALUES');
    await writeFile(filename, database.export());
    database.close();
    process.env.SQLITE_ALLOWED_DIR = directory;

    try {
      const result = await runDatabaseQuery(
        { id: 'sqlite-test', updated_at: new Date() },
        {
          engine: 'sqlite',
          host: 'local',
          port: 1,
          database: 'fixture',
          user: 'local',
          password: '',
          sslMode: 'disable',
          sqlitePath: filename
        },
        buildTableRecordCountQuery([
          { schema: 'main', table: 'orders' },
          { schema: 'main', table: 'customers' },
          { schema: 'main', table: 'products' }
        ], 'sqlite'),
        [
          { schema: 'main', table: 'orders' },
          { schema: 'main', table: 'customers' },
          { schema: 'main', table: 'products' }
        ],
        { maxRows: 2, timeoutMs: 10_000 }
      );

      expect(result.columns.map(column => column.name)).toEqual(['table_name', 'record_count']);
      expect(result.rows).toEqual([
        ['main.orders', 3],
        ['main.customers', 2]
      ]);
      expect(result.rowCount).toBe(2);
      expect(result.truncated).toBe(true);
    } finally {
      if (previousAllowedDir === undefined) delete process.env.SQLITE_ALLOWED_DIR;
      else process.env.SQLITE_ALLOWED_DIR = previousAllowedDir;
      await rm(directory, { recursive: true, force: true });
    }
  });
});
