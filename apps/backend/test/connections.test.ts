import request from 'supertest';
import { app } from '../src/app';
import { pool } from '../src/db';
import { decryptSecret, encryptSecret } from '../src/services/connectionCrypto';

async function signup(prefix: string) {
  const email = `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
  const response = await request(app)
    .post('/api/auth/signup')
    .send({ email, password: 'Password123!' });
  return { token: response.body.token as string, userId: response.body.user.id as string };
}

const demo = {
  name: 'Demo Analytics',
  host: '127.0.0.1',
  port: 5435,
  database: 'demo_analytics',
  username: 'demo_reader',
  password: 'demo_reader_password',
  sslMode: 'disable'
};

afterAll(async () => {
  await pool.end();
});

describe('connection crypto', () => {
  test('round-trips and rejects tampering', () => {
    const encrypted = encryptSecret('secret-password');
    expect(encrypted).not.toContain('secret-password');
    expect(decryptSecret(encrypted)).toBe('secret-password');

    const parts = encrypted.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => decryptSecret(parts.join(':'))).toThrow();
  });

  test('rejects malformed payloads', () => {
    expect(() => decryptSecret('nope')).toThrow('Malformed encrypted secret');
  });
});

describe('connections', () => {
  test('creates, lists, tests, and hides the password', async () => {
    const { token } = await signup('connections');
    const created = await request(app)
      .post('/api/connections')
      .set('Authorization', `Bearer ${token}`)
      .send(demo);

    expect(created.status).toBe(201);
    expect(created.body.has_password).toBe(true);
    expect(created.body.password).toBeUndefined();
    expect(created.body.password_encrypted).toBeUndefined();

    const list = await request(app)
      .get('/api/connections')
      .set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);

    const tested = await request(app)
      .post(`/api/connections/${created.body.id}/test`)
      .set('Authorization', `Bearer ${token}`);
    expect(tested.status).toBe(200);
    expect(tested.body.ok).toBe(true);
    expect(tested.body.roleIsSuperuser).toBe(false);
    expect(tested.body.warning).toBeNull();
  });

  test('returns a safe failure for a bad password', async () => {
    const { token } = await signup('bad-password');
    const created = await request(app)
      .post('/api/connections')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...demo, name: 'Bad Password', password: 'wrong' });

    const tested = await request(app)
      .post(`/api/connections/${created.body.id}/test`)
      .set('Authorization', `Bearer ${token}`);
    expect(tested.status).toBe(200);
    expect(tested.body.ok).toBe(false);
    expect(tested.body.error).toMatch(/username or password/i);
  });

  test('isolates connections by owner', async () => {
    const owner = await signup('owner');
    const other = await signup('other');
    const created = await request(app)
      .post('/api/connections')
      .set('Authorization', `Bearer ${owner.token}`)
      .send(demo);

    const response = await request(app)
      .get(`/api/connections/${created.body.id}`)
      .set('Authorization', `Bearer ${other.token}`);
    expect(response.status).toBe(404);
  });

  test('requires force to delete a connection with sessions', async () => {
    const { token, userId } = await signup('force');
    const created = await request(app)
      .post('/api/connections')
      .set('Authorization', `Bearer ${token}`)
      .send(demo);

    const conversation = await pool.query(
      `INSERT INTO conversations(user_id, connection_id, title)
       VALUES ($1, $2, 'Session') RETURNING id`,
      [userId, created.body.id]
    );

    const blocked = await request(app)
      .delete(`/api/connections/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(blocked.status).toBe(409);

    const forced = await request(app)
      .delete(`/api/connections/${created.body.id}?force=true`)
      .set('Authorization', `Bearer ${token}`);
    expect(forced.status).toBe(200);

    const sessions = await pool.query('SELECT id FROM conversations WHERE id = $1', [
      conversation.rows[0].id
    ]);
    expect(sessions.rows).toHaveLength(0);
  });
});
