import { occurrence, places } from "@/lib/spans";
import type { Block, BlockType, ContentNode, ExtractedImage, InlineStyle, Patch } from "@/lib/types";

/**
 * Begrijpelijke labels voor het controlevenster. De interne codes (p3-02,
 * img-3-01, bold+italic) blijven in de data; hier worden ze vertaald.
 */

const BLOK_SOORT: Record<BlockType, string> = {
  paragraph: "alinea",
  subheading: "tussenkop",
  quote: "citaat",
  streamer: "uitgelichte regel",
  image: "beeld",
  insert: "kader",
  list: "lijst",
};

const STIJL: Record<InlineStyle, string> = {
  bold: "vet",
  italic: "cursief",
  underline: "onderstreept",
};

const BEELD_SOORT: Record<string, string> = {
  photo: "Foto",
  illustration: "Illustratie",
  portrait: "Portret",
  chart: "Grafiek",
  logo: "Logo",
  ornament: "Versiering",
  rule: "Lijntje",
  advert: "Advertentie",
  other: "Overig",
};

/** p3-02 -> pagina 3, nummer 2. */
export function parsePlekId(id: string): { pagina: number; nummer: number } | null {
  const match = /^(?:p|img-|crop-)(\d+)-(\d+)$/i.exec(id.trim());
  if (!match) return null;
  return { pagina: Number(match[1]), nummer: Number(match[2]) };
}

export function blokLabel(block: Block): string {
  const soort = BLOK_SOORT[block.type] ?? "onderdeel";
  const nummer = parsePlekId(block.id)?.nummer;
  const wat = nummer ? `${soort} ${nummer}` : soort;
  return `${wat} op pagina ${block.page}`;
}

/** Een patch.target is het id van een blok, of iets wat we niet kennen. */
export function patchPlek(patch: Patch, page: number, blocks: Block[]): string {
  const block = blocks.find((b) => b.id === patch.target);
  if (block) return blokLabel(block);
  const plek = parsePlekId(patch.target);
  if (plek) {
    const soort = BLOK_SOORT[guessBlockType(patch.target, blocks)] ?? "tekstfragment";
    return `${soort} ${plek.nummer} op pagina ${plek.pagina}`;
  }
  return `Pagina ${page}`;
}

function guessBlockType(id: string, blocks: Block[]): BlockType {
  return blocks.find((b) => b.id === id)?.type ?? "paragraph";
}

export function blokZoek(block: Block | undefined): string {
  if (!block) return "";
  if (block.type === "list") return (block.items ?? []).join(" ");
  if (block.type === "image") return [block.caption, block.credit].filter(Boolean).join(" ");
  return block.text;
}

/**
 * De plek van een opmaakfragment, dezelfde telling als `segments`: de n-de keer
 * dat `find` als eigen woord in de alinea staat. Als twee pagina's tot één
 * alinea zijn geplakt, schuift `nth` mee over het voorstuk.
 */
export function plekVanOpmaak(
  block: Block | undefined,
  find: string,
  nth = 0,
  content: ContentNode[] = []
): { zoek: string; markeer: string; nth: number } {
  const markeer = find.trim();
  const blok = schoon(blokZoek(block));
  const alinea = kiesAlinea(content, blok, markeer);
  const tekst = alinea ?? blok;
  let keer = nth;
  if (alinea && blok && alinea !== blok) {
    const las = alinea.indexOf(blok);
    if (las > 0) keer += places(alinea.slice(0, las), markeer).length;
  }
  return { zoek: tekst || markeer, markeer, nth: keer };
}

function kiesAlinea(content: ContentNode[], blok: string, find: string): string | null {
  if (!content.length) return null;
  const delen = stijlDelen(content);
  if (blok) {
    const zelfde = delen.find((d) => d === blok);
    if (zelfde) return zelfde;
    const bevat = delen.find((d) => d.includes(blok));
    if (bevat) return bevat;
    const inBlok = delen.find((d) => blok.includes(d) && d.includes(find));
    if (inBlok) return inBlok;
  }
  return delen.find((d) => occurrence(d, find) >= 0) ?? null;
}

function stijlDelen(nodes: ContentNode[]): string[] {
  const uit: string[] = [];
  const loop = (node: ContentNode) => {
    if (node.type === "paragraph") uit.push(node.content);
    else if (node.type === "list") for (const item of node.items) uit.push(item.content);
    else if (node.type === "insert") node.content.forEach(loop);
  };
  nodes.forEach(loop);
  return uit;
}

function schoon(tekst: string): string {
  return tekst.replace(/…/g, " ").replace(/\s+/g, " ").trim();
}

export function stijlLabel(style: readonly string[]): string {
  const namen = style.map((s) => STIJL[s as InlineStyle] ?? s);
  if (namen.length <= 1) return namen[0] ?? "";
  return `${namen.slice(0, -1).join(", ")} en ${namen[namen.length - 1]}`;
}

export function opmaakTelling(n: number): string {
  if (n <= 0) return "geen opgemaakte tekstfragmenten";
  return n === 1 ? "1 opgemaakt tekstfragment" : `${n} opgemaakte tekstfragmenten`;
}

export function beeldLabel(image: ExtractedImage): string {
  const plek = parsePlekId(image.id);
  if (plek) return `Beeld ${plek.nummer} op pagina ${plek.pagina}`;
  return `Beeld op pagina ${image.page}`;
}

export function beeldMaat(image: ExtractedImage): string {
  if (image.areaPct >= 55) return "zeer groot";
  if (image.areaPct >= 25) return "groot";
  if (image.areaPct < 6) return "klein";
  return "normaal";
}

/**
 * De notitie uit `lib/pictures.ts` is intern (kind: reason, "regel, zonder het
 * model"). Dit is wat de klant leest.
 */
export function beeldToelichting(note: string): string {
  const regel = /^regel, zonder het model:\s*(.*)$/i.exec(note);
  if (regel) return `Automatisch weggelaten: ${regel[1]}`;
  if (note === "niet beoordeeld") return "Nog niet beoordeeld";
  const soort = /^(\w+):\s*(.*)$/.exec(note);
  if (soort && BEELD_SOORT[soort[1]]) return `${BEELD_SOORT[soort[1]]}: ${soort[2]}`;
  return note;
}
