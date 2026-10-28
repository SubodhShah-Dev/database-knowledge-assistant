import request from 'supertest';
import { app } from '../src/app';
import { pool } from '../src/db';
import { closeAllPools } from '../src/services/connectionPool';

const demoConnection = {
  name: 'Demo Analytics',
  host: '127.0.0.1',
  port: 5435,
  database: 'demo_analytics',
  username: 'demo_reader',
  password: 'demo_reader_password',
  sslMode: 'disable'
};

async function signup(prefix: string) {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
  const response = await request(app)
    .post('/api/auth/signup')
    .send({ email, password: 'Password123!' });
  return { token: response.body.token as string, userId: response.body.user.id as string };
}

async function createConnection(token: string, name = 'Demo Analytics') {
  const response = await request(app)
    .post('/api/connections')
    .set('Authorization', `Bearer ${token}`)
    .send({ ...demoConnection, name });
  return response.body;
}

afterAll(async () => {
  await closeAllPools();
  await pool.end();
});

describe('conversations', () => {
  let token = '';
  let userId = '';
  let connection: any;

  beforeAll(async () => {
    const user = await signup('sessions');
    token = user.token;
    userId = user.userId;
    connection = await createConnection(token);
  });

  test('requires a connection', async () => {
    const response = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(response.status).toBe(400);
  });

  test("rejects another user's connection", async () => {
    const other = await signup('sessions-other');
    const response = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${other.token}`)
      .send({ connectionId: connection.id });
    expect(response.status).toBe(404);
  });

  test('creates a session with all tables by default', async () => {
    const response = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${token}`)
      .send({ connectionId: connection.id });

    expect(response.status).toBe(201);
    expect(response.body.title).toBe('New session');
    expect(response.body.connection.name).toBe('Demo Analytics');
    expect(response.body.connection.password).toBeUndefined();
    expect(response.body.selectedTables.map((table: any) => table.table)).toEqual([
      'customers',
      'order_items',
      'orders',
      'products'
    ]);
  });

  test('rejects tables outside the schema', async () => {
    const response = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${token}`)
      .send({
        connectionId: connection.id,
        tables: [{ schema: 'public', table: 'missing_table' }]
      });
    expect(response.status).toBe(422);
  });

  test('supports explicit tables, model selection, detail, and turns', async () => {
    const model = await pool.query(
      `INSERT INTO models(label, model_id) VALUES ('Session Model', $1) RETURNING id`,
      [`session-model-${Date.now()}`]
    );

    const created = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${token}`)
      .send({
        connectionId: connection.id,
        tables: [
          { schema: 'public', table: 'orders' },
          { schema: 'public', table: 'customers' }
        ]
      });
    expect(created.status).toBe(201);

    const patched = await request(app)
      .patch(`/api/conversations/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Orders by customer', modelId: model.rows[0].id });
    expect(patched.status).toBe(200);
    expect(patched.body.title).toBe('Orders by customer');
    expect(patched.body.modelId).toBe(model.rows[0].id);

    await pool.query(
      `INSERT INTO qa_history(user_id, conversation_id, question, answer, evidence)
       VALUES ($1, $2, 'How many orders?', '8 orders.', $3::jsonb)`,
      [userId, created.body.id, JSON.stringify({ kind: 'sql', rowCount: 1 })]
    );

    const detail = await request(app)
      .get(`/api/conversations/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.selectedTables).toEqual([
      { schema: 'public', table: 'orders' },
      { schema: 'public', table: 'customers' }
    ]);
    expect(detail.body.connection).toEqual({
      id: connection.id,
      name: 'Demo Analytics',
      database: 'demo_analytics'
    });
    expect(detail.body.turns).toHaveLength(1);
    expect(detail.body.turns[0].evidence.kind).toBe('sql');
  });

  test('rejects changing the connection', async () => {
    const created = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${token}`)
      .send({ connectionId: connection.id });

    const response = await request(app)
      .patch(`/api/conversations/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ connectionId: connection.id });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/cannot be changed/i);
  });

  test('validates patched table scope against a fresh snapshot', async () => {
    const created = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${token}`)
      .send({ connectionId: connection.id });

    const patched = await request(app)
      .patch(`/api/conversations/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tables: [{ schema: 'public', table: 'products' }] });
    expect(patched.status).toBe(200);
    expect(patched.body.selectedTables).toEqual([{ schema: 'public', table: 'products' }]);

    const invalid = await request(app)
      .patch(`/api/conversations/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ tables: [{ schema: 'public', table: 'missing' }] });
    expect(invalid.status).toBe(422);
  });

  test('lists only the owner sessions and deletes them', async () => {
    const other = await signup('sessions-list-other');
    const own = await request(app)
      .post('/api/conversations')
      .set('Authorization', `Bearer ${token}`)
      .send({ connectionId: connection.id });

    const list = await request(app)
      .get('/api/conversations')
      .set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.every((session: any) => session.connection.id === connection.id)).toBe(true);

    const otherDelete = await request(app)
      .delete(`/api/conversations/${own.body.id}`)
      .set('Authorization', `Bearer ${other.token}`);
    expect(otherDelete.status).toBe(404);

    const deleted = await request(app)
      .delete(`/api/conversations/${own.body.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(deleted.status).toBe(200);
  });
});
