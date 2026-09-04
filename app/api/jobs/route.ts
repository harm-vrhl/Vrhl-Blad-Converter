import { NextResponse } from 'next/server';
import { createJob, saveJob, writeArtifact } from '@/lib/store';
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

  const job = await createJob(file.name, pageCount);
  await writeArtifact(job.id, 'source.pdf', Buffer.from(await file.arrayBuffer()));
  await saveJob(job);

  return NextResponse.json({ job, missingKeys: missingKeys() });
}
