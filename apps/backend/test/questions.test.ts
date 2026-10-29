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
    .set('Authorization', 'Bearer ' + token)
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
    .set('Authorization', 'Bearer ' + token)
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
      JSON.stringify({ mode: 'data', query: 'SELECT count(*)::int AS count FROM orders' })
    );
    stream(['There are ', '8 orders.']);

    const response = await request(app)
      .post('/api/questions')
      .set('Authorization', 'Bearer ' + token)
      .set('Accept', 'text/event-stream')
      .send({ question: 'How many orders are there?', conversationId: conversation.id, mode: 'data' });

    expect(response.status).toBe(200);
    expect(mockChat.mock.calls[0][0][0].content).toContain('selected answer mode is "data"');
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
      'SELECT question, answer, evidence, model, answer_mode FROM qa_history WHERE id = $1',
      [done.messageId]
    );
    expect(saved.rows[0].question).toBe('How many orders are there?');
    expect(saved.rows[0].evidence.kind).toBe('sql');
    expect(saved.rows[0].model).toBe('test-model');
    expect(saved.rows[0].answer_mode).toBe('data');
    expect(done.mode).toBe('data');

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
      .set('Authorization', 'Bearer ' + token)
      .set('Accept', 'text/event-stream')
      .send({
        question: 'How are orders and customers related?',
        conversationId: conversation.id,
        mode: 'schema'
      });

    expect(response.status).toBe(200);
    expect(mockChat.mock.calls[0][0][0].content).toContain('selected answer mode is "schema"');
    const events = parseSse(response.text);
    expect(events.some(event => event.event === 'status' && event.data.phase === 'running_query')).toBe(
      false
    );
    const evidence = events.find(event => event.event === 'evidence')?.data.evidence;
    expect(evidence.kind).toBe('schema');
    expect(events.find(event => event.event === 'done')?.data.mode).toBe('schema');
    expect(evidence.focus).toBe('orders');
    expect(
      evidence.relationships.some((relationship: any) =>
        relationship.name.includes('orders_customer_id_fkey')
      )
    ).toBe(true);
    expect(runSpy).not.toHaveBeenCalled();
    runSpy.mockRestore();
  });

  test('compares records and direct relationships without planner classification', async () => {
    const token = await signup();
    const conversation = await setupSession(token);
    stream(['Orders has the most records and 2 direct relationships.']);

    const response = await request(app)
      .post('/api/questions')
      .set('Authorization', 'Bearer ' + token)
      .set('Accept', 'text/event-stream')
      .send({
        question: 'Which table has most records and relationships?',
        conversationId: conversation.id,
        mode: 'auto'
      });

    {
        const token = await signup();
        const conversation = await setupSession(token);
        stream(['The highest record count is in orders.']);

        const response = await request(app)
          .post('/api/questions')
          .set('Authorization', 'Bearer ' + token)
          .set('Accept', 'text/event-stream')
          .send({
              question: 'Which table has most records and relationships?',
            conversationId: conversation.id,
            mode: 'data'
          });

        expect(response.status).toBe(200);
        expect(mockChat).not.toHaveBeenCalled();
        const events = parseSse(response.text);
        expect(events.find(event => event.event === 'evidence')?.data.evidence.sql).toContain(
          'UNION ALL'
        );
        expect(events.find(event => event.event === 'evidence')?.data.evidence.sql).toContain(
          'relationship_count'
        );
        expect(events.find(event => event.event === 'done')?.data.answer).toBe(
          'The highest record count is in orders.'
        );
    }

    expect(response.status).toBe(200);
    expect(mockChat).not.toHaveBeenCalled();
    const events = parseSse(response.text);
    const evidence = events.find(event => event.event === 'evidence')?.data.evidence;
    expect(evidence.kind).toBe('sql');
    expect(evidence.sql).toContain('UNION ALL');
    expect(evidence.sql).toContain('relationship_count');
    expect(evidence.columns.map((column: { name: string }) => column.name)).toEqual([
      'table_name',
      'record_count',
      'relationship_count'
    ]);
    expect(evidence.rows).toHaveLength(conversation.selectedTables.length);
    expect(evidence.tables).toHaveLength(conversation.selectedTables.length);
    expect(evidence.rows.every((row: unknown[]) => Number(row[2]) >= 0)).toBe(true);
    expect(
      evidence.rows.map((row: unknown[]) => Number(row[1]))
    ).toEqual(
      evidence.rows.map((row: unknown[]) => Number(row[1])).sort((a: number, b: number) => b - a)
    );
    expect(events.find(event => event.event === 'done')?.data.answer).toBe(
      'Orders has the most records and 2 direct relationships.'
    );
  });

  test('does not send deterministic count-query failures to planner repair', async () => {
    const token = await signup();
    const conversation = await setupSession(token);
    const runSpy = jest
      .spyOn(sqlExecution, 'runReadOnlyQuery')
      .mockRejectedValue(
        Object.assign(new Error('Could not count public.orders: permission denied'), {
          code: 'ER_TABLEACCESS_DENIED_ERROR'
        })
      );

    const response = await request(app)
      .post('/api/questions')
      .set('Authorization', 'Bearer ' + token)
      .set('Accept', 'text/event-stream')
      .send({
        question: 'Which table has most records and relationships?',
        conversationId: conversation.id,
        mode: 'auto'
      });

    expect(response.status).toBe(200);
    expect(mockChat).not.toHaveBeenCalled();
    const error = parseSse(response.text).find(event => event.event === 'error')?.data;
    expect(error.error).toContain('does not have permission to count records');
    expect(error.error).toContain('Table: public.orders');
    expect(error.sql).toContain('relationship_count');
    runSpy.mockRestore();
  });

  test('shows TiDB SQL parse details for deterministic count failures', async () => {
    const token = await signup();
    const conversation = await setupSession(token);
    const runSpy = jest
      .spyOn(sqlExecution, 'runReadOnlyQuery')
      .mockRejectedValue(
        Object.assign(new Error('syntax error'), {
          code: 'ER_PARSE_ERROR',
          sqlMessage: "You have an error in your SQL syntax near 'COUNT'"
        })
      );

    const response = await request(app)
      .post('/api/questions')
      .set('Authorization', 'Bearer ' + token)
      .set('Accept', 'text/event-stream')
      .send({
        question: 'Which table has most records and relationships?',
        conversationId: conversation.id,
        mode: 'auto'
      });

    const error = parseSse(response.text).find(event => event.event === 'error')?.data;
    expect(error.error).toContain('ER_PARSE_ERROR');
    expect(error.error).toContain("near 'COUNT'");
    expect(error.sql).toContain('relationship_count');
    runSpy.mockRestore();
  });

  test('explains that schema mode cannot compare live record counts', async () => {
    const token = await signup();
    const conversation = await setupSession(token);

    const response = await request(app)
      .post('/api/questions')
      .set('Authorization', 'Bearer ' + token)
      .set('Accept', 'text/event-stream')
      .send({
        question: 'Which table has most records?',
        conversationId: conversation.id,
        mode: 'schema'
      });

    expect(response.status).toBe(200);
    const events = parseSse(response.text);
    expect(events.find(event => event.event === 'done')?.data.answer).toContain(
      'Schema mode only has table metadata'
    );
    expect(events.find(event => event.event === 'done')?.data.mode).toBe('clarify');
    expect(events.some(event => event.event === 'evidence')).toBe(false);
    expect(mockChat).not.toHaveBeenCalled();
  });

  test('handles clarify without evidence and persists empty evidence', async () => {
    const token = await signup();
    const conversation = await setupSession(token);
    mockChat.mockResolvedValue(
      JSON.stringify({ mode: 'clarify', question: 'Which date range do you mean?' })
    );

    const response = await request(app)
      .post('/api/questions')
      .set('Authorization', 'Bearer ' + token)
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
      .mockResolvedValueOnce(JSON.stringify({ mode: 'data', query: 'SELECT * FROM missing_table' }))
      .mockResolvedValueOnce(
        JSON.stringify({ mode: 'data', query: 'SELECT count(*)::int AS count FROM orders' })
      );
    stream(['8']);

    const response = await request(app)
      .post('/api/questions')
      .set('Authorization', 'Bearer ' + token)
      .set('Accept', 'text/event-stream')
      .send({ question: 'How many orders?', conversationId: conversation.id });

    expect(response.status).toBe(200);
    expect(mockChat).toHaveBeenCalledTimes(2);
    const events = parseSse(response.text);
    expect(events.find(event => event.event === 'evidence')?.data.evidence.sql).toContain(
      'FROM orders'
    );
  });

  test('returns a rejected SQL plan with validation errors for inspection', async () => {
    const token = await signup();
    const conversation = await setupSession(token);
    mockChat
      .mockResolvedValueOnce(
        JSON.stringify({ mode: 'data', query: 'SELECT * FROM information_schema.tables' })
      )
      .mockResolvedValueOnce(
        JSON.stringify({ mode: 'data', query: 'SELECT * FROM information_schema.tables' })
      );

    const response = await request(app)
      .post('/api/questions')
      .set('Authorization', 'Bearer ' + token)
      .send({
        question: 'What is in the information schema?',
        conversationId: conversation.id,
        mode: 'data'
      });

    expect(response.status).toBe(422);
    expect(response.body.error).toContain("outside this session's scope");
    expect(response.body.sql).toBe('SELECT * FROM information_schema.tables');
  });

  test('returns 503 when the planner is unavailable', async () => {
    const token = await signup();
    const conversation = await setupSession(token);
    mockChat.mockRejectedValue(new LlmUnavailableError('The language model is unavailable.'));

    const response = await request(app)
      .post('/api/questions')
      .set('Authorization', 'Bearer ' + token)
      .send({ question: 'How many orders?', conversationId: conversation.id });

    expect(response.status).toBe(503);
    expect(response.body.error).toMatch(/unavailable/i);
  });

  test('rejects unsupported answer modes', async () => {
    const token = await signup();
    const conversation = await setupSession(token);

    const response = await request(app)
      .post('/api/questions')
      .set('Authorization', 'Bearer ' + token)
      .send({ question: 'How many orders?', conversationId: conversation.id, mode: 'clarify' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('mode must be auto, data, or schema.');
    expect(mockChat).not.toHaveBeenCalled();
  });
});
