'use client';

import type { RunUsage } from '../types';
import { getData, putData } from './db';

/** Een stap die maar één keer betaald hoeft te worden: bewaard, en bij hervatten gelezen. */
export type Once = <T extends { usage?: RunUsage }>(name: string, work: () => Promise<T>) => Promise<T>;

/**
 * Elke betaalde stap wordt bewaard zodra hij klaar is, onder `run/<naam>` bij
 * zijn eigenaar. Een analyse of een run die halverwege stopt (tabblad dicht,
 * netwerk weg, één 500 uit de lucht) kan daarna verder zonder het stuk dat al
 * gelukt was opnieuw te betalen.
 *
 * Alleen een geslaagde stap wordt bewaard: gooit `work` een fout, dan staat er
 * niets en probeert de volgende keer opnieuw.
 */
export function onceIn(owner: string, add: (usage: RunUsage | undefined) => void): Once {
  return async <T extends { usage?: RunUsage }>(name: string, work: () => Promise<T>): Promise<T> => {
    const cached = await getData<T>(owner, `run/${name}`);
    if (cached) {
      add(cached.usage);
      return cached;
    }
    const fresh = await work();
    await putData(owner, `run/${name}`, fresh);
    add(fresh.usage);
    return fresh;
  };
}
