import { linkify } from './links';
import { STYLE_ORDER, segments, type Segment } from './spans';
import type {
  ArticleDocument,
  ContentNode,
  Frontmatter,
  FrontmatterField,
  InlineStyle,
  ListItem,
  StyleSpan
} from './types';

/**
 * Vrhl-Blad MDX. The format is fixed by vrhl-blad.example.mdx and this file is
 * the only place that knows it:
 *
 *   - YAML holds the document settings; kicker, title and subtitle keep italics
 *     and nothing else. The intro is NOT a YAML key, it opens the body.
 *   - Headings in the body are always ###. No # and no ##.
 *   - A quote and a streamer are both a blockquote in curly quotes.
 *   - Images are <Image />, never ![](); a box is one <Frame> with a tint.
 *   - Strikethrough and code are not part of the format, so that text goes flat.
 *
 * Fields the print source cannot know - edition, tags, seo, video, pdf - are
 * left out rather than guessed, which is what the format asks for.
 */

/** A box without a printed tint still needs one: the reader's own light tag. */
const FRAME_FALLBACK = '#EBE8E4';
const MAX_SLUG = 80;

export function toMdx(doc: ArticleDocument): string {
  const body = [intro(doc.frontmatter), ...doc.content.map((node) => block(node))].filter(Boolean).join('\n\n');
  return `${head(doc)}\n\n${body}\n`;
}

// ─── YAML ────────────────────────────────────────────────────────────────────

function head(doc: ArticleDocument): string {
  const fm = doc.frontmatter;
  const lines = [
    '---',
    'type: single',
    key('slug', fm.title ? slug(fm.title) : null),
    key('date', fm.date),
    key('kicker', italics(fm, 'chapeau')),
    key('title', italics(fm, 'title')),
    key('subtitle', italics(fm, 'subtitle')),
    ...header(doc),
    ...names('authors', fm.authors),
    ...names('photographers', fm.photographers),
    ...names('illustrators', fm.illustrators),
    '---'
  ];
  return lines.filter((line): line is string => line !== null).join('\n');
}

function header(doc: ArticleDocument): Array<string | null> {
  if (!doc.header) return [];
  return [
    'header:',
    `  src: ${scalar(asset(doc.header.file, doc.header.alt))}`,
    doc.header.alt ? `  alt: ${scalar(oneLine(doc.header.alt))}` : null
  ];
}

function key(name: string, value: string | null): string | null {
  return value ? `${name}: ${scalar(oneLine(value))}` : null;
}

/** One name per line, the block form the reference uses for every credit list. */
function names(name: string, values: string[]): Array<string | null> {
  if (!values.length) return [];
  return [`${name}:`, ...values.map((value) => `  - ${scalar(oneLine(value))}`)];
}

/**
 * A YAML scalar. Bare where that is unambiguous, JSON-quoted as soon as the
 * value carries a :, #, quote or asterisk, or could be read as something other
 * than a string.
 */
function scalar(value: string): string {
  const risky =
    /[:#"'*]/.test(value) ||
    value !== value.trim() ||
    value === '' ||
    /^[-?[\]{}&!|>%@`,]/.test(value) ||
    /^(true|false|null|yes|no|on|off|~)$/i.test(value) ||
    /^[\d.+-]+$/.test(value);
  return risky ? JSON.stringify(value) : value;
}

function slug(title: string): string {
  return strip(title)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, MAX_SLUG)
    .replace(/-+$/, '');
}

// ─── Body ────────────────────────────────────────────────────────────────────

function intro(fm: Frontmatter): string | null {
  const text = italics(fm, 'intro');
  return text ? `<Intro>\n${text}\n</Intro>` : null;
}

function block(node: ContentNode): string {
  switch (node.type) {
    case 'paragraph':
      return inline(node.content, node.styles);
    case 'subheading':
      // Only ###, and the bold InDesign wraps a heading in comes off.
      return `### ${strip(node.content)}`;
    case 'quote':
    case 'streamer':
      return blockquote(node.content);
    case 'list':
      return node.items.map((item, i) => `${node.ordered ? `${i + 1}.` : '-'} ${listItem(item)}`).join('\n');
    case 'image':
      return image(node);
    case 'insert':
      return frame(node);
  }
}

/** A streamer and a pull quote are the same thing here: a quote in krulquotes. */
function blockquote(text: string): string {
  const bare = oneLine(text)
    .replace(/^[\s"'“”„«»‘’]+/, '')
    .replace(/[\s"'“”„«»‘’]+$/, '');
  return `> “${bare}”`;
}

function listItem(item: ListItem): string {
  return oneLine(inline(item.content, item.styles));
}

function image(node: Extract<ContentNode, { type: 'image' }>): string {
  if (!node.file) return '';
  const caption = [node.caption, node.credit].filter(Boolean).join(' · ') || null;
  const attributes = [
    `src="${attr(asset(node.file, caption))}"`,
    caption ? `alt="${attr(caption)}"` : null,
    caption ? `caption="${attr(caption)}"` : null,
    `grootte="${node.size}"`
  ].filter((line): line is string => line !== null);

  return `<Image\n${attributes.map((line) => `  ${line}`).join('\n')}\n/>`;
}

function frame(node: Extract<ContentNode, { type: 'insert' }>): string {
  const attributes = [
    `  achtergrond="${attr(node.background ?? FRAME_FALLBACK)}"`,
    node.ink ? `  tekst="${attr(node.ink)}"` : null
  ].filter((line): line is string => line !== null);

  const inner = [node.title ? `### ${strip(node.title)}` : null, ...node.content.map((child) => block(child))]
    .filter(Boolean)
    .join('\n\n');

  return `<Frame\n${attributes.join('\n')}\n>\n${inner}\n</Frame>`;
}

// ─── Inline ──────────────────────────────────────────────────────────────────

function inline(text: string, spans: StyleSpan[]): string {
  return wrap(segments(text, spans));
}

/**
 * A style that every part of the run shares wraps the whole run once, so an
 * italic sentence with a bold name in it is written the way a person would
 * write it - *… **Jan Jansen** …* - and not as three emphasis runs stitched
 * back together.
 */
function wrap(parts: Segment[]): string {
  if (!parts.length) return '';

  const common = STYLE_ORDER.filter((style) => parts.every((part) => part.style.includes(style)));
  if (common.length) {
    const inner = wrap(
      parts.map((part) => ({ text: part.text, style: part.style.filter((style) => !common.includes(style)) }))
    );
    // An asterisk meeting an asterisk is ambiguous in markdown; where that would
    // happen the run is marked part by part instead, which always reads back.
    if (!inner.startsWith('*') && !inner.endsWith('*')) return mark(inner, common);
  }

  return parts.map((part) => mark(links(part.text), part.style)).join('');
}

/**
 * A printed address becomes a markdown link. The visible text stays exactly as
 * the page prints it; only the target is filled in.
 */
function links(text: string): string {
  return linkify(text)
    .map((piece) => {
      if (!piece.href) return piece.text;
      const label = piece.text.replace(/[[\]]/g, '\\$&');
      // A bracket in the target is only unambiguous inside <>, which every
      // markdown reader takes but not every one gets right bare.
      const target = /[()<>\s]/.test(piece.href) ? `<${piece.href}>` : piece.href;
      return `[${label}](${target})`;
    })
    .join('');
}

/**
 * The marks the format allows, and only those. Whitespace is kept outside the
 * markers, because *word * is not italic in markdown, it is an asterisk.
 */
function mark(text: string, style: InlineStyle[]): string {
  if (!style.length) return text;
  const core = text.trim();
  if (!core) return text;

  const at = text.indexOf(core);
  const lead = text.slice(0, at);
  const tail = text.slice(at + core.length);

  let out = core;
  if (style.includes('underline')) out = `<u>${out}</u>`;
  const bold = style.includes('bold');
  const italic = style.includes('italic');
  if (bold && italic) out = `***${out}***`;
  else if (bold) out = `**${out}**`;
  else if (italic) out = `*${out}*`;

  return `${lead}${out}${tail}`;
}

/** Only the italics of a frontmatter field: title and kicker take no bold. */
function italics(fm: Frontmatter, field: FrontmatterField): string | null {
  const text = fm[field];
  if (!text) return null;
  const spans: StyleSpan[] = fm.italics
    .filter((entry) => entry.field === field)
    .map((entry) => ({ text: entry.text, style: ['italic'] }));
  return inline(text, spans);
}

// ─── Assets ──────────────────────────────────────────────────────────────────

/**
 * assets/{stem}-{8 hex}.{ext}. The hex is taken from the name the bitmap has in
 * the job, so the same image lands on the same path every time it is exported.
 */
function asset(file: string, label: string | null): string {
  const extension = /\.png$/i.test(file) ? 'png' : 'jpg';
  return `assets/${stem(label)}-${fingerprint(file)}.${extension}`;
}

function stem(label: string | null): string {
  const words = slug(label ?? '')
    .split('-')
    .filter(Boolean)
    .slice(0, 4)
    .join('-');
  return words || 'beeld';
}

function fingerprint(file: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < file.length; i++) {
    hash ^= file.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').slice(0, 8);
}

// ─── Text ────────────────────────────────────────────────────────────────────

function attr(value: string): string {
  return oneLine(value).replace(/"/g, '&quot;');
}

function oneLine(value: string): string {
  return value.replace(/\s*\n\s*/g, ' ').trim();
}

/** Emphasis the layout put around a whole heading or title, taken back off. */
function strip(text: string): string {
  return oneLine(text).replace(/^\*{1,3}(.+?)\*{1,3}$/, '$1');
}
