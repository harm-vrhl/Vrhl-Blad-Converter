import { loadJob, saveJob } from '@/lib/store';
import { missingKeys } from '@/lib/env';
import { runPipeline } from '@/lib/pipeline';

export const runtime = 'nodejs';
export const maxDuration = 3600;

/** Server-sent events over POST; the client reads the stream by hand. */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const missing = missingKeys();
  if (missing.length) {
    return new Response(`data: ${JSON.stringify({ step: 'env', label: `Ontbrekende sleutels: ${missing.join(', ')}`, state: 'fail' })}\n\n`, {
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
      const send = (payload: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      try {
        for await (const event of runPipeline(job)) send(event);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        job.status = 'error';
        job.error = message;
        await saveJob(job).catch(() => undefined);
        send({ step: 'error', label: message, state: 'fail' });
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, { headers: sseHeaders() });
}

function sseHeaders(): Record<string, string> {
  return {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive'
  };
}
