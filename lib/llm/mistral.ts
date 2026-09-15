import { env } from '../env';
import { closed, observe, slot } from './ratelimit';
import type { OcrBlock, OcrBlockType, OcrPage } from '../types';

const RETRIES = 5;
const BACKOFF = 700; // ms, doubled each time

const KINDS: OcrBlockType[] = ['header', 'footer', 'title', 'text', 'list', 'image', 'caption', 'table'];

interface MistralBlock {
  top_left_x?: number;
  top_left_y?: number;
  bottom_right_x?: number;
  bottom_right_y?: number;
  content?: string;
  type?: string;
  image_id?: string | null;
}

/**
 * What Mistral has been asked to do so far, and what that comes to. It bills per
 * page it processes, and reading a page block by block turns one page into fifty,
 * so the count is kept where the calls are made rather than estimated afterwards.
 */
export interface OcrLedger {
  calls: number;
  pages: number;
  bytes: number;
}

export function newOcrLedger(): OcrLedger {
  return { calls: 0, pages: 0, bytes: 0 };
}

/** What the ledger has run up, in euro, at the configured page price. */
export function ocrCost(ledger: OcrLedger): number {
  return ledger.pages * env.ocrPricePerPage;
}

interface MistralOcrPage {
  index: number;
  markdown: string;
  blocks?: MistralBlock[];
  dimensions?: { dpi: number; width: number; height: number } | null;
}

/**
 * Eén pagina, als een PDF van die ene pagina of als een render ervan.
 *
 * Een heel magazine is 50 MB en een verzoek aan de server mag er 4,5 zijn, dus
 * gaat de PDF pagina voor pagina. Mistral rekent per pagina, dus dat kost niets
 * extra. Een render is de terugval voor een pagina die ook los te groot is, want
 * er staat een foto van 6 MB op.
 */
export async function ocrPage(page: number, data: Buffer, mime: string, ledger?: OcrLedger): Promise<OcrPage> {
  const document: Record<string, string> =
    mime === 'application/pdf'
      ? { type: 'document_url', document_url: `data:application/pdf;base64,${data.toString('base64')}` }
      : { type: 'image_url', image_url: `data:${mime || 'image/jpeg'};base64,${data.toString('base64')}` };
  const [read] = await ask(document, data.length, ledger);
  if (!read) throw new Error(`Mistral OCR gaf niets terug voor pagina ${page}`);
  return {
    page,
    markdown: (read.markdown ?? '').trim(),
    blocks: (read.blocks ?? []).map(readBlock),
    dimensions: read.dimensions ?? null
  };
}

/**
 * One image, read on its own. A crop of a page is not a page, so nothing about
 * its layout is kept - only the markdown, which is where the emphasis lives.
 */
export async function ocrImage(jpeg: Buffer, ledger?: OcrLedger): Promise<string> {
  const pages = await ask({ type: 'image_url', image_url: `data:image/jpeg;base64,${jpeg.toString('base64')}` }, jpeg.length, ledger);
  return (pages[0]?.markdown ?? '').trim();
}

async function ask(
  document: Record<string, string>,
  bytes: number,
  ledger?: OcrLedger
): Promise<MistralOcrPage[]> {
  if (!env.mistralKey) throw new Error('MISTRAL_API_KEY ontbreekt (zie .env.local)');

  // Reading a page block by block turns one call into fifty, and fifty calls in a
  // row is where the rate limit starts answering instead of the OCR. Backing off
  // and trying again is cheaper than losing the page.
  let text = '';
  let status = 0;
  const bucket = `ocr|${env.ocrModel}`;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    if (closed(bucket)) {
      throw new Error(
        `Mistral staat voor deze key op 0 OCR-requests per minuut voor ${env.ocrModel}. ` +
          `Zet een limiet aan op admin.mistral.ai/plateforme/limits.`
      );
    }
    await slot(bucket, env.mistralReqPerMinute);
    const res = await fetch(`${env.mistralBase}/ocr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.mistralKey}` },
      body: JSON.stringify({ model: env.ocrModel, document })
    });
    observe(bucket, res.headers);
    text = await res.text();
    status = res.status;
    if (res.ok) break;
    if (res.status !== 429 && res.status < 500) break;
    await new Promise((done) => setTimeout(done, BACKOFF * 2 ** attempt));
  }
  if (status < 200 || status >= 300) throw new Error(`Mistral OCR ${status}: ${text.slice(0, 400)}`);

  const body = JSON.parse(text) as { pages?: MistralOcrPage[]; usage_info?: { pages_processed?: number } };
  if (ledger) {
    ledger.calls++;
    // What Mistral says it processed, not what we think we sent: a crop still
    // counts as a page, and that is exactly the number being paid for.
    ledger.pages += body.usage_info?.pages_processed ?? body.pages?.length ?? 1;
    ledger.bytes += bytes;
  }
  return body.pages ?? [];
}

function readBlock(block: MistralBlock): OcrBlock {
  const kind = (block.type ?? '') as OcrBlockType;
  return {
    type: KINDS.includes(kind) ? kind : 'other',
    content: block.content ?? '',
    box: {
      x0: block.top_left_x ?? 0,
      y0: block.top_left_y ?? 0,
      x1: block.bottom_right_x ?? 0,
      y1: block.bottom_right_y ?? 0
    },
    imageId: block.image_id ?? null
  };
}
