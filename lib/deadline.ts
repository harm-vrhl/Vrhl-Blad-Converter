/**
 * Hoeveel tijd een stap op Vercel nog heeft.
 *
 * Vercel breekt een functie hard af zodra zijn `maxDuration` om is. Dan komt er
 * geen fout meer terug, alleen een afgebroken verbinding, en zijn de tokens van
 * de lopende aanroep wel betaald. Een modelaanroep mag 480 seconden duren en
 * wordt bij een time-out opnieuw geprobeerd; zonder deze deadline weet die
 * aanroep niet dat de route er na 800 seconden hoe dan ook mee ophoudt.
 *
 * Dus stopt een stap zelf, net vóór Vercel, met een melding die zegt wat er
 * gebeurde, en begint hij geen nieuwe poging die toch niet af kan.
 */

/** De header waarin een streamende route zijn tijdslimiet in seconden meestuurt. */
export const LIMIT_HEADER = 'x-vrhl-limiet';

/** Tijd die overblijft om het antwoord nog te versturen en netjes af te sluiten. */
const MARGIN_MS = 30_000;

/** Korter dan dit heeft een nieuwe modelaanroep geen zin: hij kost geld en wordt toch afgekapt. */
export const MIN_ATTEMPT_MS = 60_000;

export interface Deadline {
  /** Het `maxDuration` van de route, in seconden. */
  limit: number;
  /** Wanneer het verzoek begon, in ms. */
  started: number;
  /** Het laatste moment waarop de stap nog zelf kan stoppen, in ms. */
  at: number;
}

export function deadlineFor(limit: number, now = Date.now()): Deadline {
  return { limit, started: now, at: now + limit * 1000 - MARGIN_MS };
}

/** Hoeveel ms er nog over is voor werk, nooit negatief. */
export function timeLeft(deadline: Deadline, now = Date.now()): number {
  return Math.max(0, deadline.at - now);
}

/**
 * De tijd is op. `geen-poging`: er was te weinig tijd voor een nieuwe poging.
 * `afgekapt`: een lopende aanroep is gestopt voordat Vercel hem afbrak.
 */
export class TimeUp extends Error {
  constructor(
    readonly deadline: Deadline,
    readonly kind: 'geen-poging' | 'afgekapt',
    now = Date.now()
  ) {
    const seconds = Math.round((now - deadline.started) / 1000);
    const wat =
      kind === 'afgekapt'
        ? `het model was na ${seconds} seconden nog niet klaar, dus is de aanroep gestopt voordat Vercel hem afbrak`
        : `na ${seconds} seconden was er te weinig tijd over voor een nieuwe poging, dus is die niet meer gestart`;
    super(
      `Tijd op: Vercel geeft deze stap hooguit ${deadline.limit} seconden, en ${wat}. ` +
        'Probeer het opnieuw; lukt het weer niet, kies dan de andere aanbieder.'
    );
    this.name = 'TimeUp';
  }
}
