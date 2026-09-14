import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { jobDir } from '../store';
import type { Magazine } from './types';

/**
 * A magazine lives next to the article jobs, in its own folder under the same
 * root, so the artifact route serves its page images without knowing the
 * difference. What tells them apart is the file: magazine.json, not job.json.
 */
export async function createMagazine(filename: string, pageCount: number): Promise<Magazine> {
  const magazine: Magazine = {
    id: randomUUID(),
    kind: 'magazine',
    filename,
    pageCount,
    pages: [],
    createdAt: new Date().toISOString(),
    status: 'uploading',
    error: null,
    map: null
  };
  await mkdir(jobDir(magazine.id), { recursive: true });
  await saveMagazine(magazine);
  return magazine;
}

export async function saveMagazine(magazine: Magazine): Promise<void> {
  await writeFile(join(jobDir(magazine.id), 'magazine.json'), JSON.stringify(magazine, null, 2), 'utf8');
}

export async function loadMagazine(id: string): Promise<Magazine> {
  const file = join(jobDir(id), 'magazine.json');
  if (!existsSync(file)) throw new Error(`magazine ${id} niet gevonden`);
  return JSON.parse(await readFile(file, 'utf8')) as Magazine;
}
