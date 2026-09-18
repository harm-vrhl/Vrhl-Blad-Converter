import type { ImageVerdict } from '../types';

/**
 * Wat naast het canonieke pakket in een .blad-bestand zit: de paginascan en de
 * controlestukken. `pakket.json` blijft het artikel; dit is van ons, zodat je
 * later de pagina's nog kunt zien zonder de PDF opnieuw in te lezen.
 */

export const BLAD_VERSIE = '1.0';
export const BLAD_META = 'blad.json';
export const BLAD_PAGINAS = 'paginas';
export const BLAD_PAGES = 'controle/pages.json';
export const BLAD_OCR = 'controle/ocr.json';

export interface BladPagina {
  page: number;
  width: number;
  height: number;
  points?: { w: number; h: number };
  /** Bestandsnaam in `paginas/`, dezelfde als in de job. */
  image: string;
  thumb: string;
}

export interface BladMeta {
  blad: typeof BLAD_VERSIE;
  pages: BladPagina[];
  verdicts?: ImageVerdict[];
}

export function bladPaginaPad(name: string): string {
  return `${BLAD_PAGINAS}/${name.replace(/^.*\//, '')}`;
}

export function parseBladMeta(json: string): BladMeta | null {
  try {
    const raw = JSON.parse(json.replace(/^\uFEFF/, '')) as BladMeta;
    if (!raw || raw.blad !== BLAD_VERSIE || !Array.isArray(raw.pages)) return null;
    return raw;
  } catch {
    return null;
  }
}
