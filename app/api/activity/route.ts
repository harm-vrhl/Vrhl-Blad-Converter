import { sanitizeTaak, writeActivity } from '@/lib/server/activity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Taken uit de browser (omzetten, export, inlog). Stappen van de server
 * komen hier niet binnen: die schrijft de route zelf naar stdout.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const event = sanitizeTaak(body);
  if (!event) return Response.json({ error: 'ongeldige gebeurtenis' }, { status: 400 });
  await writeActivity(event);
  return Response.json({ ok: true });
}
