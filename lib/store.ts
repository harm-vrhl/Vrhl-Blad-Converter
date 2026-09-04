import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { env } from './env';
import type { Job } from './types';

const root = () => resolve(process.cwd(), env.dataDir, 'jobs');

export function jobDir(id: string): string {
  if (!/^[a-z0-9-]{8,64}$/i.test(id)) throw new Error('invalid job id');
  return join(root(), id);
}

export async function createJob(filename: string, pageCount: number): Promise<Job> {
  const id = randomUUID();
  const job: Job = {
    id,
    filename,
    status: 'uploading',
    pageCount,
    pages: [],
    createdAt: new Date().toISOString(),
    error: null,
    images: [],
    document: null
  };
  await mkdir(jobDir(id), { recursive: true });
  await saveJob(job);
  return job;
}

export async function saveJob(job: Job): Promise<void> {
  await writeFile(join(jobDir(job.id), 'job.json'), JSON.stringify(job, null, 2), 'utf8');
}

export async function loadJob(id: string): Promise<Job> {
  const file = join(jobDir(id), 'job.json');
  if (!existsSync(file)) throw new Error(`job ${id} not found`);
  return JSON.parse(await readFile(file, 'utf8')) as Job;
}

export async function writeArtifact(id: string, name: string, data: Buffer | string): Promise<string> {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  await writeFile(join(jobDir(id), safe), data as never);
  return safe;
}

export async function readArtifact(id: string, name: string): Promise<Buffer> {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  return readFile(join(jobDir(id), safe));
}

export async function readArtifactAsDataUrl(id: string, name: string, mime: string): Promise<string> {
  const buf = await readArtifact(id, name);
  return `data:${mime};base64,${buf.toString('base64')}`;
}
