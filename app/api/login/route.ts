import { AUTH_COOKIE, AUTH_DAYS, authEnabled, checkPassword, issueToken } from '@/lib/auth';
import { writeActivity } from '@/lib/server/activity';
import { loginGate } from '@/lib/server/loginlimit';

/** Het wachtwoord erin, een ondertekende cookie eruit. */
export async function POST(request: Request) {
  if (!authEnabled()) return Response.json({ ok: true });

  const body = (await request.json().catch(() => ({}))) as {
    password?: unknown;
    naam?: unknown;
    clientId?: unknown;
  };
  const password = typeof body.password === 'string' ? body.password : '';
  const naam = clip(body.naam, 40);
  const clientId = clip(body.clientId, 80);

  // Vóór het wachtwoord: wie te vaak raadt, hoort niet meer of het klopte.
  const gate = await loginGate(request);
  if (!gate.allowed) {
    const minutes = Math.max(1, Math.ceil(gate.retryAfter / 60));
    await writeActivity({ kind: 'taak', taak: 'inlog', status: 'fail', naam, clientId, error: 'te veel pogingen' });
    return Response.json(
      { error: `Te veel pogingen. Probeer het over ${minutes} ${minutes === 1 ? 'minuut' : 'minuten'} opnieuw.` },
      { status: 429, headers: { 'retry-after': String(gate.retryAfter) } }
    );
  }

  if (!(await checkPassword(password))) {
    await new Promise((done) => setTimeout(done, 600));
    await writeActivity({ kind: 'taak', taak: 'inlog', status: 'fail', naam, clientId });
    return Response.json({ error: 'Dat wachtwoord klopt niet.' }, { status: 401 });
  }

  await writeActivity({ kind: 'taak', taak: 'inlog', status: 'ok', naam, clientId });

  const secure = new URL(request.url).protocol === 'https:';
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'content-type': 'application/json',
      'set-cookie': [
        `${AUTH_COOKIE}=${await issueToken()}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${AUTH_DAYS * 24 * 60 * 60}`,
        secure ? 'Secure' : ''
      ]
        .filter(Boolean)
        .join('; ')
    }
  });
}

function clip(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);
  return text || undefined;
}
