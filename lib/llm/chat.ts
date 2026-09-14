import { env, modelFor, type Provider } from '../env';
import { sleep } from '../util';
import { closed, limitOf, observe, slot } from './ratelimit';

/**
 * One way to ask a model something, whichever provider answers. OpenAI and
 * Mistral take different bodies and stream in different shapes, but what the
 * agents need is the same: a structured answer held to a schema, or plain text
 * as it is written. Everything provider-specific stays in this file.
 */

export type JsonSchema = Record<string, unknown>;

export interface Ledger {
  /** Who is answering this run. The price per token depends on it. */
  provider: Provider;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  failures: number;
}

export function newLedger(provider: Provider = env.provider): Ledger {
  return { provider, calls: 0, inputTokens: 0, outputTokens: 0, failures: 0 };
}

/**
 * What this ledger has run up, at the provider's list price. Cached input reads
 * are billed at a fraction of a fresh one and the ledger cannot tell them apart,
 * so this is the ceiling: the real bill is this or less.
 */
export function aiCost(ledger: Ledger): number {
  const { input, output } = modelFor(ledger.provider);
  return (ledger.inputTokens * input + ledger.outputTokens * output) / 1_000_000;
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
  /** Overrides the reasoning effort for this one run. */
  effort?: string;
  /** Also says who answers: the run's provider travels with its accounts. */
  ledger?: Ledger;
  /**
   * Called with every fragment as it arrives. A structured answer is one object,
   * so nothing can be parsed until the last brace lands - but the caller can read
   * the finished half of it as it comes, which is what turns a long silence into
   * a field appearing.
   */
  onDelta?: (text: string) => void;
}

export interface AskTextOptions {
  agent: string;
  instructions: string;
  input: string;
  images?: string[];
  maxOutputTokens?: number;
  /** Overrides the reasoning effort for this one run. */
  effort?: string;
  ledger?: Ledger;
  /** Called with every fragment the model produces, so the UI can show it live. */
  onDelta?: (text: string) => void;
}

const TIMEOUT_MS = 240_000;
const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);

/** Mistral's own names for how hard its model may think - the same as OpenAI's, plus two. */
const MISTRAL_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const EFFORT_RANK = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

/**
 * Which reasoning_effort values a Mistral model actually accepts, learned from
 * its own refusal rather than assumed: the docs list the full enum, but a given
 * model may support only a subset of it (mistral-medium-2604 answered 400 to
 * 'medium', naming only 'none' and 'high' as valid). Cached per model, per
 * process, so this is paid once.
 */
const mistralEffortSupport = new Map<string, string[]>();

/** The supported value closest to what was asked for, by distance on the scale. */
function nearestEffort(want: string, supported: string[]): string {
  if (supported.includes(want)) return want;
  const wantRank = EFFORT_RANK.indexOf(want);
  let best = supported[0];
  let bestDist = Infinity;
  for (const s of supported) {
    const rank = EFFORT_RANK.indexOf(s);
    const dist = wantRank < 0 || rank < 0 ? Infinity : Math.abs(rank - wantRank);
    if (dist < bestDist) {
      bestDist = dist;
      best = s;
    }
  }
  return best;
}

/**
 * Mistral's answer to an unsupported reasoning_effort names the values that do
 * work, right in the message: "supported values: [<ReasoningEffort.high: 'high'>,
 * <ReasoningEffort.none: 'none'>]". Pull them out rather than hard-coding a table
 * that would silently go stale as Mistral changes what each model supports.
 */
function unsupportedEffortValues(bodyText: string): string[] | null {
  let parsed: { code?: string; message?: string } | null = null;
  try {
    parsed = JSON.parse(bodyText) as { code?: string; message?: string };
  } catch {
    return null;
  }
  const message = parsed?.message ?? '';
  if (parsed?.code !== '3051' && !/reasoning_effort .* not supported for this model/i.test(message)) return null;
  const values = [...message.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  return values.length ? values : null;
}

type Surface = 'responses' | 'chat' | 'mistral';

// The OpenAI account may be on either surface; remember what worked so the
// fallback round-trip is paid once per process. Mistral has one surface.
let openaiSurface: 'responses' | 'chat' | null = null;

function surfaceFor(provider: Provider): Surface {
  if (provider === 'mistral') return 'mistral';
  if (openaiSurface === null) openaiSurface = env.apiStyle;
  return openaiSurface;
}

function keyFor(provider: Provider): { key: string; name: string } {
  return provider === 'mistral'
    ? { key: env.mistralKey, name: 'MISTRAL_API_KEY' }
    : { key: env.openaiKey, name: 'OPENAI_API_KEY' };
}

function urlFor(surface: Surface): string {
  if (surface === 'mistral') return `${env.mistralBase}/chat/completions`;
  return `${env.openaiBase}/${surface === 'responses' ? 'responses' : 'chat/completions'}`;
}

/** The rate-limit bucket a Mistral chat call is counted against. */
function bucketKey(): string {
  return `chat|${env.mistralModel}`;
}

export async function askJson<T>(opts: AskOptions): Promise<T> {
  const provider = opts.ledger?.provider ?? env.provider;
  return withRetries(provider, opts.agent, opts.ledger, 4, async (surface) => {
    const raw = await callOnce(provider, surface, opts, { name: opts.schemaName, schema: opts.schema }, Boolean(opts.onDelta), opts.onDelta);
    return parseJson<T>(raw, opts.agent);
  });
}

/**
 * Plain-text run, streamed. Used for the one run per page that writes the page
 * out in reading order, the output the user watches appear.
 */
export async function askText(opts: AskTextOptions): Promise<string> {
  const provider = opts.ledger?.provider ?? env.provider;
  return withRetries(provider, opts.agent, opts.ledger, 3, (surface) =>
    callOnce(provider, surface, opts, null, true, opts.onDelta)
  );
}

type Failure = Error & { status?: number; code?: string; fatal?: boolean; retryAfter?: number };

async function withRetries<T>(
  provider: Provider,
  agent: string,
  ledger: Ledger | undefined,
  attempts: number,
  run: (surface: Surface) => Promise<T>
): Promise<T> {
  const { key, name } = keyFor(provider);
  if (!key) throw new Error(`[${agent}] ${name} ontbreekt (zie .env.local)`);

  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const surface = surfaceFor(provider);
    try {
      const result = await run(surface);
      if (ledger) ledger.calls++;
      return result;
    } catch (err) {
      lastErr = err;
      const e = err as Failure;
      if (e.fatal) break;
      // A wrong model id looks like any other refusal, but retrying cannot fix
      // it. Name the setting that is wrong instead.
      if (e.code === 'model_not_found' || e.code === 'invalid_model') {
        if (ledger) ledger.failures++;
        const setting = provider === 'mistral' ? 'MISTRAL_MODEL' : 'OPENAI_MODEL';
        throw new Error(
          `[${agent}] Model '${modelFor(provider).model}' bestaat niet of is niet beschikbaar op deze API-key. ` +
            `Zet ${setting} in .env.local op een model dat je account wel heeft.`
        );
      }
      // An OpenAI model that does not speak this surface refuses at once; switch
      // once and retry rather than failing the whole run.
      if (provider === 'openai' && (e.status === 404 || e.status === 400) && surface === 'responses' && attempt === 0) {
        openaiSurface = 'chat';
        continue;
      }
      if (e.status && !RETRYABLE.has(e.status)) break;
      await sleep(e.retryAfter ?? 1200 * 2 ** attempt);
    }
  }
  if (ledger) ledger.failures++;
  throw new Error(`[${agent}] ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

async function callOnce(
  provider: Provider,
  surface: Surface,
  opts: AskOptions | AskTextOptions,
  json: { name: string; schema: JsonSchema } | null,
  stream: boolean,
  onDelta: ((text: string) => void) | undefined,
  retriedEffort = false
): Promise<string> {
  const limited = surface === 'mistral';
  if (limited) {
    if (closed(bucketKey())) throw zeroLimit();
    await slot(bucketKey(), env.mistralReqPerMinute);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(urlFor(surface), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${keyFor(provider).key}` },
      body: JSON.stringify(bodyFor(surface, opts, json, stream)),
      signal: ctrl.signal
    });
    if (limited) observe(bucketKey(), res.headers);

    if (!res.ok || (stream && !res.body)) {
      const text = await res.text();
      // Not a real failure: Mistral is naming which reasoning levels this model
      // actually has. Learn that once and send the request again with one of them.
      if (surface === 'mistral' && !retriedEffort) {
        const supported = unsupportedEffortValues(text);
        if (supported) {
          mistralEffortSupport.set(env.mistralModel, supported);
          return callOnce(provider, surface, opts, json, stream, onDelta, true);
        }
      }
      if (limited && res.status === 429 && closed(bucketKey())) throw zeroLimit();
      const err = new Error(`${res.status} ${text.slice(0, 400)}`) as Failure;
      err.status = res.status;
      err.code = errorCode(text);
      const after = Number(res.headers.get('retry-after'));
      if (Number.isFinite(after) && after > 0) err.retryAfter = after * 1000;
      throw err;
    }

    if (stream && res.body) return await consume(res.body, surface, opts.ledger, onDelta);

    const body = JSON.parse(await res.text()) as Record<string, unknown>;
    account(usageOf(body, surface), opts.ledger);
    return extract(body, surface, Boolean(json));
  } finally {
    clearTimeout(timer);
  }
}

function zeroLimit(): Failure {
  const err = new Error(
    `Mistral staat voor deze key op 0 chat-requests per minuut voor ${env.mistralModel} ` +
      `(x-ratelimit-limit-req-minute: 0). Zet een limiet voor dit model aan op ` +
      `admin.mistral.ai/plateforme/limits, of kies OpenAI.`
  ) as Failure;
  err.fatal = true;
  err.status = 429;
  return err;
}

// ─── Bodies ──────────────────────────────────────────────────────────────────

function bodyFor(
  surface: Surface,
  opts: AskOptions | AskTextOptions,
  json: { name: string; schema: JsonSchema } | null,
  stream: boolean
): Record<string, unknown> {
  const effort = opts.effort ?? env.reasoningEffort;
  const max = opts.maxOutputTokens ?? 16000;
  const images = opts.images ?? [];

  if (surface === 'responses') {
    return {
      model: env.model,
      instructions: opts.instructions,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: opts.input },
            ...images.map((url) => ({ type: 'input_image', image_url: url, detail: 'high' }))
          ]
        }
      ],
      reasoning: { effort },
      max_output_tokens: max,
      ...(json ? { text: { format: { type: 'json_schema', name: json.name, strict: true, schema: json.schema } } } : {}),
      ...(stream ? { stream: true } : {})
    };
  }

  const content = [
    { type: 'text', text: opts.input },
    ...images.map((url) => ({ type: 'image_url', image_url: { url, detail: 'high' } }))
  ];
  const messages = [
    { role: 'system', content: opts.instructions },
    { role: 'user', content }
  ];

  if (surface === 'chat') {
    return {
      model: env.model,
      messages,
      reasoning_effort: effort,
      max_completion_tokens: max,
      ...(json ? { response_format: { type: 'json_schema', json_schema: { name: json.name, strict: true, schema: json.schema } } } : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {})
    };
  }

  // Mistral refuses fields it does not know, so this carries only what its own
  // API spec lists: max_tokens rather than max_completion_tokens, and no
  // stream_options - usage arrives in the stream on its own.
  // Which levels this model actually accepts is learned from its own refusals
  // (see unsupportedEffortValues); once known, the request is built to match
  // instead of guessing again every call.
  const known = mistralEffortSupport.get(env.mistralModel);
  const mistralEffort = known ? nearestEffort(effort, known) : effort;
  return {
    model: env.mistralModel,
    messages,
    max_tokens: max,
    ...(MISTRAL_EFFORTS.has(mistralEffort) ? { reasoning_effort: mistralEffort } : {}),
    ...(json
      ? { response_format: { type: 'json_schema', json_schema: { name: json.name, strict: true, schema: forMistral(json.schema) } } }
      : {}),
    ...(stream ? { stream: true } : {})
  };
}

/**
 * Our schemas mark a field as optional with `type: ['string', 'null']`. That is
 * valid JSON Schema, but Mistral's own examples come out of Pydantic, which
 * writes the same thing as an `anyOf` - so that is the form it is sent in.
 */
function forMistral(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(forMistral);
  if (!schema || typeof schema !== 'object') return schema;

  const node = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' && value && typeof value === 'object') {
      out[key] = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, forMistral(v)]));
    } else if (key === 'items' || key === 'anyOf') {
      out[key] = forMistral(value);
    } else {
      out[key] = value;
    }
  }

  if (!Array.isArray(node.type)) return out;
  const { description, type, ...rest } = out;
  const branches = (type as string[]).map((t) => (t === 'null' ? { type: 'null' } : { type: t, ...rest }));
  return description === undefined ? { anyOf: branches } : { anyOf: branches, description };
}

// ─── Answers ─────────────────────────────────────────────────────────────────

/**
 * Mistral may answer with a list of chunks instead of a string, and when its model
 * reasons, some of those chunks are its thinking. Only the text chunks are the
 * answer; the thinking must never end up in an article.
 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((chunk) => {
      const c = chunk as { type?: string; text?: unknown };
      return c.type === 'text' && typeof c.text === 'string' ? c.text : '';
    })
    .join('');
}

function extract(body: Record<string, unknown>, surface: Surface, json: boolean): string {
  let text = '';
  if (surface === 'responses') {
    if (typeof body.output_text === 'string') text = body.output_text;
    else {
      const output = (body.output ?? []) as Array<{ content?: Array<{ type?: string; text?: string }> }>;
      text = output
        .flatMap((item) => item.content ?? [])
        .filter((c) => typeof c.text === 'string' && c.type !== 'reasoning')
        .map((c) => c.text as string)
        .join('');
    }
  } else {
    const choices = (body.choices ?? []) as Array<{ message?: { content?: unknown } }>;
    text = textOf(choices[0]?.message?.content);
  }
  // An empty text answer is legitimate (a page that is one photograph); an
  // empty structured answer is not, because a schema has required fields.
  if (!text && json) throw new Error('lege response van het model');
  return text;
}

function usageOf(body: Record<string, unknown>, surface: Surface): Record<string, number> | null {
  if (surface === 'responses' && body.response && typeof body.response === 'object') {
    return ((body.response as Record<string, unknown>).usage as Record<string, number>) ?? null;
  }
  return (body.usage as Record<string, number>) ?? null;
}

function account(usage: Record<string, number> | null, ledger?: Ledger) {
  if (!ledger || !usage) return;
  ledger.inputTokens += usage.input_tokens ?? usage.prompt_tokens ?? 0;
  ledger.outputTokens += usage.output_tokens ?? usage.completion_tokens ?? 0;
}

function errorCode(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string }; type?: string; code?: string };
    return parsed.error?.code ?? parsed.type ?? parsed.code ?? '';
  } catch {
    return '';
  }
}

/**
 * Reads one streamed answer, whichever surface it came from and whether it is
 * plain text or a structured object. Both arrive the same way: as deltas of one
 * string, which is why they can share this.
 */
async function consume(
  body: ReadableStream<Uint8Array>,
  surface: Surface,
  ledger: Ledger | undefined,
  onDelta: ((text: string) => void) | undefined
): Promise<string> {
  let out = '';
  let cutOff = false;
  let failed = false;
  // A provider may repeat its running totals on more than one event; counting
  // the last one seen, once, cannot double the bill.
  let usage: Record<string, number> | null = null;

  for await (const event of sseEvents(body)) {
    if (event === '[DONE]') break;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(event) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (surface === 'responses') {
      if (json.type === 'response.output_text.delta') {
        const delta = json.delta as string;
        out += delta;
        onDelta?.(delta);
      } else if (json.type === 'response.completed') {
        usage = usageOf(json, surface) ?? usage;
      } else if (json.type === 'response.incomplete' || json.type === 'response.failed') {
        cutOff = true;
      }
      continue;
    }

    if (json.usage) usage = json.usage as Record<string, number>;
    const choice = (json.choices as Array<{ delta?: { content?: unknown }; finish_reason?: string | null }> | undefined)?.[0];
    const delta = textOf(choice?.delta?.content);
    if (delta) {
      out += delta;
      onDelta?.(delta);
    }
    if (choice?.finish_reason === 'length') cutOff = true;
    if (choice?.finish_reason === 'error') failed = true;
  }

  account(usage, ledger);

  // An empty answer is legitimate: a page can be one full-bleed photo with no
  // running story, and the prompt asks for nothing in that case. Only a model
  // that was cut off mid-sentence is a failure, and retrying will not fix it.
  if (cutOff) {
    const err = new Error('het model werd afgekapt; verhoog max_output_tokens') as Failure;
    err.fatal = true;
    throw err;
  }
  if (failed) {
    const err = new Error('het model brak het antwoord af met een fout') as Failure;
    err.status = 500;
    throw err;
  }
  return out;
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
    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = chunks.pop() ?? '';
    for (const chunk of chunks) {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
  }
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

/**
 * Ask Mistral once, as cheaply as a call can be, whether this key may use the
 * model at all - before the run pays for OCR. A limit of zero or a model the key
 * does not have stops the run here; anything passing, like a busy second, does
 * not, because the real calls have their own retries.
 */
export async function checkMistral(ledger?: Ledger): Promise<void> {
  if (!env.mistralKey) throw new Error('MISTRAL_API_KEY ontbreekt (zie .env.local)');
  try {
    await callOnce(
      'mistral',
      'mistral',
      { agent: 'mistral-check', instructions: 'Antwoord met ok.', input: 'ok', maxOutputTokens: 1, effort: 'none', ledger },
      null,
      false,
      undefined
    );
    if (ledger) ledger.calls++;
  } catch (err) {
    const e = err as Failure;
    if (e.fatal) throw err;
    if (e.code === 'invalid_model' || e.code === 'model_not_found') {
      throw new Error(
        `Model '${env.mistralModel}' bestaat niet of is niet beschikbaar op deze Mistral-key. ` +
          `Zet MISTRAL_MODEL in .env.local op een model dat je account wel heeft.`
      );
    }
  }
}

/** For the interface: what the key is allowed per minute, as far as Mistral has said. */
export function mistralLimit(): number | null {
  return limitOf(bucketKey());
}
