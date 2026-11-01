import { SqlValidationError } from '../src/services/sqlGuard';
import {
  buildTableRecordCountQuery,
  isTiDBReadOnlyNoopError,
  parseMongoUri,
  referencedDatabaseTables,
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

  test.each(['postgres', 'mysql'] as const)('builds scoped table record counts for %s', engine => {
    const tables = [
      { schema: 'analytics', table: 'order_items' },
      { schema: 'analytics', table: 'orders' }
    ];
    const query = buildTableRecordCountQuery(tables, engine);

    expect(query).toContain('record_count');
    expect(query).toContain('UNION ALL');
    expect(validateDatabaseQuery(query, engine, tables)).toBe(query);
    expect(referencedDatabaseTables(query, engine, tables)).toEqual(tables);
  });

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
      collections: [{ schema: 'analytics', table: 'orders' }, { schema: 'analytics', table: 'customers' }]
    });
    expect(() => validateDatabaseQuery(query, 'mongodb', [{ schema: 'analytics', table: 'orders' }])).toThrow(
      SqlValidationError
    );
  });

  test('rejects SELECT statements outside the allowed tables', () => {
    expectRejected('SELECT * FROM orders', 'postgres', [{ schema: 'public', table: 'customers' }]);
    expectRejected('SELECT * FROM orders', 'mysql', [{ schema: 'app', table: 'customers' }]);
  });

  test('rejects write statements and multiple statements', () => {
    const allowed = [{ schema: 'public', table: 'orders' }];
    expectRejected('DELETE FROM orders', 'postgres', allowed);
    expectRejected('UPDATE orders SET id = 1', 'postgres', allowed);
    expectRejected('SELECT * FROM orders; SELECT * FROM users', 'postgres', allowed);
  });

  test('parses MongoDB SRV URIs for host allowlisting', () => {
    const parsed = parseMongoUri('mongodb+srv://user:pass@cluster0.example.com/mydb');
    expect(parsed.srv).toBe(true);
    expect(parsed.hosts).toEqual([{ hostname: 'cluster0.example.com' }]);
    expect(parsed.database).toBe('mydb');
    expect(parsed.username).toBe('user');
  });

  test('accepts a valid MongoDB aggregation pipeline within scope', () => {
    const allowed = [{ schema: 'app', table: 'orders' }];
    const query = JSON.stringify({ collection: 'orders', pipeline: [{ $match: { status: 'open' } }, { $limit: 10 }] });
    expect(validateDatabaseQuery(query, 'mongodb', allowed)).toBe(query);
    expect(referencedDatabaseTables(query, 'mongodb', allowed)).toEqual([{ schema: 'app', table: 'orders' }]);
  });

  test('rejects MongoDB stages and operators that are not read-only', () => {
    const allowed = [{ schema: 'app', table: 'orders' }];
    expect(() =>
      validateDatabaseQuery(JSON.stringify({ collection: 'orders', pipeline: [{ $out: 'archive' }] }), 'mongodb', allowed)
    ).toThrow(SqlValidationError);
    expect(() =>
      validateDatabaseQuery(JSON.stringify({ collection: 'orders', pipeline: [{ $where: 'this.total > 0' }] }), 'mongodb', allowed)
    ).toThrow(SqlValidationError);
  });
});
