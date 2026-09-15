'use client';

import type { PageAsset, RunUsage } from '../../types';
import { getData, needFile, putData, type StoredJob } from '../db';
import { limiter, type Limiter } from '../limiter';

interface Settings {
  concurrency: number;
  mistralReqPerMinute: number;
}

let settings: Promise<Settings> | null = null;

function runSettings(): Promise<Settings> {
  settings ??= fetch('/api/settings')
    .then((res) => (res.ok ? res.json() : {}))
    .then((body: Partial<Settings>) => ({
      concurrency: body.concurrency ?? 4,
      mistralReqPerMinute: body.mistralReqPerMinute ?? 60
    }))
    .catch(() => ({ concurrency: 4, mistralReqPerMinute: 60 }));
  return settings;
}

/**
 * Gedeeld door elke run in dit tabblad. Een magazine zet drie artikelen tegelijk
 * om, en die moeten samen onder Mistrals limiet blijven, niet elk apart.
 */
let lanes: Promise<{ openai: Limiter; mistral: Limiter; ocr: Limiter }> | null = null;

function lanesFor() {
  lanes ??= runSettings().then(({ concurrency, mistralReqPerMinute }) => ({
    openai: limiter(concurrency),
    mistral: limiter(concurrency, mistralReqPerMinute),
    ocr: limiter(concurrency, mistralReqPerMinute)
  }));
  return lanes;
}

export interface Bill {
  calls: number;
  tokens: number;
  ocrPages: number;
  ai: number;
  ocr: number;
  currency: string;
}

/** Wat elke stap van één run deelt: de job, het tempo, de bon en de opslag. */
export interface RunContext {
  id: string;
  job: StoredJob;
  provider: 'openai' | 'mistral';
  /** Het tempo van de provider die schrijft. */
  chat: Limiter;
  ocrLane: Limiter;
  assets: PageAsset[];
  bill: Bill;
  add: (usage: RunUsage | undefined) => void;
  /** Een stap die maar één keer betaald hoeft te worden: bewaard, en bij hervatten gelezen. */
  once: <T extends { usage?: RunUsage }>(name: string, work: () => Promise<T>) => Promise<T>;
  files: (names: string[]) => Promise<Record<string, Blob>>;
}

export async function runContext(job: StoredJob, provider: 'openai' | 'mistral'): Promise<RunContext> {
  const id = job.id;
  const { openai, mistral, ocr: ocrLane } = await lanesFor();
  const chat = provider === 'mistral' ? mistral : openai;
  const assets = [...job.pages].sort((a, b) => a.page - b.page);
  const bill: Bill = { calls: 0, tokens: 0, ocrPages: 0, ai: 0, ocr: 0, currency: 'USD' };
  const add = (usage: RunUsage | undefined) => {
    if (!usage) return;
    bill.calls += usage.calls;
    bill.tokens += usage.tokens;
    bill.ocrPages += usage.ocrPages;
    bill.ai += usage.ai;
    bill.ocr += usage.ocr;
    bill.currency = usage.currency;
  };

  /** Een stap die maar één keer betaald hoeft te worden: bewaard, en bij hervatten gelezen. */
  const once = async <T extends { usage?: RunUsage }>(name: string, work: () => Promise<T>): Promise<T> => {
    const cached = await getData<T>(id, `run/${name}`);
    if (cached) {
      add(cached.usage);
      return cached;
    }
    const fresh = await work();
    await putData(id, `run/${name}`, fresh);
    add(fresh.usage);
    return fresh;
  };

  const files = async (names: string[]) =>
    Object.fromEntries(await Promise.all(names.map(async (name) => [name, await needFile(id, name)] as const)));

  return { id, job, provider, chat, ocrLane, assets, bill, add, once, files };
}
