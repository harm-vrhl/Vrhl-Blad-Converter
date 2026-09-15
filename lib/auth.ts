/**
 * Eén gedeeld wachtwoord voor de hele app.
 *
 * Op Vercel is elke API-route een doorgeefluik naar OpenAI, Mistral en Sanity,
 * met de sleutels van de redactie. Wie de URL vindt, zet anders op onze kosten
 * om. Zonder `APP_PASSWORD` staat alles open: zo werkt de app lokaal zoals hij
 * altijd deed.
 *
 * Wat in de cookie staat is geen wachtwoord maar een handtekening: de vervaldatum,
 * ondertekend met `AUTH_SECRET` en het wachtwoord zelf. Een ander wachtwoord
 * instellen maakt daarmee elke uitgegeven cookie ongeldig.
 *
 * Alleen Web Crypto, geen `node:crypto`: de middleware draait op de edge.
 */

export const AUTH_COOKIE = 'vrhl_toegang';
/** Hoe lang een keer inloggen meegaat. */
export const AUTH_DAYS = 30;

export function authEnabled(): boolean {
  return Boolean(process.env.APP_PASSWORD);
}

async function sign(message: string): Promise<string> {
  const secret = `${process.env.AUTH_SECRET ?? ''}|${process.env.APP_PASSWORD ?? ''}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Vergelijken zonder dat de duur verraadt hoeveel tekens klopten. */
function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function checkPassword(given: string): Promise<boolean> {
  const expected = process.env.APP_PASSWORD ?? '';
  if (!expected) return false;
  // Beide kanten eerst door dezelfde handtekening, zodat ook de lengte niets zegt.
  return same(await sign(`wachtwoord:${given}`), await sign(`wachtwoord:${expected}`));
}

export async function issueToken(now = Date.now()): Promise<string> {
  const expires = now + AUTH_DAYS * 24 * 60 * 60 * 1000;
  return `${expires}.${await sign(`toegang:${expires}`)}`;
}

export async function validToken(token: string | undefined, now = Date.now()): Promise<boolean> {
  if (!token) return false;
  const [expires, mac] = token.split('.');
  if (!expires || !mac || !(Number(expires) > now)) return false;
  return same(mac, await sign(`toegang:${expires}`));
}
