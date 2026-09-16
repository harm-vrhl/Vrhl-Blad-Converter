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
import { livePreview } from '../components/article/preview';
import { workflowSteps, type StatusLine } from '../components/article/steps';
import { pageLabel, pageRange, summarizeSkipped } from '../components/magazine/labels';
import { toPackage } from '../lib/canonical';
import { compileArticle, frameTitlesAsHeadings } from '../lib/compile';
import { controleer, oordeel } from '../lib/controle';
import { boxOnly, rescueBoxed } from '../lib/imagefilter';
import { stitch } from '../lib/magazine/stitch';
import { docxDelen } from '../lib/docx';
import { toHtml } from '../lib/html';
import { toMdx } from '../lib/mdx';
import { groupPictures, type Picture } from '../lib/pictures';
import type { StoredJob } from '../lib/client/db';
import type { ExtractedImage, Frontmatter, ImageVerdict, OcrPage, PageResult } from '../lib/types';

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
  // Welk beeld het artikel haalde en welk niet, zoals de Controle-tab het toont.
  out.pictures = attempt(() => {
    const groups = groupPictures(images, verdicts, pages);
    return Object.fromEntries(
      Object.entries(groups).map(([name, list]) => [name, list.map((p: Picture) => `${p.image.id}: ${p.note}`)])
    );
  });
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
    // HTML en Word, net als MDX uit het pakket. Het beeld is een pad of een leeg
    // bestand: wat telt is waar het staat en hoe het is ingepakt, niet de pixels.
    out.html = attempt(() => toHtml(pakket as Parameters<typeof toHtml>[0], (asset) => asset.bestand ?? null));
    // Wat de Controle-tab zou melden, en het oordeel. Geen tekst van het artikel,
    // alleen wat er gemeld wordt en hoe erg: dat is wat niet ongemerkt mag verschuiven.
    out.controle = attempt(() => {
      const bevindingen = controleer({
        document: framed,
        pages,
        ocr: read<OcrPage[]>(dir, 'ocr.json') ?? [],
        images,
        verdicts
      });
      return {
        oordeel: oordeel(bevindingen, new Set()),
        bevindingen: bevindingen.map((b) => [b.ernst, b.soort, b.pagina, b.id])
      };
    });
    out.docx = attempt(() =>
      Object.fromEntries(
        docxDelen(pakket as Parameters<typeof docxDelen>[0], () => ({ data: new Uint8Array(), mimeType: 'image/jpeg' }), new Date('2000-01-01T00:00:00Z'))
          .filter((deel) => !deel.path.startsWith('word/media/'))
          .map((deel) => [deel.path, new TextDecoder().decode(deel.data)])
      )
    );
  }

  // What the article screen derives while a run streams in: the steps in the
  // sidebar and the live preview. The status lines and the reading-order run's text are made up
  // here, the same for every job, so the only thing that varies is the job.
  const job = read<StoredJob>(dir, 'job.json');
  const boxed = boxOnly(images, verdicts);
  const byPage = Object.fromEntries(pages.map((p) => [p.page, p]));
  const [first, second, ...rest] = pages;
  out.steps = attempt(() => workflowSteps(STATUS(pages.map((p) => p.page)), first ? { [first.page]: first } : {}, job));
  out.previewDone = attempt(() =>
    livePreview({ current: null, frontmatter: stored.frontmatter, pageResults: pages, results: byPage, text: {}, patches: {}, fragments: {}, approved, boxed, job })
  );
  const text: Record<number, string> = {};
  for (const p of [second, ...rest].filter(Boolean)) text[p.page] = RAW(images.find((i) => i.page === p.page)?.id ?? 'img-p99-01');
  out.previewLive = attempt(() =>
    livePreview({
      current: null,
      frontmatter: null,
      pageResults: first ? [first] : [],
      results: first ? { [first.page]: first } : {},
      text,
      patches: second ? { [second.page]: second.patches } : {},
      fragments: {},
      approved,
      boxed,
      job
    })
  );
  return out;
}

function STATUS(pages: number[]): StatusLine[] {
  const lines: StatusLine[] = [
    { run: 'woordindex', state: 'start' },
    { run: 'woordindex', state: 'ok', detail: 'klaar' },
    { run: 'frontmatter', state: 'start' },
    { run: 'beeldbeoordeling', state: 'fail', detail: 'mislukt' }
  ];
  pages.forEach((page, i) => {
    lines.push({ run: 'leesvolgorde', page, state: 'start' });
    if (i % 3 === 1) lines.push({ run: 'opmaak', page, state: 'ok' });
    if (i % 3 === 2) lines.push({ run: 'opmaak uit de PDF', page, state: 'fail', detail: 'kapot' });
  });
  return lines;
}

function RAW(imageId: string): string {
  return [
    '[continues-from-previous: ja]',
    'loopt door vanaf de vorige pagina.',
    '',
    '## Een tussenkop',
    '> Een pull quote',
    '~ Een streamer',
    '- een lijstitem',
    `[image: ${imageId} | bijschrift | credit]`,
    '[insert: Een kader | #333333 | #F7F6F2]',
    'alinea van het kader',
    `[image: ${imageId} | in het kader | -]`,
    '[/insert]',
    '[continues-on-next: nee]'
  ].join('\n');
}

function magazine(dir: string): Outputs | null {
  const scans = read<Parameters<typeof stitch>[0]>(dir, 'scans.json');
  const mag = read<{ pages: Parameters<typeof stitch>[1] }>(dir, 'magazine.json');
  if (!scans || !mag) return null;
  const map = attempt(() => stitch(scans, mag.pages)) as ReturnType<typeof stitch>;
  return {
    stitch: map,
    labels: attempt(() => ({
      articles: map.articles.map((a) => [pageRange(a, true), pageRange(a, false), pageLabel(a)]),
      skipped: summarizeSkipped(map)
    }))
  };
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
