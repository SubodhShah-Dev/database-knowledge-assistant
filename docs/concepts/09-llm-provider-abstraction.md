# 09 — LLM provider abstraction

> One OpenAI-compatible client, two call sites, one error type. The rest of the app never knows whether the model is Groq, OpenRouter, Gemini's compatibility endpoint, or a local Ollama.

**Back to:** [Implementation Walkthrough — Step 2](../history/implementation-walkthrough.md#3-step-2--llm-provider-abstraction) · [Concept index](../history/implementation-walkthrough.md#concept-index)

> **Current implementation note:** provider configuration is no longer env-only. Admins manage models under **AI providers**; keys are stored encrypted in `models.api_key_encrypted`. Sessions can pin a model, and Auto mode builds an ordered fallback chain. See [Models API](../reference/api/models.md) and [Provider registry and failover](15-provider-registry-and-failover.md).

## What it is

- **`chat()`** sends a non-streaming completion and returns the full text. Used by the planner.
- **`chatStream()`** yields text deltas from an SSE response. Used by answer synthesis.
- **`readConfig()`** resolves `baseUrl`, `apiKey`, `model`, and `timeoutMs` per call from env plus an optional model override.
- **`LlmUnavailableError`** is the single failure type routes map to `503`.

**Prerequisites:** [02 — TypeScript config](02-typescript-config.md) (strict mode, Node types). [10 — NL-to-SQL agent](10-nl-to-sql-agent.md) (the two call sites in context).

## Why this project uses it

- “OpenAI-compatible” is the widest common denominator. A free-tier Groq key, a local Ollama model, and an OpenRouter model all speak `/chat/completions`.
- Isolating the provider keeps planning logic testable. Tests mock one module, not an SDK.
- A single error type prevents provider-specific `401`/`429`/timeout handling from leaking into routes and the UI.
- Streaming is a product requirement: answers should appear as they are generated, and the Stop button must abort the upstream request.

## When to use this pattern

- Any app that may switch LLM providers or run against a local model.
- Any app that needs deterministic tests without network calls.
- If you are committed to one provider and one model forever, a thin direct client is still fine; the abstraction costs little.

## How it works here

### Configuration

```bash
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_API_KEY=
LLM_MODEL=openai/gpt-oss-120b
LLM_TIMEOUT_MS=60000
```

```ts
export type LlmConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
};

function readConfig(override?: Partial<LlmConfig>): LlmConfig {
  const base = {
    baseUrl: (process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, ''),
    apiKey: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'openai/gpt-oss-120b',
    timeoutMs: Number(process.env.LLM_TIMEOUT_MS || 60000)
  };
  return {
    baseUrl: (override?.baseUrl ?? base.baseUrl).replace(/\/+$/, ''),
    apiKey: override?.apiKey ?? base.apiKey,
    model: override?.model ?? base.model,
    timeoutMs: override?.timeoutMs ?? base.timeoutMs
  };
}
```

Why read per call:

- Tests can change env between cases.
- The app can start without an LLM key and still serve auth, connections, and schema browsing.
- A model selected on a session can override the default without restarting the process.

**Do not** cache config at module load. A missing key at import time would crash the whole API even though most routes do not need the LLM.

### Model registry

The `models` table is a UI convenience list, not a credential store:

```sql
CREATE TABLE IF NOT EXISTS models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  label text NOT NULL,
  model_id text NOT NULL UNIQUE,
  base_url text,
  is_enabled boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS models_single_default
  ON models ((true)) WHERE is_default;
```

Rules:

- **API keys stay in env**, not in `models`. A plaintext key column in the app database is a second credential store with weaker protection than the connection passwords.
- `base_url` is optional; if null, use `LLM_BASE_URL`.
- Seed at least one default row whose `model_id` matches `LLM_MODEL`, so the model picker is non-empty. If the table is empty, fall back to env.
- `GET /api/models` returns only enabled rows, ordered by `sort_order`, with the default first.
- A session's `model_id` resolves to a row; if it is missing or disabled, fall back to the default model and record the fallback in the response.
- If you genuinely need per-model keys, add `api_key_env text` naming an env var, not the key itself.

### The contract

```ts
export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export class LlmUnavailableError extends Error {
  constructor(message = 'The language model is unavailable. Try again shortly.') {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

export async function chat(
  messages: ChatMessage[],
  options: { temperature?: number; modelConfig?: Partial<LlmConfig> } = {}
): Promise<string>;

export async function* chatStream(
  messages: ChatMessage[],
  options: { temperature?: number; signal?: AbortSignal; modelConfig?: Partial<LlmConfig> } = {}
): AsyncGenerator<string>;
```

The contract deliberately exposes only text. Structured planning is the caller's job: ask for JSON, parse it, validate it. Keeping the transport dumb makes it reusable for both the planner and the answer pass.

### Non-streaming call

```ts
function isLocalBaseUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(url);
}

export async function chat(
  messages: ChatMessage[],
  options: { temperature?: number; modelConfig?: Partial<LlmConfig> } = {}
): Promise<string> {
  const config = readConfig(options.modelConfig);
  if (!config.apiKey && !isLocalBaseUrl(config.baseUrl)) {
    throw new LlmUnavailableError('The language model is not configured.');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: options.temperature ?? 0.1,
        stream: false
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new LlmUnavailableError(await providerError(response));
    }

    const body = await response.json();
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || !text.trim()) {
      throw new LlmUnavailableError('The language model returned an empty response.');
    }
    return text;
  } catch (error) {
    if (error instanceof LlmUnavailableError) throw error;
    throw new LlmUnavailableError(
      isAbortError(error) ? 'The language model timed out.' : 'Could not reach the language model.'
    );
  } finally {
    clearTimeout(timer);
  }
}
```

Notes:

- `isLocalBaseUrl` allows Ollama without a key (`http://localhost:11434/v1`). Do not require a fake key for local models.
- A non-2xx body can contain useful details, but do not forward it verbatim to the browser. Log a redacted version server-side; return a generic message.
- The timer is cleared in `finally`. Without that, a successful call leaves a pending timer that can keep tests or the process alive.

### Streaming call

```ts
export async function* chatStream(
  messages: ChatMessage[],
  options: { temperature?: number; signal?: AbortSignal; modelConfig?: Partial<LlmConfig> } = {}
): AsyncGenerator<string> {
  const config = readConfig(options.modelConfig);
  if (!config.apiKey && !isLocalBaseUrl(config.baseUrl)) {
    throw new LlmUnavailableError('The language model is not configured.');
  }

  const controller = new AbortController();
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: options.temperature ?? 0.1,
        stream: true
      }),
      signal: controller.signal
    });

    if (!response.ok || !response.body) {
      throw new LlmUnavailableError(await providerError(response));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? '';

      for (const event of events) {
        for (const line of event.split(/\r?\n/)) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;

          let chunk: any;
          try {
            chunk = JSON.parse(data);
          } catch {
            continue;
          }

          const delta = chunk?.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta) yield delta;
        }
      }
    }
  } catch (error) {
    if (error instanceof LlmUnavailableError) throw error;
    if (isAbortError(error)) {
      // A user's Stop is not an LLM outage; let the route end the SSE stream quietly.
      if (options.signal?.aborted) throw error;
      throw new LlmUnavailableError('The language model timed out.');
    }
    throw new LlmUnavailableError('Could not reach the language model.');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
```

SSE details that matter:

- **Buffer across reads.** A network chunk can split an event. Parse complete `\n\n`-delimited events and keep the remainder.
- **Ignore `[DONE]`.** It is a terminator, not content.
- **Skip malformed events.** Some providers send keepalives or comments (`: ping`). Do not crash the stream.
- **External abort is linked to the fetch controller.** The Stop button aborts the browser request, which aborts the upstream call, which stops token spend. Rethrow an external `AbortError`; do not map it to `LlmUnavailableError`, or a user's Stop becomes a misleading 503.
- **Do not call `reader.cancel()` in `finally` after a normal end.** It is harmless in most runtimes but unnecessary; the stream is already done.

### Error mapping

```ts
function providerError(response: Response): string {
  if (response.status === 401 || response.status === 403) {
    return 'The language model credentials were rejected.';
  }
  if (response.status === 429) {
    return 'The language model is rate-limited. Try again shortly.';
  }
  if (response.status >= 500) {
    return 'The language model provider is having trouble. Try again shortly.';
  }
  return 'The language model request failed.';
}
```

| Condition | Route response |
|---|---|
| No key / unreachable / timeout / empty output | `503` with a retryable message |
| Provider `401`/`403` | `503`; log the provider detail, never expose the key |
| Provider `429` | `503`; optionally include `Retry-After` |
| Client aborted (Stop) | Do not persist a partial turn; end the SSE stream cleanly |
| Planner returns invalid JSON | One repair attempt, then `422` “could not plan this question” |

Do not map provider `401` to app `401`. The user's app session is valid; the server's LLM credentials are not. `503` is the honest status.

### Two call sites, two temperatures

| Call site | Purpose | Temperature | Streaming |
|---|---|---:|---|
| Planner | question + schema → JSON plan | `0` | no |
| Answer synthesis | question + evidence → prose | `0.1` | yes |

The planner is deterministic on purpose. The answer pass may vary wording, not facts. Do not let the answer model invent numbers that are not in the evidence; the prompt and the UI both show the actual SQL and rows.

### Testing without a provider

Mock the module, not `fetch`:

```ts
jest.mock('../src/services/llm', () => ({
  ...jest.requireActual('../src/services/llm'),
  chat: jest.fn(async () => JSON.stringify({ mode: 'data', sql: 'SELECT 1 AS n' })),
  chatStream: async function* () {
    yield 'There is ';
    yield '1 row.';
  }
}));
```

Unit-test the transport separately with a fake `fetch`:

- non-2xx → `LlmUnavailableError`
- timeout → `LlmUnavailableError`
- empty `choices` → `LlmUnavailableError`
- SSE split across chunks → correct concatenated text
- `[DONE]` and keepalives ignored
- external abort → generator stops

## Pitfalls we hit (and fixes)

1. **Reading config at module load.** Importing the module without `LLM_API_KEY` crashes routes that never call the LLM. Read per call.
2. **Storing provider keys in `models`.** It duplicates secrets in the app database. Use env; if per-model keys are required, store an env var name, not the key.
3. **Forgetting the timeout.** A hung provider holds an SSE connection and a request slot forever. Abort on a timer and link the client signal.
4. **Parsing SSE line-by-line without buffering.** Deltas get lost when an event spans chunks. Buffer until `\n\n`.
5. **Forwarding provider errors.** `401` bodies can include key fragments or account details. Log redacted, return generic.
6. **Requiring an API key for Ollama.** Local OpenAI-compatible servers often accept no key. Allow keyless local base URLs.
7. **Treating an empty completion as success.** An empty answer renders a blank bubble. Throw `LlmUnavailableError`.
8. **Not clearing the timer.** Pending timers keep Jest open and can abort a request after it already finished.
9. **Persisting a partial stream.** If the user hits Stop or the connection drops, do not save half an answer as if it were complete. Persist only after `done`.

## Verification checklist

```bash
# no key -> 503 with a clear message (not a crash)
LLM_API_KEY= npm run test -w apps/backend -- --runInBand -t "llm unavailable"

# mocked transport
npx jest llm --runInBand

# real provider smoke test (optional, costs tokens)
curl -s -X POST localhost:4000/api/questions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"question":"How many customers are there?","conversationId":1}'

# streaming: first token arrives before the full answer
curl -N -X POST localhost:4000/api/questions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"question":"List the first 3 orders","conversationId":1}'
```

## Backlinks

- Walkthrough: [Step 2 — LLM provider abstraction](../history/implementation-walkthrough.md#3-step-2--llm-provider-abstraction)
- Related: [08 — Read-only SQL execution](08-readonly-sql-execution.md) · [10 — NL-to-SQL agent](10-nl-to-sql-agent.md) · [12 — Testing strategy](12-testing-strategy.md) · [13 — Security checklist](13-security-checklist.md)
