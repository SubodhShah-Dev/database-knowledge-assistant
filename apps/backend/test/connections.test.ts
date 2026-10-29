import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
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

  test('blocks metadata and link-local hosts', async () => {
    const { token } = await signup('blocked-hosts');

    for (const host of [
      '169.254.169.254',
      '::ffff:169.254.169.254',
      'fd00:ec2::254',
      '0.0.0.0',
      'metadata.google.internal',
      '/var/run/postgresql'
    ]) {
      const response = await request(app)
        .post('/api/connections')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...demo, name: `Blocked ${host}`, host });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/not allowed|valid database host/i);
    }
  });

  test('enforces DB_ALLOWED_HOSTS', async () => {
    const previous = process.env.DB_ALLOWED_HOSTS;
    process.env.DB_ALLOWED_HOSTS = '127.0.0.1';
    try {
      const { token } = await signup('allowlist');

      const allowed = await request(app)
        .post('/api/connections')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...demo, name: 'Allowlisted Host' });
      expect(allowed.status).toBe(201);

      const blocked = await request(app)
        .post('/api/connections')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...demo, name: 'Blocked IPv6', host: '::1' });
      expect(blocked.status).toBe(400);
      expect(blocked.body.error).toMatch(/DB_ALLOWED_HOSTS/);
    } finally {
      if (previous === undefined) delete process.env.DB_ALLOWED_HOSTS;
      else process.env.DB_ALLOWED_HOSTS = previous;
    }
  });

  test('rejects blocked hosts saved before the guard existed', async () => {
    const { token, userId } = await signup('legacy-host');
    const inserted = await pool.query(
      `INSERT INTO database_connections
         (owner_id, name, host, port, database_name, username, password_encrypted, ssl_mode)
       VALUES ($1, 'Legacy Blocked', '169.254.169.254', 5432, 'postgres', 'reader', $2, 'disable')
       RETURNING id`,
      [userId, encryptSecret('secret')]
    );

    const tested = await request(app)
      .post(`/api/connections/${inserted.rows[0].id}/test`)
      .set('Authorization', `Bearer ${token}`);
    expect(tested.status).toBe(200);
    expect(tested.body.ok).toBe(false);
    expect(tested.body.error).toMatch(/not allowed/i);
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

  test('allows changing database type when the connection has no saved sessions', async () => {
    const previousAllowedDir = process.env.SQLITE_ALLOWED_DIR;
    const directory = await mkdtemp(path.join(tmpdir(), 'database-assistant-connection-'));
    const filename = path.join(directory, 'fixture.db');
    await writeFile(filename, '');
    process.env.SQLITE_ALLOWED_DIR = directory;

    try {
      const { token } = await signup('change-engine');
      const created = await request(app)
        .post('/api/connections')
        .set('Authorization', `Bearer ${token}`)
        .send(demo);

      const updated = await request(app)
        .patch(`/api/connections/${created.body.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({
          engine: 'sqlite',
          name: demo.name,
          database: 'fixture',
          sqlitePath: filename
        });

      expect(updated.status).toBe(200);
      expect(updated.body.engine).toBe('sqlite');
      expect(updated.body.sqlite_path).toBe(filename);
    } finally {
      if (previousAllowedDir === undefined) delete process.env.SQLITE_ALLOWED_DIR;
      else process.env.SQLITE_ALLOWED_DIR = previousAllowedDir;
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('prevents changing database type while saved sessions exist', async () => {
    const { token, userId } = await signup('change-engine-with-session');
    const created = await request(app)
      .post('/api/connections')
      .set('Authorization', `Bearer ${token}`)
      .send(demo);
    await pool.query(
      `INSERT INTO conversations(user_id, connection_id, title)
       VALUES ($1, $2, 'Session')`,
      [userId, created.body.id]
    );

    const updated = await request(app)
      .patch(`/api/connections/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        engine: 'sqlite',
        name: demo.name,
        database: 'fixture',
        sqlitePath: '/tmp/unused-fixture.db'
      });

    expect(updated.status).toBe(409);
    expect(updated.body.error).toMatch(/saved sessions/i);
  });
});
