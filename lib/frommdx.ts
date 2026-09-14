import type {
  ArticleDocument,
  ContentNode,
  ExtractedImage,
  Frontmatter,
  FrontmatterField,
  FrontmatterItalic,
  ImageSize,
  InlineStyle,
  ListItem,
  StyleSpan
} from './types';
import { places, STYLE_ORDER } from './spans';

/**
 * Vrhl-Blad MDX, read back.
 *
 * `toMdx` is the only place that knows how the format is written; this is the
 * only place that knows how to read it. They exist as a pair because the editor
 * hands back text: someone corrects a word in the MDX and the article beside it
 * has to change with it, and the only way to show that in the same renderer as
 * everything else is to turn the text back into a document.
 *
 * It is given the document it came from, and that is not a convenience. The MDX
 * writes an image as `assets/kop-1a2b3c4d.jpg`, a path derived from the bitmap's
 * name in the job; the job's own file name cannot be recovered from it. So the
 * original is kept beside the text and every image is matched back to the node it
 * was written from. What the editor may change about an image is its caption and
 * its size - the picture itself stays whatever it was.
 *
 * Anything the reader does not recognise becomes a paragraph rather than an
 * error. This is an editor: text that is halfway through being typed must not
 * blank the page.
 */

const SIZES: ImageSize[] = ['small', 'normal', 'large', 'xlarge'];
const ITALIC_FIELDS: FrontmatterField[] = ['chapeau', 'title', 'subtitle', 'intro'];

export function fromMdx(
  text: string,
  original: ArticleDocument,
  images: ExtractedImage[] = []
): ArticleDocument {
  const { head, body } = split(text);
  const yaml = readYaml(head);
  const known = imagesByPath(original, images);

  const italics: FrontmatterItalic[] = [];
  const field = (name: FrontmatterField, raw: string | null): string | null => {
    if (!raw) return null;
    const { content, styles } = inline(raw);
    for (const span of styles) {
      if (span.style.includes('italic')) italics.push({ field: name, text: span.text });
    }
    return content;
  };

  const blocks = readBlocks(body);
  const intro = blocks.find((b) => b.kind === 'intro');

  const frontmatter: Frontmatter = {
    chapeau: field('chapeau', yaml.one('kicker')),
    title: field('title', yaml.one('title')),
    subtitle: field('subtitle', yaml.one('subtitle')),
    authors: yaml.many('authors'),
    photographers: yaml.many('photographers'),
    illustrators: yaml.many('illustrators'),
    date: yaml.one('date'),
    intro: intro ? field('intro', intro.text) : null,
    italics
  };

  const content = blocks
    .filter((b) => b.kind !== 'intro')
    .map((b) => node(b, known))
    .filter((n): n is ContentNode => n !== null);

  return { source: original.source, frontmatter, header: original.header, content };
}

// ─── Opsplitsen ──────────────────────────────────────────────────────────────

function split(text: string): { head: string; body: string } {
  const trimmed = text.replace(/^﻿/, '');
  if (!trimmed.startsWith('---')) return { head: '', body: trimmed };
  const end = trimmed.indexOf('\n---', 3);
  if (end < 0) return { head: trimmed.slice(3), body: '' };
  return { head: trimmed.slice(3, end), body: trimmed.slice(trimmed.indexOf('\n', end + 1) + 1) };
}

interface Raw {
  kind: 'intro' | 'heading' | 'quote' | 'list' | 'image' | 'frame' | 'paragraph';
  text: string;
  lines: string[];
}

/**
 * The body, cut into blocks. A blank line ends a block, except inside the tags
 * that are allowed to hold blank lines of their own.
 */
function readBlocks(body: string): Raw[] {
  const lines = body.split('\n');
  const out: Raw[] = [];
  let held: string[] = [];
  let until: string | null = null;

  const flush = () => {
    const text = held.join('\n').trim();
    if (text) out.push(classify(text, held));
    held = [];
  };

  for (const line of lines) {
    if (until) {
      held.push(line);
      if (line.trim() === until) {
        until = null;
        flush();
      }
      continue;
    }
    const start = line.trim();
    if (start.startsWith('<Intro>')) until = '</Intro>';
    else if (start.startsWith('<Frame')) until = '</Frame>';
    else if (start.startsWith('<Image')) until = '/>';
    if (until) {
      // A tag that opens and closes on one line never enters the held state.
      held.push(line);
      if (start.endsWith(until) && start !== until) {
        until = null;
        flush();
      }
      continue;
    }
    if (!start) flush();
    else held.push(line);
  }
  flush();
  return out;
}

function classify(text: string, lines: string[]): Raw {
  const first = lines.find((l) => l.trim())?.trim() ?? '';
  if (first.startsWith('<Intro>')) return { kind: 'intro', text: strip(text, 'Intro'), lines };
  if (first.startsWith('<Frame')) return { kind: 'frame', text, lines };
  if (first.startsWith('<Image')) return { kind: 'image', text, lines };
  if (first.startsWith('###')) return { kind: 'heading', text: text.replace(/^\s*#{1,6}\s*/, ''), lines };
  if (first.startsWith('>')) return { kind: 'quote', text, lines };
  if (/^([-*+]|\d+\.)\s/.test(first)) return { kind: 'list', text, lines };
  return { kind: 'paragraph', text, lines };
}

function strip(text: string, tag: string): string {
  return text
    .replace(new RegExp(`^\\s*<${tag}>`), '')
    .replace(new RegExp(`</${tag}>\\s*$`), '')
    .trim();
}

// ─── Blokken ─────────────────────────────────────────────────────────────────

function node(raw: Raw, known: Map<string, Extract<ContentNode, { type: 'image' }>>): ContentNode | null {
  switch (raw.kind) {
    case 'heading':
      return { type: 'subheading', content: oneLine(plain(raw.text)) };
    case 'quote':
      return {
        type: 'quote',
        content: oneLine(plain(raw.text.replace(/^\s*>\s?/gm, ''))).replace(/^[“”"']+|[“”"']+$/g, '')
      };
    case 'list':
      return list(raw);
    case 'image':
      return image(raw, known);
    case 'frame':
      return frame(raw, known);
    default: {
      const { content, styles } = inline(raw.text);
      return { type: 'paragraph', content: oneLine(content), styles };
    }
  }
}

function list(raw: Raw): ContentNode {
  const ordered = /^\s*\d+\.\s/.test(raw.lines.find((l) => l.trim()) ?? '');
  const items: ListItem[] = [];
  for (const line of raw.lines) {
    const match = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.*)$/);
    if (match) {
      const { content, styles } = inline(match[1]);
      items.push({ content, styles });
    } else if (items.length && line.trim()) {
      // A wrapped continuation belongs to the item above it.
      items[items.length - 1].content += ` ${plain(line.trim())}`;
    }
  }
  return { type: 'list', ordered, items };
}

function image(raw: Raw, known: Map<string, Extract<ContentNode, { type: 'image' }>>): ContentNode | null {
  const src = attribute(raw.text, 'src');
  const was = src ? known.get(src) : undefined;
  const caption = attribute(raw.text, 'caption') ?? attribute(raw.text, 'alt');
  const size = attribute(raw.text, 'grootte');

  // A picture that is not one of the job's own cannot be shown, so it is dropped
  // rather than left as a hole the reader cannot explain.
  if (!was) return null;
  return {
    ...was,
    caption: caption ?? was.caption,
    credit: caption ? null : was.credit,
    size: SIZES.includes(size as ImageSize) ? (size as ImageSize) : was.size
  };
}

function frame(raw: Raw, known: Map<string, Extract<ContentNode, { type: 'image' }>>): ContentNode {
  const open = raw.text.indexOf('>');
  const body = raw.text.slice(open + 1).replace(/<\/Frame>\s*$/, '');
  const inner = readBlocks(body).map((b) => node(b, known)).filter((n): n is ContentNode => n !== null);

  // A box writes its own title as the first heading inside it.
  let title: string | null = null;
  if (inner[0]?.type === 'subheading') {
    title = inner[0].content;
    inner.shift();
  }
  return {
    type: 'insert',
    kind: 'box',
    title,
    background: attribute(raw.text, 'achtergrond'),
    ink: attribute(raw.text, 'tekst'),
    content: inner
  };
}

function attribute(text: string, name: string): string | null {
  const match = text.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? match[1].replace(/&quot;/g, '"') : null;
}

/**
 * Elk beeld onder elk pad waarop de MDX ernaar kan verwijzen.
 *
 * Sinds de MDX uit het canonieke pakket komt is dat `assets/<asset-id>.<ext>`,
 * en drie soorten pad leiden naar hetzelfde plaatje:
 *
 *   1. het asset-id van de geripte bitmap, `assets/img-1-01.jpeg`;
 *   2. de oorspronkelijke bestandsnaam, voor een job van voor het rippen, waar
 *      het pakket de naam zelf als pad gebruikt: `assets/crop-p01-01.jpeg`;
 *   3. het oude, uit het bijschrift afgeleide pad van voor de omschakeling.
 *
 * Alle drie staan erin, want een sleutel te weinig betekent niet een foutmelding
 * maar een artikel dat stilletjes zonder beeld terugkomt.
 */
function imagesByPath(
  doc: ArticleDocument,
  images: ExtractedImage[]
): Map<string, Extract<ContentNode, { type: 'image' }>> {
  const out = new Map<string, Extract<ContentNode, { type: 'image' }>>();
  const byFile = new Map(images.map((image) => [image.file, image]));

  const walk = (nodes: ContentNode[]) => {
    for (const n of nodes) {
      if (n.type === 'image' && n.file) {
        const image = byFile.get(n.file);
        if (image) {
          const extension = image.file.split('.').pop()?.toLowerCase() ?? 'jpg';
          out.set(`assets/${image.id}.${extension}`, n);
        }
        out.set(`assets/${n.file}`, n);
        out.set(legacyPathOf(n), n);
      } else if (n.type === 'insert') walk(n.content);
    }
  };
  walk(doc.content);
  return out;
}

/** Het pad dat `toMdx` afleidde voordat de MDX uit het pakket kwam. */
function legacyPathOf(node: Extract<ContentNode, { type: 'image' }>): string {
  const label = [node.caption, node.credit].filter(Boolean).join(' · ') || null;
  const extension = /\.png$/i.test(node.file ?? '') ? 'png' : 'jpg';
  const words =
    slug(label ?? '')
      .split('-')
      .filter(Boolean)
      .slice(0, 4)
      .join('-') || 'beeld';
  return `assets/${words}-${fingerprint(node.file ?? '')}.${extension}`;
}

function slug(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 80)
    .replace(/-+$/, '');
}

function fingerprint(file: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < file.length; i++) {
    hash ^= file.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, 8);
}

// ─── YAML ────────────────────────────────────────────────────────────────────

function readYaml(head: string) {
  const one = new Map<string, string>();
  const many = new Map<string, string[]>();
  let list: string[] | null = null;

  for (const line of head.split('\n')) {
    if (!line.trim()) continue;
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && list) {
      list.push(value(item[1]));
      continue;
    }
    if (/^\s/.test(line)) continue; // nested keys such as header.src
    const pair = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!pair) continue;
    if (pair[2] === '') {
      list = [];
      many.set(pair[1], list);
    } else {
      list = null;
      one.set(pair[1], value(pair[2]));
    }
  }

  return {
    one: (key: string) => one.get(key) ?? null,
    many: (key: string) => many.get(key) ?? []
  };
}

function value(raw: string): string {
  const text = raw.trim();
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text) as string;
    } catch {
      return text.replace(/^"|"$/g, '');
    }
  }
  return text;
}

// ─── Inline ──────────────────────────────────────────────────────────────────

/**
 * Markdown emphasis read back into text plus the runs that carry a mark.
 *
 * The marks are painted onto the characters they cover rather than matched as
 * pairs, so nesting comes out right: `*een **naam** erin*` is three runs, and the
 * middle one carries both. `nth` is counted afterwards over the finished text,
 * because that is what the renderer counts too.
 */
export function inline(source: string): { content: string; styles: StyleSpan[] } {
  const chars: string[] = [];
  const marks: InlineStyle[][] = [];
  const active = new Set<InlineStyle>();
  let i = 0;

  const push = (text: string) => {
    for (const ch of text) {
      chars.push(ch);
      marks.push(STYLE_ORDER.filter((style) => active.has(style)));
    }
  };

  while (i < source.length) {
    const rest = source.slice(i);

    // Een teken dat de schrijver heeft ontsnapt omdat het aan het begin van een
    // regel stond, hoort er als gewoon teken weer in. Anders draagt de tekst na
    // een rondgang door de editor een backslash die de pagina nooit had.
    if (rest.startsWith('\\') && /^[-–•+*>#.)[\]\\]/.test(rest.slice(1))) {
      push(source[i + 1]);
      i += 2;
      continue;
    }

    const link = rest.match(/^\[([^\]]*)\]\((?:<[^>]*>|[^)\s]*)\)/);
    if (link) {
      push(link[1].replace(/\\([[\]])/g, '$1'));
      i += link[0].length;
      continue;
    }
    if (rest.startsWith('<u>')) {
      active.add('underline');
      i += 3;
      continue;
    }
    if (rest.startsWith('</u>')) {
      active.delete('underline');
      i += 4;
      continue;
    }

    const run = rest.match(/^\*{1,3}/);
    if (run) {
      const width = run[0].length;
      const wanted: InlineStyle[] = width >= 3 ? ['bold', 'italic'] : width === 2 ? ['bold'] : ['italic'];
      // A marker only opens where the text after it is not a space, and only
      // closes what is actually open; a lone asterisk is just an asterisk.
      const closing = wanted.every((style) => active.has(style));
      const opening = !/^\s|^$/.test(rest.slice(width));
      if (closing) {
        for (const style of wanted) active.delete(style);
        i += width;
        continue;
      }
      if (opening && rest.slice(width).includes('*')) {
        for (const style of wanted) active.add(style);
        i += width;
        continue;
      }
    }

    push(source[i]);
    i += 1;
  }

  const content = chars.join('');
  const styles: StyleSpan[] = [];
  let start = 0;
  const key = (at: number) => marks[at]?.join('+') ?? '';

  for (let at = 1; at <= chars.length; at++) {
    if (at < chars.length && key(at) === key(start)) continue;
    const style = marks[start] ?? [];
    const text = content.slice(start, at);
    // Niet trimmen: de spatie tussen twee vette woorden hoort bij dezelfde vette
    // passage, en laat je hem eruit dan valt die passage in losse stukken uiteen
    // en schrijft toMdx **In** ***Modelverhalen*** waar **In *Modelverhalen*** hoort.
    if (style.length && text.trim()) {
      styles.push({ text, style: [...style], nth: Math.max(0, places(content, text).indexOf(start)) });
    }
    start = at;
  }
  return { content, styles };
}

function plain(source: string): string {
  return inline(source).content;
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}
