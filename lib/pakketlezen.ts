import type { Artikel, Asset, Blok, CanonicalStijl, Pakket, Tekst, Titel } from './canonical';

/**
 * Wat elke lezer van het pakket nodig heeft die er een document van maakt: de
 * stukken tekst met hun opmaak, de creditregel, het bijschrift van een beeld.
 *
 * HTML en Word delen dit, zodat ze een artikel op dezelfde manier lezen. MDX heeft
 * zijn eigen versie en blijft die houden: dat formaat ligt vast in
 * vrhl-blad.example.mdx en `npm run golden` bewaakt het tot op de letter.
 */

export interface Deel {
  tekst: string;
  stijlen: CanonicalStijl[];
  link?: string;
}

/** Het eerste artikel, en de assets op id. Een pakket uit deze converter heeft er één. */
export function eersteArtikel(pakket: Pakket): { artikel: Artikel; assets: Map<string, Asset> } | null {
  const artikel = pakket.artikelen?.[0];
  if (!artikel) return null;
  return { artikel, assets: new Map((pakket.assets ?? []).map((item) => [item.id, item])) };
}

export function delen(waarde: Tekst | Titel | undefined): Deel[] {
  if (!waarde) return [];
  if (typeof waarde === 'string') return waarde ? [{ tekst: waarde, stijlen: [] }] : [];
  return waarde
    .filter((deel) => deel.tekst)
    .map((deel) => ({
      tekst: deel.tekst,
      stijlen: [...(deel.stijlen ?? [])],
      link: 'link' in deel ? veiligeLink(deel.link) : undefined
    }));
}

export function kaal(waarde: Tekst | Titel | undefined): string {
  return delen(waarde)
    .map((deel) => deel.tekst)
    .join('');
}

/**
 * Alleen een adres dat een lezer veilig kan volgen. Deze converter levert altijd
 * http(s), maar het pakket is een uitwisselformaat en kan van elders komen: een
 * `javascript:` in een HTML-bestand of Word-document is een aanval, geen link.
 */
export function veiligeLink(href: string | undefined): string | undefined {
  if (!href) return undefined;
  return /^(https?:\/\/|mailto:)/i.test(href.trim()) ? href.trim() : undefined;
}

/** "Tekst: Anna de Vries en Jan Jansen · Foto: Piet Pieters", of niets. */
export function creditRegel(artikel: Artikel): string | null {
  const credits = artikel.credits;
  if (!credits) return null;
  const regel = [
    rij('Tekst', credits.auteurs),
    rij('Foto', credits.fotografen),
    rij('Illustratie', credits.illustratoren)
  ].filter(Boolean);
  return regel.length ? regel.join(' · ') : null;
}

function rij(label: string, namen: string[] | undefined): string | null {
  if (!namen?.length) return null;
  const lijst = namen.length === 1 ? namen[0] : `${namen.slice(0, -1).join(', ')} en ${namen[namen.length - 1]}`;
  return `${label}: ${lijst}`;
}

/**
 * Het bijschrift onder een beeld: eerst dat van het blok, dan dat van het asset.
 * Deze converter zet de gedrukte credit al in het onderschrift ("bijschrift ·
 * credit"); een credit die een andere producent apart op het asset zette, komt
 * erachter, maar niet twee keer.
 */
export function bijschrift(blok: Extract<Blok, { soort: 'afbeelding' }>, item: Asset | undefined): string | null {
  const tekst = blok.onderschrift ?? item?.onderschrift ?? '';
  const credit = item?.credit && !tekst.includes(item.credit) ? item.credit : '';
  return [tekst, credit].filter(Boolean).join(' · ') || null;
}

/** De alt-tekst: expliciet als die er is, anders het bijschrift. */
export function altTekst(blok: Extract<Blok, { soort: 'afbeelding' }>, item: Asset | undefined): string {
  return blok.alt ?? item?.alt ?? blok.onderschrift ?? item?.onderschrift ?? '';
}
