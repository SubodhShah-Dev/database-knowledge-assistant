import request from 'supertest';
import { app } from '../src/app';
import { pool } from '../src/db';
import { closeAllPools } from '../src/services/connectionPool';

let token = '';
let connectionId = '';

beforeAll(async () => {
  const email = `schema-${Date.now()}@example.com`;
  const signup = await request(app)
    .post('/api/auth/signup')
    .send({ email, password: 'Password123!' });
  token = signup.body.token;

  const created = await request(app)
    .post('/api/connections')
    .set('Authorization', `Bearer ${token}`)
    .send({
      name: 'Demo Analytics',
      host: '127.0.0.1',
      port: 5435,
      database: 'demo_analytics',
      username: 'demo_reader',
      password: 'demo_reader_password',
      sslMode: 'disable'
    });
  connectionId = created.body.id;
});

afterAll(async () => {
  await closeAllPools();
  await pool.end();
});

describe('schema introspection', () => {
  test('returns tables, columns, keys, and relationships', async () => {
    const response = await request(app)
      .get(`/api/connections/${connectionId}/schema`)
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.connection.database).toBe('demo_analytics');

    const tables = response.body.tables;
    expect(tables.map((table: any) => table.name)).toEqual([
      'customers',
      'order_items',
      'orders',
      'products'
    ]);

    const orders = tables.find((table: any) => table.name === 'orders');
    expect(orders.type).toBe('table');
    expect(orders.columns.find((column: any) => column.name === 'id').isPrimaryKey).toBe(true);
    expect(orders.columns.find((column: any) => column.name === 'customer_id').isForeignKey).toBe(
      true
    );

    const orderItems = tables.find((table: any) => table.name === 'order_items');
    expect(orderItems.columns.find((column: any) => column.name === 'order_id').isPrimaryKey).toBe(
      true
    );
    expect(
      orderItems.columns.find((column: any) => column.name === 'product_id').isPrimaryKey
    ).toBe(true);

    const relationships = response.body.relationships;
    expect(relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'orders_customer_id_fkey',
          from: { schema: 'public', table: 'orders', columns: ['customer_id'] },
          to: { schema: 'public', table: 'customers', columns: ['id'] }
        }),
        expect.objectContaining({
          name: 'order_items_order_id_fkey',
          onDelete: 'CASCADE'
        })
      ])
    );
  });

  test('caches and supports refresh', async () => {
    const first = await request(app)
      .get(`/api/connections/${connectionId}/schema`)
      .set('Authorization', `Bearer ${token}`);
    const second = await request(app)
      .get(`/api/connections/${connectionId}/schema`)
      .set('Authorization', `Bearer ${token}`);
    expect(second.body.introspectedAt).toBe(first.body.introspectedAt);

    await new Promise(resolve => setTimeout(resolve, 10));
    const refreshed = await request(app)
      .get(`/api/connections/${connectionId}/schema?refresh=1`)
      .set('Authorization', `Bearer ${token}`);
    expect(refreshed.body.introspectedAt).not.toBe(first.body.introspectedAt);
  });

  test('requires ownership', async () => {
    const email = `schema-other-${Date.now()}@example.com`;
    const signup = await request(app)
      .post('/api/auth/signup')
      .send({ email, password: 'Password123!' });
    const response = await request(app)
      .get(`/api/connections/${connectionId}/schema`)
      .set('Authorization', `Bearer ${signup.body.token}`);
    expect(response.status).toBe(404);
  });
});
