import type { ArticleDocument, ContentNode } from "@/lib/types";

/**
 * Zoeken in het artikel zoals het op het scherm staat, niet via een blok-id.
 * Blokken schuiven bij slepen; de tekst is wat de redacteur ziet.
 *
 * Geen React: `npm run golden` rekent dit mee, zodat de volgorde van de velden
 * en het vouwen van aanhalingstekens niet stiekem verschuiven.
 */

export interface ZoekHit {
  /** De hele veldtekst, zoals naarPlek een pin gebruikt. */
  zoek: string;
  /** Het stuk dat de zoekopdracht daar raakte, in de spelling van het artikel. */
  markeer: string;
  /** De n-de keer dat de zoekopdracht in dit veld staat, vanaf 0. */
  nth: number;
}

export function zoekInArtikel(doc: ArticleDocument | null | undefined, query: string): ZoekHit[] {
  const needle = query.trim();
  if (!doc || !needle) return [];
  const hits: ZoekHit[] = [];
  for (const tekst of velden(doc)) {
    const plek = plekken(tekst, needle);
    for (let nth = 0; nth < plek.length; nth++) {
      const start = plek[nth]!;
      hits.push({ zoek: tekst, markeer: tekst.slice(start, start + needle.length), nth });
    }
  }
  return hits;
}

/**
 * Alle stukken tekst in leesvolgorde, in dezelfde vorm als de Artikel-tab ze
 * toont: een quote krijgt zijn aanhalingstekens, een bijschrift z'n punt.
 */
export function velden(doc: ArticleDocument): string[] {
  const fm = doc.frontmatter;
  const out: string[] = [];
  if (fm.chapeau) out.push(fm.chapeau);
  if (fm.title) out.push(fm.title);
  if (fm.subtitle) out.push(fm.subtitle);
  if (fm.authors.length) out.push(fm.authors.join(", "));
  if (fm.photographers.length) out.push(fm.photographers.join(", "));
  if (fm.illustrators.length) out.push(fm.illustrators.join(", "));
  if (fm.date) out.push(fm.date);
  if (fm.intro) out.push(fm.intro);
  loop(doc.content, out);
  return out;
}

function loop(nodes: ContentNode[], out: string[]) {
  for (const node of nodes) {
    switch (node.type) {
      case "paragraph":
      case "subheading":
        if (node.content) out.push(node.content);
        break;
      case "quote":
      case "streamer":
        out.push(quoteOpScherm(node.content));
        break;
      case "list":
        for (const item of node.items) if (item.content) out.push(item.content);
        break;
      case "image": {
        const onderschrift = [node.caption, node.credit].filter(Boolean).join(" · ");
        if (onderschrift) out.push(onderschrift);
        break;
      }
      case "insert":
        loop(node.content, out);
        break;
    }
  }
}

/** Zoals ArticleView een quote zet: bestaande aanhalingstekens eraf, vaste eromheen. */
export function quoteOpScherm(tekst: string): string {
  return `“${tekst.replace(/^[\s"'“”„«»]+|[\s"'“”„«»]+$/g, "")}”`;
}

/**
 * Elke (niet-overlappende) plek waar `needle` in `hay` staat, zonder te kijken
 * naar hoofdletters of naar het soort aanhalingsteken. Geen woordgrens: ⌘F
 * in de browser zoekt ook midden in een woord.
 */
export function plekken(hay: string, needle: string): number[] {
  const n = vouw(needle.trim());
  if (!n) return [];
  const h = vouw(hay);
  const out: number[] = [];
  let at = 0;
  while (at <= h.length - n.length) {
    const found = h.indexOf(n, at);
    if (found < 0) break;
    out.push(found);
    at = found + n.length;
  }
  return out;
}

export function schoon(tekst: string): string {
  return tekst.replace(/…/g, " ").replace(/\s+/g, " ").trim();
}

export function vouw(tekst: string): string {
  return tekst
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[“”„]/g, '"');
}
