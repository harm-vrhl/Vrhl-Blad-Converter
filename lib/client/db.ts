'use client';

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Magazine } from '../magazine/types';
import type { ArticleDocument, ImageVerdict, Job } from '../types';

/**
 * De opslag van de app, in de browser zelf (IndexedDB).
 *
 * Op Vercel onthoudt de server niets, dus staat hier alles wat een omzetting
 * oplevert: de job, de renders en foto's als bestanden, en de tussenresultaten
 * van elke stap. Dat laatste is wat een afgebroken run laat verdergaan waar hij
 * was, zonder de OCR opnieuw te betalen.
 *
 * Wat hier staat, staat op deze computer in deze browser. Het archief is Sanity;
 * dit is de werkplaats.
 *
 * Bestanden en data hangen aan een eigenaar (een job of een magazine) onder een
 * sleutel `<eigenaar>/<naam>`, met dezelfde namen die de server vroeger op schijf
 * gebruikte: `page-01.jpeg`, `img-p01-01-thumb.jpeg`, `ocr.json`.
 */

/** Wat een afgeronde run kostte: de bon onder de stappen die hem uitgaven. */
export interface Totals {
  runs: number;
  tokens: number;
  ms: number;
  ocrPages: number;
  cost: { ai: number; ocr: number; total: number; currency: string } | null;
}

export interface StoredJob extends Job {
  /** Het artikel zoals iemand het rechtzette, of null zolang niemand iets deed. */
  edited: ArticleDocument | null;
  verdicts: ImageVerdict[];
  totals: Totals | null;
  updatedAt: string;
}

interface Schema extends DBSchema {
  jobs: { key: string; value: StoredJob };
  magazines: { key: string; value: Magazine & { updatedAt?: string } };
  files: { key: string; value: Blob };
  data: { key: string; value: unknown };
}

let opening: Promise<IDBPDatabase<Schema>> | null = null;

function db(): Promise<IDBPDatabase<Schema>> {
  opening ??= openDB<Schema>('vrhl-blad', 1, {
    upgrade(database) {
      database.createObjectStore('jobs');
      database.createObjectStore('magazines');
      database.createObjectStore('files');
      database.createObjectStore('data');
    }
  });
  return opening;
}

const key = (owner: string, name: string) => `${owner}/${name}`;
/** Alles van één eigenaar: van `<id>/` tot en met het laatste teken erna. */
const range = (owner: string) => IDBKeyRange.bound(`${owner}/`, `${owner}/￿`);

export function newId(): string {
  return crypto.randomUUID();
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

export async function saveJob(job: StoredJob): Promise<void> {
  job.updatedAt = new Date().toISOString();
  await (await db()).put('jobs', job, job.id);
  void persist();
}

export async function loadJob(id: string): Promise<StoredJob | undefined> {
  return (await db()).get('jobs', id);
}

/** Nieuwste eerst. */
export async function listJobs(): Promise<StoredJob[]> {
  const all = await (await db()).getAll('jobs');
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Een job of magazine weg, met alles wat eraan hangt. */
export async function deleteOwner(id: string): Promise<void> {
  const tx = (await db()).transaction(['jobs', 'magazines', 'files', 'data'], 'readwrite');
  await Promise.all([
    tx.objectStore('jobs').delete(id),
    tx.objectStore('magazines').delete(id),
    tx.objectStore('files').delete(range(id)),
    tx.objectStore('data').delete(range(id)),
    tx.done
  ]);
  for (const [name, url] of urls) {
    if (name.startsWith(`${id}/`)) {
      URL.revokeObjectURL(url);
      urls.delete(name);
    }
  }
}

/**
 * Alles in deze browser weg: artikelen, magazines, bestanden en tussenresultaten.
 * De verbinding blijft open; alleen de inhoud van de stores verdwijnt.
 */
export async function clearAll(): Promise<void> {
  const tx = (await db()).transaction(['jobs', 'magazines', 'files', 'data'], 'readwrite');
  await Promise.all([
    tx.objectStore('jobs').clear(),
    tx.objectStore('magazines').clear(),
    tx.objectStore('files').clear(),
    tx.objectStore('data').clear(),
    tx.done
  ]);
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
}

// ─── Magazines ───────────────────────────────────────────────────────────────

export async function saveMagazine(magazine: Magazine): Promise<void> {
  await (await db()).put('magazines', { ...magazine, updatedAt: new Date().toISOString() }, magazine.id);
  void persist();
}

export async function loadMagazine(id: string): Promise<Magazine | undefined> {
  return (await db()).get('magazines', id);
}

export async function listMagazines(): Promise<Magazine[]> {
  const all = await (await db()).getAll('magazines');
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ─── Bestanden en data ───────────────────────────────────────────────────────

export async function putFile(owner: string, name: string, blob: Blob): Promise<string> {
  await (await db()).put('files', blob, key(owner, name));
  return name;
}

export async function getFile(owner: string, name: string): Promise<Blob | undefined> {
  return (await db()).get('files', key(owner, name));
}

/** Een bestand dat er moet zijn; ontbreekt het, dan zegt de fout welk. */
export async function needFile(owner: string, name: string): Promise<Blob> {
  const blob = await getFile(owner, name);
  if (!blob) throw new Error(`${name} staat niet (meer) in de opslag van deze browser`);
  return blob;
}

export async function putData(owner: string, name: string, value: unknown): Promise<void> {
  await (await db()).put('data', value, key(owner, name));
}

export async function getData<T>(owner: string, name: string): Promise<T | undefined> {
  return (await db()).get('data', key(owner, name)) as Promise<T | undefined>;
}

/** Alle data van een eigenaar waarvan de naam met `prefix` begint, weg. */
export async function deleteData(owner: string, prefix: string): Promise<void> {
  await (await db()).delete('data', range(`${owner}/${prefix}`.replace(/\/$/, '')));
}

/** Hoeveel bytes aan bestanden er aan een eigenaar hangen. */
export async function sizeOf(owner: string): Promise<number> {
  let total = 0;
  let cursor = await (await db()).transaction('files').store.openCursor(range(owner));
  while (cursor) {
    total += cursor.value.size;
    cursor = await cursor.continue();
  }
  return total;
}

const urls = new Map<string, string>();

/**
 * Een bestand als adres voor een `<img>`. Eén adres per bestand, zolang de pagina
 * open is: dezelfde foto in de preview en in de lijst hoeft niet twee keer uit de
 * database.
 */
export async function fileUrl(owner: string, name: string): Promise<string | null> {
  const k = key(owner, name);
  const known = urls.get(k);
  if (known) return known;
  const blob = await getFile(owner, name);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urls.set(k, url);
  return url;
}

/** Zonder naar de database te gaan, als het adres er al is. */
export function knownUrl(owner: string, name: string): string | undefined {
  return urls.get(key(owner, name));
}

// ─── Ruimte ──────────────────────────────────────────────────────────────────

let asked = false;

/**
 * Vraag de browser deze opslag niet op te ruimen als de schijf vol raakt. Chrome
 * geeft dat stil aan een site die je vaak gebruikt; Safari en Firefox kunnen het
 * vragen. Eén keer per sessie is genoeg.
 */
export async function persist(): Promise<boolean> {
  if (asked || typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  asked = true;
  try {
    return (await navigator.storage.persisted()) || (await navigator.storage.persist());
  } catch {
    return false;
  }
}

export async function estimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return usage != null && quota != null ? { usage, quota } : null;
  } catch {
    return null;
  }
}
