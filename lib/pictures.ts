import { obviouslyDecorative } from './imagefilter';
import type { ExtractedImage, ImageVerdict, PageBlock, PageResult } from './types';

/**
 * Welk beeld uit de PDF het artikel haalde, en welk niet.
 *
 * Een beeld moet twee poortjes door. Eerst de beeldbeoordeling: is dit inhoud,
 * of een logo, een lijntje, een foto uit een advertentie. Daarna de
 * leesvolgorde-run, die het ergens tussen de alinea's moet zetten. Een beeld kan
 * het eerste poortje halen en het tweede niet, en dat is precies de stille
 * misser waar de Controle-tab voor is: niemand ziet een foto die nergens
 * geplaatst is, want er staat geen gat waar hij had moeten staan.
 *
 * Rekenen, geen React, zodat `npm run golden` het op de oude jobs kan narekenen.
 */

export interface Picture {
  image: ExtractedImage;
  /** Waarom dit beeld er wel of niet in zit, in gewone taal. */
  note: string;
}

export interface Pictures {
  /** Goedgekeurd en door de leesvolgorde-run neergezet. */
  inArticle: Picture[];
  /** Goedgekeurd, maar nergens in de tekst beland. */
  kept: Picture[];
  /** Weggezet door de regel of door de beeldbeoordeling. */
  dropped: Picture[];
  /** Stukken van een opgeknipt beeld: nooit los geplaatst, apart gehouden. */
  shards: Picture[];
}

export function groupPictures(images: ExtractedImage[], verdicts: ImageVerdict[], pages: PageResult[]): Pictures {
  const byId = new Map(verdicts.map((verdict) => [verdict.id, verdict]));
  const placed = placedRefs(pages);
  const of = (image: ExtractedImage): Picture => ({ image, note: noteFor(image, byId.get(image.id)) });

  const out: Pictures = { inArticle: [], kept: [], dropped: [], shards: [] };
  for (const image of images) {
    // Een beeld dat de regel wegzette, is de beoordeling nooit ingegaan, en een
    // oude job heeft daar geen verdict van bewaard. Zonder deze regel zou zo'n
    // lijntje van 0,1% van de pagina onder "goedgekeurd" staan.
    const byRule = Boolean(obviouslyDecorative(image));
    if (image.partOf) out.shards.push(of(image));
    else if (placed.has(image.id)) out.inArticle.push(of(image));
    else if (byRule || byId.get(image.id)?.keep === false) out.dropped.push(of(image));
    else out.kept.push(of(image));
  }
  return out;
}

function noteFor(image: ExtractedImage, verdict: ImageVerdict | undefined): string {
  // De goedkope helft van de beoordeling is een regel, geen model. Zo'n beeld
  // heeft het model nooit gezien, en dat hoort er anders te staan dan een
  // oordeel: bij een regel valt er niets te betwijfelen.
  const rule = obviouslyDecorative(image);
  if (rule) return `regel, zonder het model: ${rule}`;
  if (!verdict) return 'niet beoordeeld';
  return `${verdict.kind}: ${verdict.reason}`;
}

/** Welke beelden de leesvolgorde-run ergens neerzette, kaders meegerekend. */
function placedRefs(pages: PageResult[]): Set<string> {
  const refs = new Set<string>();
  const walk = (blocks: PageBlock[]) => {
    for (const block of blocks) {
      if (block.type === 'image' && block.ref) refs.add(block.ref);
      if (block.children) walk(block.children);
    }
  };
  for (const page of pages) walk(page.blocks);
  return refs;
}
