import { NextResponse } from 'next/server';
import { createJob, saveJob, writeArtifact } from '@/lib/store';
import type { ArticleContext } from '@/lib/types';
import { missingKeys } from '@/lib/env';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const form = await request.formData();
  const file = form.get('file');
  const pageCount = Number(form.get('pageCount') ?? 0);

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'geen bestand ontvangen' }, { status: 400 });
  }
  if (!Number.isFinite(pageCount) || pageCount < 1) {
    return NextResponse.json({ error: 'ongeldig aantal pagina’s' }, { status: 400 });
  }

  // How many pages the opening spans, when a magazine scan found out. Anything
  // else than a small whole number is ignored and the pipeline's default applies.
  const opening = Number(form.get('opening') ?? 0);
  const job = await createJob(file.name, pageCount, {
    opening: Number.isInteger(opening) && opening >= 1 && opening <= 3 ? opening : undefined,
    context: readContext(String(form.get('context') ?? ''))
  });
  await writeArtifact(job.id, 'source.pdf', Buffer.from(await file.arrayBuffer()));
  await saveJob(job);

  return NextResponse.json({ job, missingKeys: missingKeys() });
}

/** What a magazine scan said the article is about, held to its shape. */
function readContext(raw: string): ArticleContext | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
    const context = {
      title: text(parsed.title, 300) || null,
      rubric: text(parsed.rubric, 120) || null,
      about: text(parsed.about, 600)
    };
    return context.title || context.about ? context : undefined;
  } catch {
    return undefined;
  }
}
