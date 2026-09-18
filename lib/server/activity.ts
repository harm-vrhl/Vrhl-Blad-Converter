import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActivityEvent, ActivityStamp } from '../activity';
import { usageOf } from '../activity';
import { env } from '../env';
import { errorMessage } from '../util';

/**
 * Waar het logboek landt.
 *
 * De server onthoudt geen artikelen: geen PDF, geen OCR, geen schijf. Deze
 * gebeurtenissen zijn kort (wie, wat, hoe lang, wat het kostte) en moeten wél
 * over machines heen zichtbaar zijn. Daarom:
 *
 * 1. altijd een JSON-regel op stdout, voor de Runtime Logs van Vercel;
 * 2. als Sanity is gekoppeld, hetzelfde in een aparte dataset (`logs` standaard),
 *    zodat `/logboek` ze kan tonen. Niet de dataset van de artikelen.
 */

const TYPE = 'vrhl.activity';
const LIMIT = 300;
const WRITE_MS = 2500;

export interface StepSlot {
  route: string;
  activity?: ActivityStamp;
  page?: number;
  taak?: string;
}

export const stepSlot = new AsyncLocalStorage<StepSlot>();

export function parseActivity(raw: FormDataEntryValue | null): ActivityStamp | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const stamp: ActivityStamp = {
      clientId: clip(value.clientId, 80),
      naam: clip(value.naam, 40),
      task: clip(value.task, 80)
    };
    if (!stamp.clientId && !stamp.naam && !stamp.task) return undefined;
    return stamp;
  } catch {
    return undefined;
  }
}

export function pageOf(input: unknown): number | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const rec = input as Record<string, unknown>;
  const direct = asPage(rec.page) ?? asPage(rec.pdf);
  if (direct) return direct;
  if (rec.page && typeof rec.page === 'object') return asPage((rec.page as { page?: unknown }).page);
  return undefined;
}

function asPage(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 20_000) return undefined;
  return value;
}

export async function writeActivity(event: Omit<ActivityEvent, 'id' | 'at'> & { id?: string; at?: string }): Promise<ActivityEvent> {
  const full: ActivityEvent = {
    ...event,
    id: event.id ?? crypto.randomUUID(),
    at: event.at ?? new Date().toISOString()
  };
  console.log(JSON.stringify({ src: 'vrhl', ...full }));
  if (env.activityLog) await persist(full).catch((err) => {
    console.error('[logboek] bewaren mislukte:', errorMessage(err));
  });
  return full;
}

export async function noteStep(ok: boolean, ms: number, body?: unknown, err?: unknown): Promise<void> {
  const slot = stepSlot.getStore();
  if (!slot) return;
  const usage = usageOf(body);
  await writeActivity({
    kind: 'stap',
    status: ok ? 'ok' : 'fail',
    taak: slot.taak,
    task: slot.activity?.task,
    naam: slot.activity?.naam,
    clientId: slot.activity?.clientId,
    route: slot.route,
    page: slot.page,
    ms,
    usage,
    error: ok ? undefined : clip(errorMessage(err), 300)
  });
}

export interface ActivityList {
  events: ActivityEvent[];
  store: 'sanity' | 'stdout';
  hint?: string;
}

export async function listActivity(limit = LIMIT): Promise<ActivityList> {
  if (!env.activityLog) {
    return { events: [], store: 'stdout', hint: 'ACTIVITY_LOG staat uit; gebeurtenissen staan alleen in de serverlog.' };
  }
  if (!canStore()) {
    return {
      events: [],
      store: 'stdout',
      hint: 'Het logboek in de app vraagt om Sanity (dezelfde drie variabelen als Vrhl-Blad-Studio), in een aparte dataset. Zolang die er niet is, staan de gebeurtenissen in de Runtime Logs van Vercel.'
    };
  }
  try {
    const cap = Math.min(Math.max(1, limit), LIMIT);
    const events = await queryDataset<ActivityEvent[]>(
      env.activityDataset,
      `*[_type == "${TYPE}"] | order(at desc) [0...${cap}] {
        id, at, kind, status, taak, task, naam, clientId, titel, pages, job, route, page, ms, usage, error, formaat
      }`
    );
    return { events: Array.isArray(events) ? events : [], store: 'sanity' };
  } catch (err) {
    return {
      events: [],
      store: 'stdout',
      hint: `Het logboek kon de dataset "${env.activityDataset}" niet lezen: ${errorMessage(err)}`
    };
  }
}

/** Alleen velden die een taak mogen beschrijven; nooit het verzoek zelf. */
export function sanitizeTaak(body: unknown): Omit<ActivityEvent, 'id' | 'at'> | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Record<string, unknown>;
  if (raw.kind !== 'taak') return null;
  const status = raw.status === 'start' || raw.status === 'ok' || raw.status === 'fail' ? raw.status : null;
  if (!status) return null;
  const taak = clip(raw.taak, 40);
  if (!taak) return null;
  return {
    kind: 'taak',
    status,
    taak,
    task: clip(raw.task, 80),
    naam: clip(raw.naam, 40),
    clientId: clip(raw.clientId, 80),
    titel: clip(raw.titel, 180),
    pages: asPage(raw.pages) ?? (typeof raw.pages === 'number' && raw.pages === 0 ? 0 : undefined),
    job: clip(raw.job, 80),
    ms: typeof raw.ms === 'number' && Number.isFinite(raw.ms) && raw.ms >= 0 ? Math.round(raw.ms) : undefined,
    usage: usageOf(raw.usage),
    error: clip(raw.error, 300),
    formaat: clip(raw.formaat, 20)
  };
}

function canStore(): boolean {
  return Boolean(env.sanityProjectId && env.sanityToken);
}

let datasetOk: boolean | null = null;

async function persist(event: ActivityEvent): Promise<void> {
  if (!canStore()) return;
  const dataset = env.activityDataset;
  const ready = datasetOk === true || (await ensureDataset(dataset));
  if (!ready) return;
  const doc = { _id: `vrhl.activity.${event.id}`, _type: TYPE, ...event };
  await mutateDataset(dataset, [{ create: doc }]);
}

async function ensureDataset(name: string): Promise<boolean> {
  if (datasetOk === false) return false;
  if (datasetOk === true) return true;
  try {
    const ok = await putDataset(name);
    datasetOk = ok;
    return ok;
  } catch (err) {
    console.error('[logboek] dataset klaarzetten mislukte:', errorMessage(err));
    datasetOk = false;
    return false;
  }
}

async function putDataset(name: string): Promise<boolean> {
  if (!canStore()) return false;
  const url = `https://api.sanity.io/v${env.sanityApiVersion}/projects/${env.sanityProjectId}/datasets/${encodeURIComponent(name)}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${env.sanityToken}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ aclMode: 'private' }),
    signal: AbortSignal.timeout(WRITE_MS)
  });
  // 200/201 aangemaakt, 409 bestaat al: beide goed. 403/401: dit token mag het niet.
  if (response.ok || response.status === 409) return true;
  const text = await response.text().catch(() => '');
  if (response.status === 400 && /already exists|already defined/i.test(text)) return true;
  console.error(`[logboek] dataset "${name}" gaf ${response.status}: ${text.slice(0, 200)}`);
  return false;
}

async function mutateDataset(dataset: string, mutations: unknown[]): Promise<void> {
  const response = await fetch(
    `https://${env.sanityProjectId}.api.sanity.io/v${env.sanityApiVersion}/data/mutate/${dataset}?returnIds=true`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.sanityToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ mutations }),
      signal: AbortSignal.timeout(WRITE_MS)
    }
  );
  if (response.ok) return;
  const text = await response.text().catch(() => '');
  throw new Error(`Sanity gaf ${response.status} op het logboek: ${text.slice(0, 200)}`);
}

async function queryDataset<T>(dataset: string, groq: string): Promise<T> {
  const url = new URL(`https://${env.sanityProjectId}.api.sanity.io/v${env.sanityApiVersion}/data/query/${dataset}`);
  url.searchParams.set('query', groq);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${env.sanityToken}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(WRITE_MS)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Sanity gaf ${response.status}: ${text.slice(0, 200)}`);
  }
  const body = (await response.json()) as { result: T };
  return body.result;
}

function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
  return text || undefined;
}
