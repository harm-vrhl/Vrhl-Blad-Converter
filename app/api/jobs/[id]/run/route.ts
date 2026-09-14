import { loadJob, saveJob } from '@/lib/store';
import { env, missingKeys, PROVIDERS, type Provider } from '@/lib/env';
import { runPipeline } from '@/lib/pipeline';

export const runtime = 'nodejs';
export const maxDuration = 3600;

/** Server-sent events over POST; the client reads the stream by hand. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // The interface says which model writes this run; anything else falls back
  // to the installation's default rather than failing on a stray value.
  const body = (await request.json().catch(() => ({}))) as { provider?: unknown };
  const provider: Provider = PROVIDERS.includes(body.provider as Provider) ? (body.provider as Provider) : env.provider;

  const missing = missingKeys(provider);
  if (missing.length) {
    return new Response(event({ type: 'status', run: 'sleutels', state: 'fail', detail: `Ontbrekende sleutels: ${missing.join(', ')}` }), {
      headers: sseHeaders()
    });
  }

  const job = await loadJob(id);
  job.status = 'running';
  job.error = null;
  await saveJob(job);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: unknown) => controller.enqueue(encoder.encode(event(payload)));
      try {
        for await (const next of runPipeline(job, { provider })) send(next);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        job.status = 'error';
        job.error = message;
        await saveJob(job).catch(() => undefined);
        // A status without a page number is what the interface treats as the end
        // of the run, so a crash has to arrive in that shape to be seen at all.
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
