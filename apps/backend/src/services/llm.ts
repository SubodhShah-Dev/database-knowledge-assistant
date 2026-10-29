export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export class LlmUnavailableError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

export type LlmConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  fallbacks?: Partial<LlmConfig>[];
};

function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return ['localhost', '127.0.0.1', '::1'].includes(url.hostname.replace(/^\[|\]$/g, ''));
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
  if (override?.apiKey !== undefined) merged.apiKey = override.apiKey;
  if (override?.model) merged.model = override.model;
  if (override?.timeoutMs) merged.timeoutMs = override.timeoutMs;
  return merged;
}

function candidateConfigs(override?: Partial<LlmConfig>): LlmConfig[] {
  const candidates = [readConfig(override), ...(override?.fallbacks ?? []).map(readConfig)];
  const seen = new Set<string>();
  return candidates.filter(candidate => {
    const key = `${candidate.baseUrl}\n${candidate.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function useConfig(override: Partial<LlmConfig> | undefined, selected: LlmConfig) {
  if (!override) return;
  override.baseUrl = selected.baseUrl;
  override.apiKey = selected.apiKey;
  override.model = selected.model;
}

function completionUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  return normalized.endsWith('/chat/completions')
    ? normalized
    : `${normalized}/chat/completions`;
}

function responseText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .map(part => {
      if (typeof part === 'string') return part;
      if (
        part &&
        typeof part === 'object' &&
        'text' in part &&
        typeof part.text === 'string'
      ) {
        return part.text;
      }
      return '';
    })
    .join('');
  return text || null;
}

function redactProviderMessage(message: string, apiKey: string): string {
  let safe = message
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (apiKey) safe = safe.split(apiKey).join('[redacted]');
  return safe.slice(0, 300);
}

async function providerErrorMessage(response: Response, config: LlmConfig): Promise<string> {
  const body = (await response.text().catch(() => '')).slice(0, 4096);
  let detail = '';
  try {
    const payload = JSON.parse(body);
    const error = payload?.error;
    detail =
      typeof error === 'string'
        ? error
        : error?.message ??
          error?.detail ??
          payload?.message ??
          payload?.detail ??
          payload?.error_description ??
          '';
    if (typeof detail !== 'string') detail = '';
  } catch {
    detail = body;
  }
  const safeDetail = redactProviderMessage(detail, config.apiKey);
  if (response.status === 404) {
    return `Model "${config.model}" was not found at the configured API endpoint (HTTP 404). Check the provider's exact model ID and OpenAI-compatible base URL.${safeDetail ? ` Provider says: ${safeDetail}` : ''}`;
  }
  return `LLM provider responded ${response.status} for model "${config.model}".${safeDetail ? ` ${safeDetail}` : ''}`;
}

function isUnsupportedTemperature(message: string): boolean {
  return /temperature.{0,80}(not supported|unsupported|unknown|unrecognized|not allowed)|(?:not supported|unsupported|unknown|unrecognized|not allowed).{0,80}temperature/i.test(
    message
  );
}

async function postChatCompletion(
  config: LlmConfig,
  messages: ChatMessage[],
  temperature: number,
  stream: boolean,
  signal?: AbortSignal,
  omitTemperature = false
): Promise<Response> {
  if (!config.apiKey && !isLocalBaseUrl(config.baseUrl)) {
    throw new LlmUnavailableError('No API key is configured for this model.', true);
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  let response: Response;
  try {
    const body: {
      model: string;
      messages: ChatMessage[];
      stream: boolean;
      temperature?: number;
    } = {
      model: config.model,
      messages,
      stream
    };
    if (!omitTemperature) body.temperature = temperature;
    response = await fetch(completionUrl(config.baseUrl), {
      method: 'POST',
      headers,
      signal: signal ?? AbortSignal.timeout(config.timeoutMs),
      body: JSON.stringify(body)
    });
  } catch (error: any) {
    if (error instanceof LlmUnavailableError) throw error;
    if (signal?.aborted) throw error;
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new LlmUnavailableError(`LLM request timed out after ${config.timeoutMs}ms.`, true);
    }
    throw new LlmUnavailableError('Could not reach the LLM provider.', true);
  }

  if (!response.ok) {
    const message = await providerErrorMessage(response, config);
    if (!omitTemperature && response.status === 400 && isUnsupportedTemperature(message)) {
      return postChatCompletion(config, messages, temperature, stream, signal, true);
    }
    const retryable =
      response.status === 402 ||
      response.status === 408 ||
      response.status === 425 ||
      response.status === 429 ||
      response.status >= 500;
    throw new LlmUnavailableError(message, retryable);
  }
  if (stream && !response.body) {
    throw new LlmUnavailableError('LLM provider returned a stream without a response body.');
  }
  return response;
}

export function llmModel(): string {
  return readConfig().model;
}

export async function chat(
  messages: ChatMessage[],
  options: { temperature?: number; modelConfig?: Partial<LlmConfig> } = {}
): Promise<string> {
  const candidates = candidateConfigs(options.modelConfig);
  for (let index = 0; index < candidates.length; index += 1) {
    const config = candidates[index];
    try {
      const response = await postChatCompletion(
        config,
        messages,
        options.temperature ?? 0.1,
        false
      );
      const data: any = await response.json().catch(() => null);
      const content = responseText(data?.choices?.[0]?.message?.content);
      if (!content?.trim()) {
        throw new LlmUnavailableError('LLM provider returned an empty or malformed response.');
      }
      useConfig(options.modelConfig, config);
      return content.trim();
    } catch (error) {
      if (
        !(error instanceof LlmUnavailableError) ||
        !error.retryable ||
        index === candidates.length - 1
      ) {
        throw error;
      }
    }
  }
  throw new LlmUnavailableError('No configured language model is available.');
}

export async function* chatStream(
  messages: ChatMessage[],
  options: { temperature?: number; signal?: AbortSignal; modelConfig?: Partial<LlmConfig> } = {}
): AsyncGenerator<string> {
  const candidates = candidateConfigs(options.modelConfig);
  let response: Response | undefined;
  let selected: LlmConfig | undefined;
  for (let index = 0; index < candidates.length; index += 1) {
    const config = candidates[index];
    const signals = [AbortSignal.timeout(config.timeoutMs)];
    if (options.signal) signals.push(options.signal);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    try {
      response = await postChatCompletion(
        config,
        messages,
        options.temperature ?? 0.1,
        true,
        signal
      );
      selected = config;
      break;
    } catch (error) {
      if (
        !(error instanceof LlmUnavailableError) ||
        !error.retryable ||
        index === candidates.length - 1 ||
        options.signal?.aborted
      ) {
        throw error;
      }
    }
  }
  if (!response?.body || !selected) {
    throw new LlmUnavailableError('No configured language model is available.');
  }
  useConfig(options.modelConfig, selected);

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
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        const parsed = parseStreamPayload(payload, selected.apiKey);
        const delta = responseText(parsed?.choices?.[0]?.delta?.content);
        if (delta) {
          emitted = true;
          yield delta;
        }
      }
    }
    buffer += decoder.decode();
    const finalPayload = buffer
      .split(/\r?\n/)
      .find(line => line.startsWith('data:'))
      ?.slice(5)
      .trim();
    if (finalPayload && finalPayload !== '[DONE]') {
      const parsed = parseStreamPayload(finalPayload, selected.apiKey);
      const delta = responseText(parsed?.choices?.[0]?.delta?.content);
      if (delta) {
        emitted = true;
        yield delta;
      }
    }
  } catch (error: any) {
    if (error instanceof LlmUnavailableError) throw error;
    if (options.signal?.aborted) throw error;
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new LlmUnavailableError(`LLM stream timed out after ${selected.timeoutMs}ms.`);
    }
    throw new LlmUnavailableError('LLM stream failed.');
  }

  if (!emitted) {
    throw new LlmUnavailableError('LLM provider returned an empty stream.');
  }
}

function parseStreamPayload(payload: string, apiKey: string): any {
  let parsed: any;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new LlmUnavailableError('LLM provider sent an invalid streaming response.');
  }
  if (parsed?.error) {
    const detail =
      typeof parsed.error === 'string'
        ? parsed.error
        : parsed.error?.message ?? parsed.error?.detail ?? '';
    const safeDetail = redactProviderMessage(String(detail), apiKey);
    throw new LlmUnavailableError(
      safeDetail
        ? `LLM provider stream error: ${safeDetail}`
        : 'LLM provider returned a streaming error.'
    );
  }
  return parsed;
}
