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

  test('includes safe provider error details and redacts the configured key', async () => {
    const apiKey = 'provider-secret-key';
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({ error: { message: `Invalid model. echoed ${apiKey}` } }, 400)
    ) as any;
    await expect(
      chat([{ role: 'user', content: 'hi' }], {
        modelConfig: {
          baseUrl: 'https://provider.example/v1',
          apiKey,
          model: 'unknown-model'
        }
      })
    ).rejects.toThrow('Invalid model. echoed [redacted]');
  });

  test('explains provider 404 as a model ID or base URL configuration issue', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: 'model not found' }, 404)) as any;
    await expect(
      chat([{ role: 'user', content: 'hi' }], {
        modelConfig: {
          baseUrl: 'https://provider.example/v1',
          apiKey: 'provider-key',
          model: 'vendor/nonexistent-model'
        }
      })
    ).rejects.toThrow(
      'Model "vendor/nonexistent-model" was not found at the configured API endpoint (HTTP 404). Check the provider\'s exact model ID and OpenAI-compatible base URL. Provider says: model not found'
    );
  });

  test('retains a short readable body when a provider returns a non-JSON 404', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response('<html><body>Unknown model route</body></html>', { status: 404 })
    ) as any;
    await expect(
      chat([{ role: 'user', content: 'hi' }], {
        modelConfig: {
          baseUrl: 'https://provider.example/v1',
          apiKey: 'provider-key',
          model: 'vendor/model'
        }
      })
    ).rejects.toThrow('Provider says: Unknown model route');
  });

  test('retries once without temperature when the provider rejects that parameter', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: 'temperature is not supported for this model' } }, 400)
      )
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: [{ type: 'text', text: 'works' }] } }] })
      );
    global.fetch = fetchMock as any;

    await expect(
      chat([{ role: 'user', content: 'hi' }], {
        temperature: 0,
        modelConfig: {
          baseUrl: 'https://provider.example/v1/chat/completions',
          apiKey: 'provider-key',
          model: 'provider-model'
        }
      })
    ).resolves.toBe('works');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('https://provider.example/v1/chat/completions');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).temperature).toBe(0);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).temperature).toBeUndefined();
  });

  test('tries the next model on rate limits and uses the model that succeeds', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'rate limited' }, 429))
      .mockResolvedValueOnce(
        jsonResponse({ choices: [{ message: { content: 'backup answer' } }] })
      );
    global.fetch = fetchMock as any;
    const modelConfig = {
      baseUrl: 'https://primary.example/v1',
      apiKey: 'primary-key',
      model: 'primary-model',
      fallbacks: [
        {
          baseUrl: 'https://backup.example/v1',
          apiKey: 'backup-key',
          model: 'backup-model'
        }
      ]
    };

    await expect(chat([{ role: 'user', content: 'hi' }], { modelConfig })).resolves.toBe(
      'backup answer'
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('https://primary.example/v1/chat/completions');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('primary-model');
    expect(fetchMock.mock.calls[1][0]).toBe('https://backup.example/v1/chat/completions');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).model).toBe('backup-model');
    expect(modelConfig.model).toBe('backup-model');
    expect(modelConfig.apiKey).toBe('backup-key');
  });

  test('does not retry a non-retryable provider response', async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ error: 'bad request' }, 400));
    global.fetch = fetchMock as any;
    await expect(
      chat([{ role: 'user', content: 'hi' }], {
        modelConfig: {
          baseUrl: 'https://primary.example/v1',
          apiKey: 'primary-key',
          model: 'primary-model',
          fallbacks: [
            {
              baseUrl: 'https://backup.example/v1',
              apiKey: 'backup-key',
              model: 'backup-model'
            }
          ]
        }
      })
    ).rejects.toBeInstanceOf(LlmUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  test('surfaces provider errors returned inside a successful streaming response', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      streamResponse(['data: {"error":{"message":"This model is not available"}}\n\n'])
    ) as any;
    const iterate = async () => {
      for await (const _part of chatStream([{ role: 'user', content: 'hi' }])) {
        // consume
      }
    };

    await expect(iterate()).rejects.toThrow('This model is not available');
  });

  test('falls back before starting a stream', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'unavailable' }, 503))
      .mockResolvedValueOnce(streamResponse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n']));
    global.fetch = fetchMock as any;
    const modelConfig = {
      baseUrl: 'https://primary.example/v1',
      apiKey: 'primary-key',
      model: 'primary-model',
      fallbacks: [
        {
          baseUrl: 'https://backup.example/v1',
          apiKey: 'backup-key',
          model: 'backup-model'
        }
      ]
    };
    const parts: string[] = [];

    for await (const part of chatStream([{ role: 'user', content: 'hi' }], { modelConfig })) {
      parts.push(part);
    }

    expect(parts.join('')).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(modelConfig.model).toBe('backup-model');
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
