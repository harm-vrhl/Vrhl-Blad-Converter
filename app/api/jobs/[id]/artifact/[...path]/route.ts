import { readArtifact } from '@/lib/store';

export const runtime = 'nodejs';

const MIME: Record<string, string> = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  json: 'application/json',
  pdf: 'application/pdf'
};

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; path: string[] }> }) {
  const { id, path } = await params;
  const name = path.join('/');
  try {
    const buf = await readArtifact(id, name);
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    return new Response(new Uint8Array(buf), {
      headers: {
        'content-type': MIME[ext] ?? 'application/octet-stream',
        'cache-control': 'private, max-age=3600'
      }
    });
  } catch {
    return new Response('not found', { status: 404 });
  }
}
