import { env } from '../env';
import type { OcrPage } from '../types';

interface MistralOcrPage {
  index: number;
  markdown: string;
}

/**
 * The words that exist. One call for the whole PDF, results per page. Everything
 * downstream may reorder and classify these words; nothing may add to them, and
 * the word index built from this text is what proves it.
 * Images are not asked for here: they are ripped out of the PDF itself, at the
 * resolution the designer placed them.
 */
export async function ocrPdf(jobId: string, pdf: Buffer): Promise<OcrPage[]> {
  if (!env.mistralKey) throw new Error('MISTRAL_API_KEY ontbreekt (zie .env.local)');

  const res = await fetch(`${env.mistralBase}/ocr`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.mistralKey}` },
    body: JSON.stringify({
      model: env.ocrModel,
      document: { type: 'document_url', document_url: `data:application/pdf;base64,${pdf.toString('base64')}` }
    })
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`Mistral OCR ${res.status}: ${text.slice(0, 400)}`);

  const pages = (JSON.parse(text) as { pages?: MistralOcrPage[] }).pages ?? [];
  if (!pages.length) throw new Error('Mistral OCR gaf geen paginas terug');

  return pages
    .map((p) => ({ page: p.index + 1, markdown: (p.markdown ?? '').trim() }))
    .sort((a, b) => a.page - b.page);
}
