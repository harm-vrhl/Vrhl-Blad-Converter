'use client';

import type { ActivityEvent, ActivityStamp, ActivityStatus, ActivityUsage, Taak } from '../activity';
import { newId } from './db';

const CLIENT_KEY = 'vrhl-client';
const NAAM_KEY = 'vrhl-naam';

/** Stabiel per browser, zodat het logboek sessies uit elkaar houdt. */
export function clientId(): string {
  try {
    const existing = window.localStorage.getItem(CLIENT_KEY);
    if (existing) return existing;
    const id = newId();
    window.localStorage.setItem(CLIENT_KEY, id);
    return id;
  } catch {
    return 'onbekend';
  }
}

export function naam(): string {
  try {
    return (window.localStorage.getItem(NAAM_KEY) ?? '').trim();
  } catch {
    return '';
  }
}

export function setNaam(value: string): void {
  try {
    const clipped = value.trim().slice(0, 40);
    if (clipped) window.localStorage.setItem(NAAM_KEY, clipped);
    else window.localStorage.removeItem(NAAM_KEY);
  } catch {
    /* een naam is handig, geen vereiste */
  }
}

/** Meesturen bij elk verzoek, zodat de server de stap aan de taak hangt. */
export function activityStamp(task?: string): ActivityStamp {
  return {
    clientId: clientId(),
    naam: naam() || undefined,
    task: task || undefined
  };
}

export function beginTaak(input: {
  taak: Taak;
  titel?: string;
  pages?: number;
  job?: string;
  formaat?: string;
}): string {
  const task = newId();
  void meld({
    kind: 'taak',
    status: 'start',
    taak: input.taak,
    task,
    titel: input.titel,
    pages: input.pages,
    job: input.job,
    formaat: input.formaat
  });
  return task;
}

export function eindTaak(
  task: string,
  status: Exclude<ActivityStatus, 'start'>,
  extra: {
    taak: Taak;
    titel?: string;
    pages?: number;
    job?: string;
    formaat?: string;
    error?: string | null;
    ms?: number;
    usage?: ActivityUsage;
  }
): void {
  void meld({
    kind: 'taak',
    status,
    taak: extra.taak,
    task,
    titel: extra.titel,
    pages: extra.pages,
    job: extra.job,
    formaat: extra.formaat,
    error: extra.error ?? undefined,
    ms: extra.ms,
    usage: extra.usage
  });
}

/** Een taak om een gewone async-functie heen; generators gebruiken begin/eind. */
export async function inTaak<T>(
  input: {
    taak: Taak;
    titel?: string;
    pages?: number;
    job?: string;
    formaat?: string;
  },
  work: (task: string) => Promise<T>
): Promise<T> {
  const task = beginTaak(input);
  const started = Date.now();
  try {
    const result = await work(task);
    eindTaak(task, 'ok', { ...input, ms: Date.now() - started });
    return result;
  } catch (err) {
    eindTaak(task, 'fail', {
      ...input,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message : String(err)
    });
    throw err;
  }
}

async function meld(event: Omit<ActivityEvent, 'id' | 'at'>): Promise<void> {
  const body = {
    ...event,
    clientId: clientId(),
    naam: naam() || undefined
  };
  try {
    await fetch('/api/activity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true
    });
  } catch {
    /* een gemiste regel mag een run niet omleggen */
  }
}
