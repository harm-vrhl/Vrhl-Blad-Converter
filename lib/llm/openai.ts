import { env } from '../env';
import { sleep } from '../util';

export type JsonSchema = Record<string, unknown>;

export interface Ledger {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  failures: number;
}

export function newLedger(): Ledger {
  return { calls: 0, inputTokens: 0, outputTokens: 0, failures: 0 };
}

/**
 * What this ledger has run up, at the configured list price. Cached input reads
 * are billed at a twentieth of a fresh one and the ledger cannot tell them apart,
 * so this is the ceiling: the real bill is this or less.
 */
export function aiCost(ledger: Ledger): number {
  return (ledger.inputTokens * env.aiPriceInput + ledger.outputTokens * env.aiPriceOutput) / 1_000_000;
}


export interface AskOptions {
  agent: string;
  /** System prompt: the agent's single, narrow job. */
  instructions: string;
  /** User payload: OCR text, context, the question. */
  input: string;
  /** Page images. Visual truth. */
  images?: string[]; // data URLs
  schemaName: string;
  schema: JsonSchema;
  maxOutputTokens?: number;
  /** Overrides OPENAI_REASONING_EFFORT for this one run. */
  effort?: string;
  ledger?: Ledger;
  /**
   * Called with every fragment as it arrives. A structured answer is one object,
   * so nothing can be parsed until the last brace lands - but the caller can read
   * the finished half of it as it comes, which is what turns a long silence into
   * a field appearing.
   */
  onDelta?: (text: string) => void;
}

const TIMEOUT_MS = 240_000;
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

// The account may be on either surface; remember what worked so we only pay the
// fallback round-trip once per process.
let style: 'responses' | 'chat' | null = null;

export async function askJson<T>(opts: AskOptions): Promise<T> {
  if (!env.openaiKey) throw new Error('OPENAI_API_KEY ontbreekt (zie .env.local)');
  if (style === null) style = env.apiStyle;

  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const raw = await call(style, opts);
      if (opts.ledger) opts.ledger.calls++;
      return parseJson<T>(raw, opts.agent);
    } catch (err) {
      lastErr = err;
      const e = err as { status?: number; code?: string; message?: string };
      // A wrong model id looks like a 404 but switching surface cannot fix it,
      // and retrying only burns time. Name the setting that is wrong instead.
      if (e.code === 'model_not_found') {
        if (opts.ledger) opts.ledger.failures++;
        throw new Error(
          `[${opts.agent}] Model '${env.model}' bestaat niet of is niet beschikbaar op deze API-key. ` +
            `Zet OPENAI_MODEL in .env.local op een model dat je account wel heeft.`
        );
      }
      // A model that does not speak this surface will 404/400 immediately,
      // switch once and retry rather than failing the whole run.
      if ((e.status === 404 || e.status === 400) && style === 'responses' && attempt === 0) {
        style = 'chat';
        continue;
      }
      if (e.status && !RETRYABLE.has(e.status)) break;
      await sleep(1200 * 2 ** attempt);
    }
  }
  if (opts.ledger) opts.ledger.failures++;
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`[${opts.agent}] ${msg}`);
}

async function call(mode: 'responses' | 'chat', opts: AskOptions): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const url = `${env.openaiBase}/${mode === 'responses' ? 'responses' : 'chat/completions'}`;
    const body = mode === 'responses' ? responsesBody(opts) : chatBody(opts);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.openaiKey}`
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });

    if (!res.ok || (opts.onDelta && !res.body)) {
      const text = await res.text();
      const err = new Error(`${res.status} ${text.slice(0, 400)}`) as Error & { status: number; code: string };
      err.status = res.status;
      err.code = errorCode(text);
      throw err;
    }
    if (opts.onDelta && res.body) return await consume(res.body, mode, opts.ledger, opts.onDelta);

    const text = await res.text();
    const json = JSON.parse(text) as Record<string, unknown>;
    account(json, opts.ledger);
    return mode === 'responses' ? extractResponses(json) : extractChat(json);
  } finally {
    clearTimeout(timer);
  }
}

function responsesBody(opts: AskOptions) {
  const content: Record<string, unknown>[] = [{ type: 'input_text', text: opts.input }];
  for (const img of opts.images ?? []) content.push({ type: 'input_image', image_url: img, detail: 'high' });
  return {
    model: env.model,
    instructions: opts.instructions,
    input: [{ role: 'user', content }],
    reasoning: { effort: opts.effort ?? env.reasoningEffort },
    max_output_tokens: opts.maxOutputTokens ?? 16000,
    text: {
      format: { type: 'json_schema', name: opts.schemaName, strict: true, schema: opts.schema }
    },
    ...(opts.onDelta ? { stream: true } : {})
  };
}

function chatBody(opts: AskOptions) {
  const content: Record<string, unknown>[] = [{ type: 'text', text: opts.input }];
  for (const img of opts.images ?? []) {
    content.push({ type: 'image_url', image_url: { url: img, detail: 'high' } });
  }
  return {
    model: env.model,
    messages: [
      { role: 'system', content: opts.instructions },
      { role: 'user', content }
    ],
    reasoning_effort: opts.effort ?? env.reasoningEffort,
    max_completion_tokens: opts.maxOutputTokens ?? 16000,
    response_format: {
      type: 'json_schema',
      json_schema: { name: opts.schemaName, strict: true, schema: opts.schema }
    },
    ...(opts.onDelta ? { stream: true, stream_options: { include_usage: true } } : {})
  };
}

function errorCode(body: string): string {
  try {
    return (JSON.parse(body) as { error?: { code?: string } }).error?.code ?? '';
  } catch {
    return '';
  }
}

function account(json: Record<string, unknown>, ledger?: Ledger) {
  if (!ledger) return;
  const u = json.usage as Record<string, number> | undefined;
  if (!u) return;
  ledger.inputTokens += u.input_tokens ?? u.prompt_tokens ?? 0;
  ledger.outputTokens += u.output_tokens ?? u.completion_tokens ?? 0;
}

function extractResponses(json: Record<string, unknown>): string {
  if (typeof json.output_text === 'string' && json.output_text) return json.output_text;
  const output = (json.output ?? []) as Array<{ content?: Array<{ type?: string; text?: string }> }>;
  const parts: string[] = [];
  for (const item of output) {
    for (const c of item.content ?? []) {
      if (typeof c.text === 'string' && c.type !== 'reasoning') parts.push(c.text);
    }
  }
  if (!parts.length) throw new Error('lege response van het model');
  return parts.join('');
}

function extractChat(json: Record<string, unknown>): string {
  const choices = (json.choices ?? []) as Array<{ message?: { content?: string } }>;
  const text = choices[0]?.message?.content;
  if (!text) throw new Error('lege response van het model');
  return text;
}

function parseJson<T>(raw: string, agent: string): T {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        /* fall through */
      }
    }
    throw new Error(`[${agent}] antwoord was geen geldige JSON`);
  }
}

export interface AskTextOptions {
  agent: string;
  instructions: string;
  input: string;
  images?: string[];
  maxOutputTokens?: number;
  /** Overrides OPENAI_REASONING_EFFORT for this one run. */
  effort?: string;
  ledger?: Ledger;
  /** Called with every fragment the model produces, so the UI can show it live. */
  onDelta?: (text: string) => void;
}

/**
 * Plain-text run, streamed. Used for the one run per page that writes the page
 * out in reading order, the output the user watches appear.
 */
export async function askText(opts: AskTextOptions): Promise<string> {
  if (!env.openaiKey) throw new Error('OPENAI_API_KEY ontbreekt (zie .env.local)');
  if (style === null) style = env.apiStyle;

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const text = await stream(style, opts);
      if (opts.ledger) opts.ledger.calls++;
      return text;
    } catch (err) {
      lastErr = err;
      const e = err as { status?: number; code?: string; fatal?: boolean };
      if (e.fatal) break;
      if (e.code === 'model_not_found') {
        if (opts.ledger) opts.ledger.failures++;
        throw new Error(
          `[${opts.agent}] Model '${env.model}' bestaat niet of is niet beschikbaar op deze API-key. ` +
            `Zet OPENAI_MODEL in .env.local op een model dat je account wel heeft.`
        );
      }
      if ((e.status === 404 || e.status === 400) && style === 'responses' && attempt === 0) {
        style = 'chat';
        continue;
      }
      if (e.status && !RETRYABLE.has(e.status)) break;
      await sleep(1200 * 2 ** attempt);
    }
  }
  if (opts.ledger) opts.ledger.failures++;
  throw new Error(`[${opts.agent}] ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

async function stream(mode: 'responses' | 'chat', opts: AskTextOptions): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const url = `${env.openaiBase}/${mode === 'responses' ? 'responses' : 'chat/completions'}`;
    const body =
      mode === 'responses'
        ? {
            model: env.model,
            instructions: opts.instructions,
            input: [{ role: 'user', content: textContent(opts, 'responses') }],
            reasoning: { effort: opts.effort ?? env.reasoningEffort },
            max_output_tokens: opts.maxOutputTokens ?? 16000,
            stream: true
          }
        : {
            model: env.model,
            messages: [
              { role: 'system', content: opts.instructions },
              { role: 'user', content: textContent(opts, 'chat') }
            ],
            reasoning_effort: opts.effort ?? env.reasoningEffort,
            max_completion_tokens: opts.maxOutputTokens ?? 16000,
            stream: true,
            stream_options: { include_usage: true }
          };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.openaiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });

    if (!res.ok || !res.body) {
      const text = await res.text();
      const err = new Error(`${res.status} ${text.slice(0, 400)}`) as Error & { status: number; code: string };
      err.status = res.status;
      err.code = errorCode(text);
      throw err;
    }

    return await consume(res.body, mode, opts.ledger, opts.onDelta);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads one streamed answer, whichever surface it came from and whether it is
 * plain text or a structured object. Both arrive the same way: as deltas of one
 * string, which is why they can share this.
 */
async function consume(
  body: ReadableStream<Uint8Array>,
  mode: 'responses' | 'chat',
  ledger: Ledger | undefined,
  onDelta: ((text: string) => void) | undefined
): Promise<string> {
  let out = '';
  let cutOff = false;

  for await (const event of sseEvents(body)) {
    if (event === '[DONE]') break;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(event) as Record<string, unknown>;
    } catch {
      continue;
    }
    account(json, ledger);

    if (mode === 'responses') {
      if (json.type === 'response.output_text.delta') {
        const delta = json.delta as string;
        out += delta;
        onDelta?.(delta);
      } else if (json.type === 'response.completed') {
        account((json.response ?? {}) as Record<string, unknown>, ledger);
      } else if (json.type === 'response.incomplete' || json.type === 'response.failed') {
        cutOff = true;
      }
    } else {
      const choice = (json.choices as Array<{ delta?: { content?: string }; finish_reason?: string }> | undefined)?.[0];
      const delta = choice?.delta?.content ?? '';
      if (delta) {
        out += delta;
        onDelta?.(delta);
      }
      if (choice?.finish_reason === 'length') cutOff = true;
    }
  }

  // An empty answer is legitimate: a page can be one full-bleed photo with no
  // running story, and the prompt asks for nothing in that case. Only a model
  // that was cut off mid-sentence is a failure, and retrying will not fix it.
  if (cutOff) {
    const err = new Error('het model werd afgekapt; verhoog max_output_tokens') as Error & { fatal: boolean };
    err.fatal = true;
    throw err;
  }
  return out;
}

function textContent(opts: AskTextOptions, mode: 'responses' | 'chat'): Record<string, unknown>[] {
  const content: Record<string, unknown>[] =
    mode === 'responses' ? [{ type: 'input_text', text: opts.input }] : [{ type: 'text', text: opts.input }];
  for (const img of opts.images ?? []) {
    content.push(
      mode === 'responses'
        ? { type: 'input_image', image_url: img, detail: 'high' }
        : { type: 'image_url', image_url: { url: img, detail: 'high' } }
    );
  }
  return content;
}

/** Yields the payload of every `data:` line in an SSE body. */
async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split('\n\n');
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      for (const line of chunk.split('\n')) {
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
  }
}
