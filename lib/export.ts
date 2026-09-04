import type { ArticleDocument, ContentNode, Frontmatter, FrontmatterField, StyleSpan } from './types';

/** One reading of the article object, to show it is a format-neutral source. */
export function toMarkdown(doc: ArticleDocument): string {
  const fm = doc.frontmatter;
  const head = [
    '---',
    yaml('chapeau', styledField(fm, 'chapeau')),
    yaml('title', styledField(fm, 'title')),
    yaml('subtitle', styledField(fm, 'subtitle')),
    list('authors', fm.authors),
    list('photographers', fm.photographers),
    list('illustrators', fm.illustrators),
    yaml('date', fm.date),
    yaml('intro', styledField(fm, 'intro')),
    '---',
    ''
  ]
    .filter((line) => line !== null)
    .join('\n');

  return `${head}\n${doc.content.map((node) => block(node, 0)).join('\n\n')}\n`;
}

/** A frontmatter field with its italic fragments (if any) laid back over the text. */
function styledField(fm: Frontmatter, field: FrontmatterField): string | null {
  const text = fm[field];
  if (!text) return null;
  const spans: StyleSpan[] = fm.italics.filter((i) => i.field === field).map((i) => ({ text: i.text, style: ['italic'] }));
  return applyStyles(text, spans);
}

function block(node: ContentNode, depth: number): string {
  switch (node.type) {
    case 'paragraph':
      return applyStyles(node.content, node.styles);
    case 'subheading':
      return `${'#'.repeat(Math.min(6, depth + 2))} ${node.content}`;
    case 'quote':
      return `> ${node.content}`;
    case 'streamer':
      return `**${node.content}**`;
    case 'image':
      return `![${node.caption ?? ''}](${node.file ?? node.id})${node.credit ? `\n*${node.credit}*` : ''}`;
    case 'insert':
      return [
        `<Insert type="${node.kind}"${node.title ? ` title="${node.title.replace(/"/g, "'")}"` : ''}>`,
        ...node.content.map((child) => block(child, depth + 1)),
        '</Insert>'
      ].join('\n\n');
  }
}

function applyStyles(text: string, spans: StyleSpan[]): string {
  let out = text;
  for (const span of spans) {
    const marks = span.style.includes('bold') ? '**' : span.style.includes('italic') ? '*' : '';
    if (!marks || !out.includes(span.text)) continue;
    out = out.replace(span.text, `${marks}${span.text}${marks}`);
  }
  return out;
}

function yaml(key: string, value: string | null): string | null {
  return value ? `${key}: ${JSON.stringify(value)}` : null;
}

function list(key: string, values: string[]): string | null {
  return values.length ? `${key}: [${values.map((v) => JSON.stringify(v)).join(', ')}]` : null;
}
