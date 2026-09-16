import { checkRateLimit } from '@vercel/firewall';

/**
 * Hoe vaak iemand het wachtwoord mag proberen.
 *
 * Eén gedeeld wachtwoord en een publieke URL: zonder rem kan iemand het raden,
 * en daarna op onze sleutels omzetten. Een wachttijd per poging remt niets,
 * want op Vercel landen parallelle pogingen op verschillende machines. Een
 * teller moet dus gedeeld zijn, en zonder database is dat de Vercel Firewall.
 *
 * Twee lagen, en ze tellen allebei elke poging, goed of fout, en vóór het
 * wachtwoord wordt nagekeken: anders krijgt wie raadt het antwoord alsnog.
 *
 * 1. De Firewall-regel `inloggen`, per IP, gedeeld over alle machines. Die moet
 *    in het Vercel-dashboard bestaan (Firewall > New Rule > If `@vercel/firewall`,
 *    Rate limit ID `inloggen`, Fixed window 10 minuten, 10 verzoeken, sleutel IP,
 *    Then Default 429). Ontbreekt hij, dan staat dat elke keer in de log.
 * 2. Een teller in het geheugen van deze ene machine. Houdt op Vercel een
 *    verdeelde aanval niet tegen, maar wel alles wat op één machine landt, en is
 *    de enige rem lokaal of als de Firewall-regel ontbreekt.
 *
 * Een redacteur logt eens per dertig dagen in; tien pogingen in tien minuten
 * merkt niemand die zich vertypt.
 */

export const LOGIN_RULE = 'inloggen';
const WINDOW_MS = 10 * 60 * 1000;
const MAX_TRIES = 10;

export type LoginGate = { allowed: true } | { allowed: false; retryAfter: number };

const tries = new Map<string, number[]>();

export async function loginGate(request: Request, now = Date.now()): Promise<LoginGate> {
  const shared = await firewall(request);
  const local = count(clientOf(request), now);
  if (!shared.allowed) return shared;
  return local;
}

async function firewall(request: Request): Promise<LoginGate> {
  // Buiten Vercel doet de SDK niets behalve een waarschuwing in de log.
  if (!process.env.VERCEL) return { allowed: true };
  try {
    const { rateLimited, error } = await checkRateLimit(LOGIN_RULE, { request });
    if (error === 'not-found') {
      console.error(
        `[inloggen] De Firewall-regel "${LOGIN_RULE}" bestaat niet. Inloggen wordt nu alleen per machine afgeremd. ` +
          `Maak hem aan: Firewall > New Rule > If @vercel/firewall, Rate limit ID "${LOGIN_RULE}", 10 verzoeken per 10 minuten per IP.`
      );
      return { allowed: true };
    }
    if (rateLimited || error === 'blocked') return { allowed: false, retryAfter: WINDOW_MS / 1000 };
    return { allowed: true };
  } catch (err) {
    // Liever de teller van deze machine dan iedereen buitensluiten omdat de
    // Firewall even niet antwoordt.
    console.error('[inloggen] De Firewall gaf geen antwoord:', err instanceof Error ? err.message : err);
    return { allowed: true };
  }
}

function count(client: string, now: number): LoginGate {
  // Oude pogingen eerst weg, van iedereen, zodat de lijst niet blijft groeien.
  for (const [key, times] of tries) {
    const recent = times.filter((t) => now - t < WINDOW_MS);
    if (recent.length) tries.set(key, recent);
    else tries.delete(key);
  }
  const recent = [...(tries.get(client) ?? []), now];
  tries.set(client, recent);
  if (recent.length <= MAX_TRIES) return { allowed: true };
  return { allowed: false, retryAfter: Math.ceil((recent[0] + WINDOW_MS - now) / 1000) };
}

function clientOf(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || request.headers.get('x-real-ip') || 'lokaal';
}
