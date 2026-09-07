import { env } from '../env';
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
 * The words that exist. One call for the whole PDF, results per page. Everything
 * downstream may reorder and classify these words; nothing may add to them, and
 * the word index built from this text is what proves it.
 * Images are not asked for here: they are ripped out of the PDF itself, at the
 * resolution the designer placed them.
 *
 * The blocks are kept as well as the markdown. They carry a bounding box, a kind,
 * and content with the emphasis markers still on - the page's own typography,
 * read off the paper at its own resolution rather than off a downscaled image.
 */
export async function ocrPdf(jobId: string, pdf: Buffer, ledger?: OcrLedger): Promise<OcrPage[]> {
  const pages = await ask({ type: 'document_url', document_url: `data:application/pdf;base64,${pdf.toString('base64')}` }, pdf.length, ledger);
  if (!pages.length) throw new Error('Mistral OCR gaf geen paginas terug');

  return pages
    .map((p) => ({
      page: p.index + 1,
      markdown: (p.markdown ?? '').trim(),
      blocks: (p.blocks ?? []).map(readBlock),
      dimensions: p.dimensions ?? null
    }))
    .sort((a, b) => a.page - b.page);
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
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const res = await fetch(`${env.mistralBase}/ocr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.mistralKey}` },
      body: JSON.stringify({ model: env.ocrModel, document })
    });
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
