import { AUTH_COOKIE, AUTH_DAYS, authEnabled, checkPassword, issueToken } from '@/lib/auth';
import { loginGate } from '@/lib/server/loginlimit';

/** Het wachtwoord erin, een ondertekende cookie eruit. */
export async function POST(request: Request) {
  if (!authEnabled()) return Response.json({ ok: true });

  // Vóór het wachtwoord: wie te vaak raadt, hoort niet meer of het klopte.
  const gate = await loginGate(request);
  if (!gate.allowed) {
    const minutes = Math.max(1, Math.ceil(gate.retryAfter / 60));
    return Response.json(
      { error: `Te veel pogingen. Probeer het over ${minutes} ${minutes === 1 ? 'minuut' : 'minuten'} opnieuw.` },
      { status: 429, headers: { 'retry-after': String(gate.retryAfter) } }
    );
  }

  const body = (await request.json().catch(() => ({}))) as { password?: unknown };
  const password = typeof body.password === 'string' ? body.password : '';
  if (!(await checkPassword(password))) {
    // Een beetje wachten maakt raden traag, zonder dat iemand die zich vertypt
    // het merkt.
    await new Promise((done) => setTimeout(done, 600));
    return Response.json({ error: 'Dat wachtwoord klopt niet.' }, { status: 401 });
  }

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
