import { AsyncLocalStorage } from 'node:async_hooks';
import type { ActivityEvent, ActivityStamp } from '../activity';
import { regelVan, usageOf } from '../activity';
import { errorMessage } from '../util';

/**
 * Elke gebeurtenis is één JSON-regel op stdout, voor de Runtime Logs van
 * Vercel. Filter daar op `src:vrhl`. Geen PDF, geen artikeltekst, en niets
 * bewaren: de server onthoudt nog steeds niets tussen twee verzoeken.
 */

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
      task: clip(value.task, 80),
      taak: clip(value.taak, 40)
    };
    if (!stamp.clientId && !stamp.naam && !stamp.task && !stamp.taak) return undefined;
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
  console.log(JSON.stringify({ src: 'vrhl', msg: regelVan(full), ...full }));
  return full;
}

export async function noteStep(ok: boolean, ms: number, body?: unknown, err?: unknown): Promise<void> {
  const slot = stepSlot.getStore();
  if (!slot) return;
  const usage = usageOf(body);
  await writeActivity({
    kind: 'stap',
    status: ok ? 'ok' : 'fail',
    taak: slot.taak ?? slot.activity?.taak,
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

function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
  return text || undefined;
}
