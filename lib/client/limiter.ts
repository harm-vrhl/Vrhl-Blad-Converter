'use client';

import { sleep } from '../util';

export type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Hoeveel verzoeken er tegelijk lopen, en hoe snel ze na elkaar mogen starten.
 *
 * Vroeger hield de server dat bij, maar op Vercel is "de server" elke keer een
 * andere machine die van de rest niets weet. De browser is nu de enige die alle
 * verzoeken van een run ziet, dus houdt de browser het tempo. Mistral staat op
 * één start per seconde; OpenAI heeft alleen een maximum tegelijk.
 *
 * Een plek die vrijkomt gaat direct naar de volgende in de rij, zonder eerst
 * terug te gaan naar de pot: anders glipt er soms een nieuwe tussendoor en lopen
 * er ineens één te veel.
 */
export function limiter(concurrency: number, perMinute = 0): Limiter {
  let active = 0;
  const waiting: Array<() => void> = [];
  const gap = perMinute > 0 ? 60_000 / perMinute : 0;
  let next = 0;

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < Math.max(1, concurrency)) active++;
    else await new Promise<void>((turn) => waiting.push(turn));
    try {
      if (gap) {
        const now = Date.now();
        const at = Math.max(now, next);
        next = at + gap;
        if (at > now) await sleep(at - now);
      }
      return await task();
    } finally {
      const turn = waiting.shift();
      if (turn) turn();
      else active--;
    }
  };
}
