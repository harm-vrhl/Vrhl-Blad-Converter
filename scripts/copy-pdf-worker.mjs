// pdf.js runs its parser in a web worker. Next will not bundle that file for us,
// so we copy it into public/ and load it from a stable URL.
//
// Twee aanroepers, met een bewust verschil:
// - `npm install` (postinstall) waarschuwt alleen, zodat een halve installatie
//   niet vastloopt op iets wat de build straks toch nakijkt;
// - `next build` (via next.config.mjs) faalt. Zonder de worker slaagt de build
//   gewoon, maar leest in productie niemand nog een PDF in, en dat merk je pas als
//   de redactie het meldt.
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WORKER = join(root, 'public', 'pdf.worker.min.mjs');

/** Kopieert de worker naar public/ en gooit een fout als hij er daarna niet staat. */
export function copyPdfWorker() {
  const entry = require.resolve('pdfjs-dist/package.json');
  const src = join(dirname(entry), 'build', 'pdf.worker.min.mjs');
  if (!existsSync(src)) throw new Error(`de pdf.js-worker staat niet in pdfjs-dist (${src})`);
  mkdirSync(join(root, 'public'), { recursive: true });
  copyFileSync(src, WORKER);
  if (!existsSync(WORKER) || statSync(WORKER).size === 0) {
    throw new Error(`de pdf.js-worker is niet in public/ beland (${WORKER})`);
  }
  return WORKER;
}

// Direct aangeroepen, zoals door postinstall.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    copyPdfWorker();
    console.log('copied pdf.worker.min.mjs -> public/');
  } catch (err) {
    console.warn('[copy-pdf-worker] overgeslagen:', err.message);
  }
}
