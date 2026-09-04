'use client';

import { Fragment, type ReactNode } from 'react';
import type { ArticleDocument, ContentNode, FrontmatterField, InlineStyle, StyleSpan } from '@/lib/types';

export function ArticleView({ doc, jobId }: { doc: ArticleDocument; jobId: string }) {
  const fm = doc.frontmatter;
  const credits: Array<[string, string[]]> = [
    ['Tekst', fm.authors],
    ['Foto', fm.photographers],
    ['Illustratie', fm.illustrators]
  ];
  const italicSpans = (field: FrontmatterField): StyleSpan[] =>
    fm.italics.filter((i) => i.field === field).map((i) => ({ text: i.text, style: ['italic'] as InlineStyle[] }));

  return (
    <article className="article">
      {fm.chapeau ? <p className="chapeau">{styled(fm.chapeau, italicSpans('chapeau'))}</p> : null}
      <h2>{fm.title ? styled(fm.title, italicSpans('title')) : 'Zonder titel'}</h2>
      {fm.subtitle ? <p className="subtitle">{styled(fm.subtitle, italicSpans('subtitle'))}</p> : null}

      {credits.some(([, names]) => names.length) || fm.date ? (
        <div className="byline">
          {credits
            .filter(([, names]) => names.length)
            .map(([role, names]) => (
              <span key={role}>
                {role}: {names.join(', ')}
              </span>
            ))}
          {fm.date ? <span>{fm.date}</span> : null}
        </div>
      ) : null}

      {fm.intro ? <p className="intro">{styled(fm.intro, italicSpans('intro'))}</p> : null}

      {doc.content.map((node, i) => (
        <Fragment key={i}>{renderNode(node, jobId, i)}</Fragment>
      ))}
    </article>
  );
}

function renderNode(node: ContentNode, jobId: string, key: number): ReactNode {
  switch (node.type) {
    case 'paragraph':
      return <p>{styled(node.content, node.styles)}</p>;
    case 'subheading':
      return <h3>{node.content}</h3>;
    case 'quote':
      return <blockquote>{node.content}</blockquote>;
    case 'streamer':
      return <p className="streamer">{node.content}</p>;
    case 'image':
      return (
        <figure>
          {node.file ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={`/api/jobs/${jobId}/artifact/${node.file}`} alt={node.caption ?? ''} />
          ) : (
            <div className="placeholder">{node.id}, geen bitmap uit de OCR</div>
          )}
          {node.caption || node.credit ? (
            <figcaption>
              {node.caption}
              {node.credit ? <span className="credit"> · {node.credit}</span> : null}
            </figcaption>
          ) : null}
        </figure>
      );
    case 'insert':
      return (
        <aside className="insert">
          <span className="label">Insert · {node.kind}</span>
          {node.title ? <h4>{node.title}</h4> : null}
          {node.content.map((child, i) => (
            <Fragment key={`${key}-${i}`}>{renderNode(child, jobId, i)}</Fragment>
          ))}
        </aside>
      );
  }
}

const TAGS: Record<InlineStyle, 'strong' | 'em' | 'u' | 's'> = {
  bold: 'strong',
  italic: 'em',
  underline: 'u',
  strikethrough: 's'
};

/** Lay the detected inline styling back over the paragraph, left to right. */
function styled(text: string, spans: StyleSpan[]): ReactNode {
  const hits = spans
    .map((span) => ({ span, at: text.indexOf(span.text) }))
    .filter((hit) => hit.at >= 0)
    .sort((a, b) => a.at - b.at);

  const out: ReactNode[] = [];
  let cursor = 0;
  hits.forEach((hit, i) => {
    if (hit.at < cursor) return; // overlapping spans: the first one wins
    if (hit.at > cursor) out.push(text.slice(cursor, hit.at));
    out.push(
      <Fragment key={i}>
        {hit.span.style.reduce<ReactNode>((child, style) => {
          const Tag = TAGS[style];
          return <Tag>{child}</Tag>;
        }, hit.span.text)}
      </Fragment>
    );
    cursor = hit.at + hit.span.text.length;
  });
  if (cursor < text.length) out.push(text.slice(cursor));
  return out.length ? out : text;
}
