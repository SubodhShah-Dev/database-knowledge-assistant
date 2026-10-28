export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export class LlmUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

export type LlmConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
};

function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

function readConfig(override?: Partial<LlmConfig>): LlmConfig {
  const base: LlmConfig = {
    baseUrl: (process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, ''),
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'openai/gpt-oss-120b',
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 60000)
  };
  const merged: LlmConfig = { ...base };
  if (override?.baseUrl) merged.baseUrl = override.baseUrl.replace(/\/+$/, '');
  if (override?.apiKey) merged.apiKey = override.apiKey;
  if (override?.model) merged.model = override.model;
  if (override?.timeoutMs) merged.timeoutMs = override.timeoutMs;
  return merged;
}

export function llmModel(): string {
  return readConfig().model;
}

export async function chat(
  messages: ChatMessage[],
  options: { temperature?: number; modelConfig?: Partial<LlmConfig> } = {}
): Promise<string> {
  const { baseUrl, apiKey, model, timeoutMs } = readConfig(options.modelConfig);
  if (!apiKey && !isLocalBaseUrl(baseUrl)) {
    throw new LlmUnavailableError('LLM_API_KEY is not configured.');
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model,
        messages,
        temperature: options.temperature ?? 0.1,
        stream: false
      })
    });
  } catch (error: any) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new LlmUnavailableError(`LLM request timed out after ${timeoutMs}ms.`);
    }
    throw new LlmUnavailableError('Could not reach the LLM provider.');
  }

  if (!response.ok) {
    throw new LlmUnavailableError(`LLM provider responded ${response.status}.`);
  }

  const data: any = await response.json().catch(() => null);
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new LlmUnavailableError('LLM provider returned an empty or malformed response.');
  }
  return content.trim();
}

export async function* chatStream(
  messages: ChatMessage[],
  options: { temperature?: number; signal?: AbortSignal; modelConfig?: Partial<LlmConfig> } = {}
): AsyncGenerator<string> {
  const { baseUrl, apiKey, model, timeoutMs } = readConfig(options.modelConfig);
  if (!apiKey && !isLocalBaseUrl(baseUrl)) {
    throw new LlmUnavailableError('LLM_API_KEY is not configured.');
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const signals = [AbortSignal.timeout(timeoutMs)];
  if (options.signal) signals.push(options.signal);
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        model,
        messages,
        temperature: options.temperature ?? 0.1,
        stream: true
      })
    });
  } catch (error: any) {
    if (options.signal?.aborted) throw error;
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new LlmUnavailableError(`LLM request timed out after ${timeoutMs}ms.`);
    }
    throw new LlmUnavailableError('Could not reach the LLM provider.');
  }

  if (!response.ok || !response.body) {
    throw new LlmUnavailableError(`LLM provider responded ${response.status}.`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let emitted = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            emitted = true;
            yield delta;
          }
        } catch {
          // Ignore malformed keep-alive frames.
        }
      }
    }
  } catch (error: any) {
    if (options.signal?.aborted) throw error;
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new LlmUnavailableError(`LLM stream timed out after ${timeoutMs}ms.`);
    }
    throw new LlmUnavailableError('LLM stream failed.');
  }

  if (!emitted) {
    throw new LlmUnavailableError('LLM provider returned an empty stream.');
  }
}
