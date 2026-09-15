/**
 * Het vangnet bij het verbouwen: rekent de deterministische stappen door op de
 * oude jobs en magazines in `.data/jobs/` en vergelijkt de uitkomst met een
 * vastgelegde hash. Kost geen tokens.
 *
 *   npm run golden            vergelijk met scripts/golden.json
 *   npm run golden -- --update  leg de huidige uitkomst vast
 *
 * In golden.json staan alleen hashes, geen artikeltekst. Bij een verschil wordt
 * de nieuwe uitkomst in `.data/golden-diff/` gezet, zodat je kunt zien wat er
 * anders is. De jobs zelf staan alleen op deze computer.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { toPackage } from '../lib/canonical';
import { compileArticle, frameTitlesAsHeadings } from '../lib/compile';
import { boxOnly, rescueBoxed } from '../lib/imagefilter';
import { stitch } from '../lib/magazine/stitch';
import { toMdx } from '../lib/mdx';
import type { ExtractedImage, Frontmatter, ImageVerdict, PageResult } from '../lib/types';

const ROOT = path.resolve(import.meta.dirname, '..');
const JOBS = path.join(ROOT, '.data/jobs');
const STORE = path.join(ROOT, 'scripts/golden.json');
const DIFF = path.join(ROOT, '.data/golden-diff');

type Outputs = Record<string, unknown>;

function read<T>(dir: string, name: string): T | null {
  const file = path.join(JOBS, dir, name);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : null;
}

/** Runs one step; a step that throws is an outcome too, and must stay the same. */
function attempt(fn: () => unknown): unknown {
  try {
    return fn();
  } catch (err) {
    return { threw: err instanceof Error ? err.message : String(err) };
  }
}

function article(dir: string): Outputs | null {
  const pages = read<PageResult[]>(dir, 'pages.json');
  const stored = read<{ frontmatter: Frontmatter; source: { file: string; pages: number[] } }>(dir, 'article.json');
  if (!pages || !stored) return null;
  const media = read<{ images: ExtractedImage[]; verdicts: ImageVerdict[] }>(dir, 'images.json');
  const images = media?.images ?? [];
  const verdicts = media?.verdicts ?? [];
  const rejected = new Set(verdicts.filter((v) => !v.keep).map((v) => v.id));
  const approved = images.filter((image) => !rejected.has(image.id));

  const out: Outputs = {};
  out.boxOnly = attempt(() => boxOnly(images, verdicts).map((i) => i.id));
  out.rescueBoxed = attempt(() => rescueBoxed(verdicts, pages));
  const compiled = attempt(() => compileArticle(stored.frontmatter, pages, stored.source, approved));
  out.compile = compiled;
  const doc = (compiled as { document?: Parameters<typeof frameTitlesAsHeadings>[0] }).document;
  if (doc) {
    const framed = attempt(() => frameTitlesAsHeadings(doc)) as typeof doc;
    out.frameTitles = framed;
    const pakket = attempt(() => toPackage(framed, { images, pages, generatedAt: '2000-01-01T00:00:00.000Z' }));
    out.package = pakket;
    out.mdx = attempt(() => toMdx(pakket as Parameters<typeof toMdx>[0]));
  }
  return out;
}

function magazine(dir: string): Outputs | null {
  const scans = read<Parameters<typeof stitch>[0]>(dir, 'scans.json');
  const mag = read<{ pages: Parameters<typeof stitch>[1] }>(dir, 'magazine.json');
  if (!scans || !mag) return null;
  return { stitch: attempt(() => stitch(scans, mag.pages)) };
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex').slice(0, 16);
}

const update = process.argv.includes('--update');
const current: Record<string, string> = {};
const values: Record<string, unknown> = {};

for (const dir of readdirSync(JOBS).sort()) {
  for (const [kind, outputs] of [['artikel', article(dir)], ['magazine', magazine(dir)]] as const) {
    if (!outputs) continue;
    for (const [step, value] of Object.entries(outputs)) {
      const key = `${dir}/${kind}/${step}`;
      current[key] = hash(value);
      values[key] = value;
    }
  }
}

if (update) {
  writeFileSync(STORE, JSON.stringify(current, null, 2) + '\n');
  console.log(`${Object.keys(current).length} uitkomsten vastgelegd in scripts/golden.json`);
  process.exit(0);
}

if (!existsSync(STORE)) {
  console.error('Nog niets vastgelegd. Draai eerst: npm run golden -- --update');
  process.exit(1);
}

const expected = JSON.parse(readFileSync(STORE, 'utf8')) as Record<string, string>;
const keys = [...new Set([...Object.keys(expected), ...Object.keys(current)])].sort();
const changed = keys.filter((key) => expected[key] !== current[key]);

if (!changed.length) {
  console.log(`golden: alle ${keys.length} uitkomsten gelijk`);
  process.exit(0);
}

mkdirSync(DIFF, { recursive: true });
for (const key of changed) {
  const why = !(key in expected) ? 'nieuw' : !(key in current) ? 'verdwenen' : 'anders';
  console.error(`  ${why}: ${key}`);
  if (key in current) writeFileSync(path.join(DIFF, key.replaceAll('/', '__') + '.json'), JSON.stringify(values[key], null, 2));
}
console.error(`golden: ${changed.length} van ${keys.length} uitkomsten wijken af (nieuwe uitkomst in .data/golden-diff/)`);
process.exit(1);
