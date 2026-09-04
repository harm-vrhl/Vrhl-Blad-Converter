// pdf.js runs its parser in a web worker. Next will not bundle that file for us,
// so we copy it into public/ and load it from a stable URL.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

try {
  const entry = require.resolve('pdfjs-dist/package.json');
  const src = join(dirname(entry), 'build', 'pdf.worker.min.mjs');
  if (!existsSync(src)) throw new Error(`worker not found at ${src}`);
  mkdirSync(join(root, 'public'), { recursive: true });
  copyFileSync(src, join(root, 'public', 'pdf.worker.min.mjs'));
  console.log('copied pdf.worker.min.mjs -> public/');
} catch (err) {
  console.warn('[copy-pdf-worker] skipped:', err.message);
}
