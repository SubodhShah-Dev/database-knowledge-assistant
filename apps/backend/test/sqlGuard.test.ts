import { SqlValidationError, validateSql } from '../src/services/sqlGuard';

const allowed = [
  { schema: 'public', table: 'orders' },
  { schema: 'public', table: 'customers' }
];

function expectRejected(sql: string, pattern?: RegExp) {
  try {
    validateSql(sql, allowed);
    throw new Error(`Expected rejection: ${sql}`);
  } catch (error) {
    expect(error).toBeInstanceOf(SqlValidationError);
    if (pattern) expect((error as Error).message).toMatch(pattern);
  }
}

describe('sql guard', () => {
  test('accepts SELECT, CTE, UNION, joins, and subqueries in scope', () => {
    expect(validateSql('SELECT * FROM orders;', allowed)).toBe('SELECT * FROM orders');
    expect(validateSql('SELECT * FROM public.orders', allowed)).toBe(
      'SELECT * FROM public.orders'
    );
    expect(
      validateSql(
        'WITH recent AS (SELECT * FROM orders) SELECT * FROM recent',
        allowed
      )
    ).toContain('WITH recent');
    expect(
      validateSql(
        'SELECT id FROM orders UNION SELECT id FROM customers',
        allowed
      )
    ).toContain('UNION');
    expect(
      validateSql(
        'SELECT o.id, c.name FROM orders o JOIN customers c ON o.customer_id = c.id',
        allowed
      )
    ).toContain('JOIN');
    expect(
      validateSql('SELECT * FROM orders WHERE id IN (SELECT id FROM customers)', allowed)
    ).toContain('IN');
  });

  test('rejects empty, unparseable, and multiple statements', () => {
    expectRejected('', /empty/i);
    expectRejected('SELEC * FROM orders', /could not be parsed/i);
    expectRejected('SELECT * FROM orders; DROP TABLE orders', /one SQL statement/i);
  });

  test('rejects DML, DDL, and CTE writes', () => {
    expectRejected('INSERT INTO orders(id) VALUES (1)', /Only SELECT/i);
    expectRejected('UPDATE orders SET status = 1', /Only SELECT/i);
    expectRejected('DELETE FROM orders', /Only SELECT/i);
    expectRejected(
      'WITH x AS (DELETE FROM orders RETURNING *) SELECT * FROM x',
      /CTE must be a SELECT/i
    );
  });

  test('rejects row locking and out-of-scope tables', () => {
    expectRejected('SELECT * FROM orders FOR UPDATE', /locking/i);
    expectRejected('SELECT * FROM products', /outside this session/i);
    expectRejected('SELECT * FROM pg_catalog.pg_class', /outside this session/i);
    expectRejected(
      'WITH x AS (SELECT * FROM products) SELECT * FROM x',
      /outside this session/i
    );
    expectRejected(
      'SELECT * FROM orders WHERE id IN (SELECT order_id FROM order_items)',
      /outside this session/i
    );
  });

  test('rejects DDL and other destructive statements', () => {
    expectRejected('DROP TABLE orders', /Only SELECT/i);
    expectRejected('DROP INDEX orders_idx', /Only SELECT/i);
    expectRejected('TRUNCATE TABLE orders', /Only SELECT/i);
    expectRejected('CREATE TABLE foo (id int)', /Only SELECT/i);
    expectRejected('ALTER TABLE orders ADD COLUMN x int', /Only SELECT/i);
    expectRejected('COPY orders TO STDOUT', /Only SELECT/i);
    expectRejected("SET statement_timeout = '0'", /Only SELECT/i);
  });
});
