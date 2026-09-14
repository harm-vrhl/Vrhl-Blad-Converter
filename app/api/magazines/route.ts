import { NextResponse } from 'next/server';
import { writeArtifact } from '@/lib/store';
import { createMagazine, saveMagazine } from '@/lib/magazine/store';
import { missingKeys } from '@/lib/env';

export const runtime = 'nodejs';

/**
 * A whole magazine. The PDF is kept, so the pages of an article can be cut out of
 * it again later without the browser still holding the file.
 */
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

  const magazine = await createMagazine(file.name, pageCount);
  await writeArtifact(magazine.id, 'source.pdf', Buffer.from(await file.arrayBuffer()));
  await saveMagazine(magazine);

  return NextResponse.json({ magazine, missingKeys: missingKeys().filter((k) => k !== 'MISTRAL_API_KEY') });
}
