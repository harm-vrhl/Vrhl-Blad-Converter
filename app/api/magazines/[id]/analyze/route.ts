import { env, PROVIDERS, type Provider } from '@/lib/env';
import { analyzeMagazine } from '@/lib/magazine/analyze';
import { loadMagazine, saveMagazine } from '@/lib/magazine/store';

export const runtime = 'nodejs';
export const maxDuration = 3600;

/** Server-sent events over POST, the same shape the article run streams in. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { provider?: unknown };
  const provider: Provider = PROVIDERS.includes(body.provider as Provider) ? (body.provider as Provider) : env.provider;

  // No OCR here, so only the key of whoever looks at the pages.
  const key = provider === 'mistral' ? env.mistralKey : env.openaiKey;
  if (!key) {
    const name = provider === 'mistral' ? 'MISTRAL_API_KEY' : 'OPENAI_API_KEY';
    return new Response(event({ type: 'status', run: 'sleutels', state: 'fail', detail: `Ontbrekende sleutel: ${name}` }), {
      headers: sseHeaders()
    });
  }

  const magazine = await loadMagazine(id);
  if (magazine.pages.length < magazine.pageCount) {
    return new Response(
      event({ type: 'status', run: 'upload', state: 'fail', detail: `${magazine.pages.length} van ${magazine.pageCount} pagina's zijn binnen` }),
      { headers: sseHeaders() }
    );
  }
  magazine.status = 'running';
  magazine.error = null;
  await saveMagazine(magazine);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: unknown) => controller.enqueue(encoder.encode(event(payload)));
      try {
        for await (const next of analyzeMagazine(magazine, { provider })) send(next);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        magazine.status = 'error';
        magazine.error = message;
        await saveMagazine(magazine).catch(() => undefined);
        send({ type: 'status', run: 'fout', state: 'fail', detail: message });
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, { headers: sseHeaders() });
}

function event(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sseHeaders(): Record<string, string> {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  };
}
