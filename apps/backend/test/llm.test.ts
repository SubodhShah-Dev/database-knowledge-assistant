import { chat, chatStream, LlmUnavailableError } from '../src/services/llm';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

describe('llm client', () => {
  test('returns chat content', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: ' hello ' } }] })
    ) as any;

    await expect(chat([{ role: 'user', content: 'hi' }])).resolves.toBe('hello');
  });

  test('maps non-2xx responses to LlmUnavailableError', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, 429)) as any;
    await expect(chat([{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(
      LlmUnavailableError
    );
  });

  test('rejects empty content', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ choices: [] })) as any;
    await expect(chat([{ role: 'user', content: 'hi' }])).rejects.toBeInstanceOf(
      LlmUnavailableError
    );
  });

  test('streams deltas', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      streamResponse([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: [DONE]\n\n'
      ])
    ) as any;

    const parts: string[] = [];
    for await (const part of chatStream([{ role: 'user', content: 'hi' }])) parts.push(part);
    expect(parts.join('')).toBe('Hello');
  });

  test('rejects an empty stream', async () => {
    global.fetch = jest.fn().mockResolvedValue(streamResponse(['data: [DONE]\n\n'])) as any;
    const iterate = async () => {
      for await (const _part of chatStream([{ role: 'user', content: 'hi' }])) {
        // consume
      }
    };
    await expect(iterate()).rejects.toBeInstanceOf(LlmUnavailableError);
  });
});
