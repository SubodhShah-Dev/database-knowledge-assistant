import request from 'supertest';
import { app } from '../src/app';
import { pool } from '../src/db';
import { chat, chatStream, LlmUnavailableError } from '../src/services/llm';
import * as sqlExecution from '../src/services/sqlExecution';
import { closeAllPools } from '../src/services/connectionPool';

jest.mock('../src/services/llm', () => {
  const actual = jest.requireActual('../src/services/llm');
  return { ...actual, chat: jest.fn(), chatStream: jest.fn() };
});

const mockChat = chat as jest.MockedFunction<typeof chat>;
const mockChatStream = chatStream as jest.MockedFunction<typeof chatStream>;

type SseEvent = { event: string; data: any };

function parseSse(text: string): SseEvent[] {
  return text
    .split(/\r?\n\r?\n/)
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => {
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      return { event, data: JSON.parse(dataLines.join('\n')) };
    });
}

async function signup() {
  const email = `questions-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
  const response = await request(app)
    .post('/api/auth/signup')
    .send({ email, password: 'Password123!' });
  return response.body.token as string;
}

async function setupSession(token: string) {
  const connection = await request(app)
    .post('/api/connections')
    .set('Authorization', `Bearer ${token}`)
    .send({
      name: `Questions ${Date.now()}`,
      host: '127.0.0.1',
      port: 5435,
      database: 'demo_analytics',
      username: 'demo_reader',
      password: 'demo_reader_password',
      sslMode: 'disable'
    });

  const conversation = await request(app)
    .post('/api/conversations')
    .set('Authorization', `Bearer ${token}`)
    .send({ connectionId: connection.body.id });

  return conversation.body;
}

function stream(tokens: string[]) {
  mockChatStream.mockImplementation(async function* () {
    for (const token of tokens) yield token;
  });
}

beforeEach(() => {
  mockChat.mockReset();
  mockChatStream.mockReset();
});

afterAll(async () => {
  await closeAllPools();
  await pool.end();
});

describe('questions SSE', () => {
  test('runs a data question, streams evidence, and persists the turn', async () => {
    const token = await signup();
    const conversation = await setupSession(token);
    mockChat.mockResolvedValue(
      JSON.stringify({ mode: 'data', sql: 'SELECT count(*)::int AS count FROM orders' })
    );
    stream(['There are ', '8 orders.']);

    const response = await request(app)
      .post('/api/questions')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'text/event-stream')
      .send({ question: 'How many orders are there?', conversationId: conversation.id });

    expect(response.status).toBe(200);
    const events = parseSse(response.text);
    expect(events.find(event => event.event === 'status')?.data.phase).toBe('planning');
    expect(events.some(event => event.event === 'status' && event.data.phase === 'running_query')).toBe(
      true
    );

    const evidence = events.find(event => event.event === 'evidence')?.data.evidence;
    expect(evidence.kind).toBe('sql');
    expect(evidence.rowCount).toBe(1);
    expect(evidence.rows[0][0]).toBe(8);
    expect(evidence.tables).toEqual([{ schema: 'public', table: 'orders' }]);

    const done = events.find(event => event.event === 'done')?.data;
    expect(done.answer).toBe('There are 8 orders.');
    expect(done.messageId).toBeDefined();

    const saved = await pool.query(
      'SELECT question, answer, evidence, model FROM qa_history WHERE id = $1',
      [done.messageId]
    );
    expect(saved.rows[0].question).toBe('How many orders are there?');
    expect(saved.rows[0].evidence.kind).toBe('sql');
    expect(saved.rows[0].model).toBe('test-model');

    const updated = await pool.query('SELECT title FROM conversations WHERE id = $1', [
      conversation.id
    ]);
    expect(updated.rows[0].title).toBe('How many orders are there?');
  });

  test('answers schema questions without executing SQL', async () => {
    const token = await signup();
    const conversation = await setupSession(token);
    mockChat.mockResolvedValue(JSON.stringify({ mode: 'schema', focus: 'orders' }));
    stream(['Orders ', 'reference customers.']);

    const runSpy = jest.spyOn(sqlExecution, 'runReadOnlyQuery');
    const response = await request(app)
      .post('/api/questions')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'text/event-stream')
      .send({ question: 'How are orders and customers related?', conversationId: conversation.id });

    expect(response.status).toBe(200);
    const events = parseSse(response.text);
    expect(events.some(event => event.event === 'status' && event.data.phase === 'running_query')).toBe(
      false
    );
    const evidence = events.find(event => event.event === 'evidence')?.data.evidence;
    expect(evidence.kind).toBe('schema');
    expect(evidence.focus).toBe('orders');
    expect(
      evidence.relationships.some((relationship: any) =>
        relationship.name.includes('orders_customer_id_fkey')
      )
    ).toBe(true);
    expect(runSpy).not.toHaveBeenCalled();
    runSpy.mockRestore();
  });

  test('handles clarify without evidence and persists empty evidence', async () => {
    const token = await signup();
    const conversation = await setupSession(token);
    mockChat.mockResolvedValue(
      JSON.stringify({ mode: 'clarify', question: 'Which date range do you mean?' })
    );

    const response = await request(app)
      .post('/api/questions')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'text/event-stream')
      .send({ question: 'Show recent orders', conversationId: conversation.id });

    const events = parseSse(response.text);
    expect(events.some(event => event.event === 'evidence')).toBe(false);
    const done = events.find(event => event.event === 'done')?.data;
    expect(done.answer).toBe('Which date range do you mean?');

    const saved = await pool.query('SELECT evidence FROM qa_history WHERE id = $1', [
      done.messageId
    ]);
    expect(saved.rows[0].evidence).toEqual([]);
  });

  test('repairs a rejected SQL plan once', async () => {
    const token = await signup();
    const conversation = await setupSession(token);
    mockChat
      .mockResolvedValueOnce(JSON.stringify({ mode: 'data', sql: 'SELECT * FROM missing_table' }))
      .mockResolvedValueOnce(
        JSON.stringify({ mode: 'data', sql: 'SELECT count(*)::int AS count FROM orders' })
      );
    stream(['8']);

    const response = await request(app)
      .post('/api/questions')
      .set('Authorization', `Bearer ${token}`)
      .set('Accept', 'text/event-stream')
      .send({ question: 'How many orders?', conversationId: conversation.id });

    expect(response.status).toBe(200);
    expect(mockChat).toHaveBeenCalledTimes(2);
    const events = parseSse(response.text);
    expect(events.find(event => event.event === 'evidence')?.data.evidence.sql).toContain(
      'FROM orders'
    );
  });

  test('returns 503 when the planner is unavailable', async () => {
    const token = await signup();
    const conversation = await setupSession(token);
    mockChat.mockRejectedValue(new LlmUnavailableError('The language model is unavailable.'));

    const response = await request(app)
      .post('/api/questions')
      .set('Authorization', `Bearer ${token}`)
      .send({ question: 'How many orders?', conversationId: conversation.id });

    expect(response.status).toBe(503);
    expect(response.body.error).toMatch(/unavailable/i);
  });
});
