'use client';

import { Fragment, type ReactNode } from 'react';
import { cn } from 'cn';
import { readerSans, readerSerif } from '@/app/reader-fonts';
import '@/app/reader.css';
import { BlockDragProvider, BlockList, useFrameDrop } from '@/components/BlockDrag';
import { StoredImage } from '@/components/StoredImage';
import { looksSame, readBack, spansFrom } from '@/lib/client/edit';
import { linkify } from '@/lib/links';
import { segments, STYLE_ORDER } from '@/lib/spans';
import type {
  ArticleDocument,
  ContentNode,
  FrontmatterField,
  Frontmatter,
  InlineStyle,
  StyleSpan
} from '@/lib/types';

/**
 * The article as the reader will print it, in Vrhl-Blad's own type and colour
 * (Vrhl-Blad-Artikel-Styling.html). What it shows is what the canonical package
 * carries and nothing more: a mark the format has no room for is not painted
 * here either, so the preview cannot promise something the export will drop.
 *
 * Met `onEdit` is het ook de bewerkplek. Elke tekst is dan aan te klikken en wat
 * iemand verandert komt als nieuw artikelobject terug; een blok leegmaken haalt
 * het weg. De vorm van het artikel verandert niet: geen blokken erbij, geen
 * beeld verplaatsen. Daarvoor is de PDF er.
 *
 * Wat wel kan: de volgorde. Elk blok heeft dan een greep om het te verslepen,
 * in de lopende tekst, binnen een kader, en een kader in of uit (`BlockDrag`).
 */
export function ArticleView({
  doc,
  jobId,
  onEdit
}: {
  doc: ArticleDocument;
  jobId: string;
  onEdit?: (doc: ArticleDocument) => void;
}) {
  const fm = doc.frontmatter;
  const setFm = onEdit && ((next: Frontmatter) => onEdit({ ...doc, frontmatter: next }));
  const heading = (
    <>
      {fm.chapeau ? <Field fm={fm} name="chapeau" as="p" className="reader-kicker" onEdit={setFm} /> : null}
      {fm.title || setFm ? (
        <Field fm={fm} name="title" as="h1" className="reader-title" onEdit={setFm} />
      ) : (
        <h1 className="reader-title">Zonder titel</h1>
      )}
      {fm.subtitle ? <Field fm={fm} name="subtitle" as="p" className="reader-subtitle" onEdit={setFm} /> : null}
    </>
  );

  return (
    <div className={cn('reader', readerSerif.variable, readerSans.variable)}>
      {doc.header ? (
        <div className="reader-hero">
          <StoredImage owner={jobId} name={doc.header.file} alt={doc.header.alt ?? ''} />
          <div className="reader-hero-wash" />
          <div className="reader-hero-text">{heading}</div>
        </div>
      ) : (
        <div className="reader-head">{heading}</div>
      )}

      <Credits fm={fm} onEdit={setFm} />

      <div className="article-content article-body">
        {fm.intro ? (
          <div className="article-intro">
            <Field fm={fm} name="intro" as="p" onEdit={setFm} />
          </div>
        ) : null}
        <BlockDragProvider content={doc.content} onChange={onEdit && ((content) => onEdit({ ...doc, content }))}>
          <BlockList
            box={null}
            nodes={doc.content}
            render={(node, i) =>
              renderNode(
                node,
                jobId,
                i,
                onEdit &&
                  ((next) =>
                    onEdit({
                      ...doc,
                      content: next
                        ? doc.content.map((old, j) => (j === i ? next : old))
                        : doc.content.filter((_, j) => j !== i)
                    })),
                true
              )
            }
          />
        </BlockDragProvider>
      </div>
    </div>
  );
}

const CREDIT_FIELDS = {
  tekst: 'authors',
  foto: 'photographers',
  illustratie: 'illustrators'
} as const;

/** Tekst, foto en illustratie, elk in hun eigen pill, zoals de lezerssite. */
function Credits({ fm, onEdit }: { fm: Frontmatter; onEdit?: (fm: Frontmatter) => void }) {
  const roles = (Object.keys(CREDIT_FIELDS) as Array<keyof typeof CREDIT_FIELDS>).filter(
    (role) => fm[CREDIT_FIELDS[role]].length
  );
  if (!roles.length && !fm.date) return null;

  return (
    <div className="reader-credits">
      {roles.map((role) => (
        <span className="pill" key={role}>
          {ICONS[role]}
          <Editable
            as="span"
            text={fm[CREDIT_FIELDS[role]].join(', ')}
            marks={[]}
            onCommit={
              onEdit &&
              ((names) =>
                onEdit({
                  ...fm,
                  [CREDIT_FIELDS[role]]: names
                    .split(',')
                    .map((name) => name.trim())
                    .filter(Boolean)
                }))
            }
          />
        </span>
      ))}
      {fm.date ? (
        <span className="pill">
          <Editable
            as="span"
            text={fm.date}
            marks={[]}
            onCommit={onEdit && ((date) => onEdit({ ...fm, date: date || null }))}
          />
        </span>
      ) : null}
    </div>
  );
}

/** Een blok vervangen, of met null weghalen. */
type Update = (node: ContentNode | null) => void;

/** `topLevel`: het blok staat in de hoofdtekst, op plek `key`; alleen dan is een kader een dropzone. */
function renderNode(node: ContentNode, owner: string, key: number, update?: Update, topLevel = false): ReactNode {
  switch (node.type) {
    case 'paragraph':
      return (
        <Editable
          as="p"
          text={node.content}
          spans={node.styles}
          marks={STYLE_ORDER}
          onCommit={update && ((content, styles) => update(content ? { ...node, content, styles } : null))}
        />
      );
    case 'subheading':
      return (
        <Editable
          as="h3"
          text={node.content}
          marks={[]}
          onCommit={update && ((content) => update(content ? { ...node, content } : null))}
        />
      );
    // A streamer is a quote in the reader; both are one blockquote.
    case 'quote':
    case 'streamer':
      return (
        <blockquote>
          {'“'}
          <Editable
            as="span"
            text={node.content.replace(/^[\s"'“”„«»]+|[\s"'“”„«»]+$/g, '')}
            marks={[]}
            onCommit={update && ((content) => update(content ? { ...node, content } : null))}
          />
          {'”'}
        </blockquote>
      );
    case 'list': {
      const items = node.items.map((item, i) => (
        <Editable
          key={i}
          as="li"
          text={item.content}
          spans={item.styles}
          marks={STYLE_ORDER}
          onCommit={
            update &&
            ((content, styles) => {
              const next = content
                ? node.items.map((old, j) => (j === i ? { content, styles } : old))
                : node.items.filter((_, j) => j !== i);
              update(next.length ? { ...node, items: next } : null);
            })
          }
        />
      ));
      return node.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
    }
    case 'image':
      return (
        <figure className={`figure-${node.size}`}>
          <div>
            {node.file ? (
              <StoredImage owner={owner} name={node.file} alt={node.caption ?? ''} />
            ) : (
              <div className="placeholder">{node.id}, geen bitmap uit de OCR</div>
            )}
            {node.caption || node.credit ? (
              <figcaption>
                {node.caption ? (
                  <Editable
                    as="span"
                    text={node.caption}
                    marks={[]}
                    onCommit={update && ((caption) => update({ ...node, caption: caption || null }))}
                  />
                ) : null}
                {node.caption && node.credit ? ' · ' : null}
                {node.credit ? (
                  <Editable
                    as="span"
                    text={node.credit}
                    marks={[]}
                    onCommit={update && ((credit) => update({ ...node, credit: credit || null }))}
                  />
                ) : null}
              </figcaption>
            ) : null}
          </div>
        </figure>
      );
    case 'insert':
      return <Frame node={node} owner={owner} box={topLevel ? key : null} update={update} />;
  }
}

/**
 * Een kader, met zijn eigen kleuren. In de hoofdtekst is het ook een dropzone: een
 * blok kan erin, en zijn eigen blokken kunnen eruit.
 */
function Frame({
  node,
  owner,
  box,
  update
}: {
  node: Extract<ContentNode, { type: 'insert' }>;
  owner: string;
  box: number | null;
  update?: Update;
}) {
  const drop = useFrameDrop(box);
  const children = (child: ContentNode, i: number) =>
    renderNode(
      child,
      owner,
      i,
      update &&
        ((next) =>
          update({
            ...node,
            content: next ? node.content.map((old, j) => (j === i ? next : old)) : node.content.filter((_, j) => j !== i)
          }))
    );

  return (
    <div
      {...drop}
      className="text-frame-block"
      style={
        {
          backgroundColor: node.background ?? '#EBE8E4',
          color: node.ink ?? undefined,
          '--frame-text-color': node.ink ?? undefined
        } as React.CSSProperties
      }
    >
      {box != null ? (
        <BlockList box={box} nodes={node.content} render={children} />
      ) : (
        node.content.map((child, i) => <Fragment key={i}>{children(child, i)}</Fragment>)
      )}
    </div>
  );
}

const NO_SPANS: StyleSpan[] = [];

const SHORTCUTS: Record<string, InlineStyle> = { b: 'bold', i: 'italic', u: 'underline' };

/**
 * Eén stuk tekst, en zonder `onCommit` gewoon wat er staat.
 *
 * Wat iemand typt blijft in de DOM tot het veld de focus verliest; pas dan wordt
 * het teruggelezen. Tussendoor opnieuw renderen zou React laten verzoenen met
 * een DOM die de browser al heeft omgegooid. Na het vastleggen krijgt het
 * element een nieuwe key en begint het schoon, met de tekst zoals het artikel
 * hem nu kent.
 *
 * `marks` zegt welke opmaak het veld mag dragen. Een kop is al vet en een quote
 * kent geen opmaak, dus daar doen ⌘B en ⌘I niets.
 */
function Editable({
  as: Tag,
  text,
  spans = NO_SPANS,
  marks,
  className,
  onCommit
}: {
  as: 'p' | 'h1' | 'h3' | 'li' | 'span';
  text: string;
  spans?: StyleSpan[];
  marks: readonly InlineStyle[];
  className?: string;
  onCommit?: (text: string, spans: StyleSpan[]) => void;
}) {
  if (!onCommit) return <Tag className={className}>{styled(text, spans)}</Tag>;

  return (
    <Tag
      key={`${text}|${JSON.stringify(spans)}`}
      className={className}
      contentEditable
      suppressContentEditableWarning
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'Escape') {
          e.preventDefault();
          e.currentTarget.blur();
          return;
        }
        const style = e.metaKey || e.ctrlKey ? SHORTCUTS[e.key.toLowerCase()] : undefined;
        if (style && !marks.includes(style)) e.preventDefault();
      }}
      onPaste={(e) => {
        // Geplakte opmaak van een website of uit Word hoort niet in het artikel.
        e.preventDefault();
        document.execCommand('insertText', false, e.clipboardData.getData('text/plain').replace(/\s+/g, ' '));
      }}
      onDrop={(e) => e.preventDefault()}
      onBlur={(e) => {
        const read = readBack(e.currentTarget);
        const next = { text: read.text, spans: spansFrom(read, marks) };
        if (!looksSame(next, { text, spans })) onCommit(next.text, next.spans);
      }}
    >
      {styled(text, spans)}
    </Tag>
  );
}

/** Only the marks the format has: strikethrough is not one of them. */
const TAGS: Partial<Record<InlineStyle, 'strong' | 'em' | 'u'>> = {
  bold: 'strong',
  italic: 'em',
  underline: 'u'
};

function styled(text: string, spans: StyleSpan[]): ReactNode {
  const parts = segments(text, spans);
  if (parts.length === 1 && !parts[0].style.length) return linked(text);

  return parts.map((segment, i) => (
    <Fragment key={i}>
      {segment.style.reduce<ReactNode>((child, style) => {
        const Tag = TAGS[style];
        return Tag ? <Tag>{child}</Tag> : child;
      }, linked(segment.text))}
    </Fragment>
  ));
}

/**
 * The addresses printed in this piece of text, as links the reader can follow.
 * Only http(s) ever comes out of `linkify`, so nothing here can carry a scheme
 * the browser should not open.
 */
function linked(text: string): ReactNode {
  const pieces = linkify(text);
  if (pieces.length === 1 && !pieces[0].href) return text;

  return pieces.map((piece, i) =>
    piece.href ? (
      <a key={i} href={piece.href} target="_blank" rel="noopener noreferrer">
        {piece.text}
      </a>
    ) : (
      <Fragment key={i}>{piece.text}</Fragment>
    )
  );
}

/** A frontmatter field with the italics run 1 found in it. */
function Field({
  fm,
  name,
  as,
  className,
  onEdit
}: {
  fm: Frontmatter;
  name: FrontmatterField;
  as: 'p' | 'h1';
  className?: string;
  onEdit?: (fm: Frontmatter) => void;
}) {
  const spans: StyleSpan[] = fm.italics
    .filter((entry) => entry.field === name)
    .map((entry) => ({ text: entry.text, style: ['italic'] }));
  return (
    <Editable
      as={as}
      className={className}
      text={fm[name] ?? ''}
      spans={spans}
      marks={['italic']}
      onCommit={
        onEdit &&
        ((text, next) =>
          onEdit({
            ...fm,
            [name]: text || null,
            italics: [
              ...fm.italics.filter((entry) => entry.field !== name),
              ...next.map((span) => ({ field: name, text: span.text }))
            ]
          }))
      }
    />
  );
}

/**
 * The credit icons of vrhl-blad.nl itself, taken from the files the site serves:
 * /icons/stylus_fountain_pen.svg, /icons/photo_camera.svg and /icons/palette.svg.
 * Their hardcoded fills (#333333 and #0F1729) are dropped so the mark takes the
 * colour of the pill it sits in, and the palette's 800x800 frame is dropped in
 * favour of its own 24x24 viewBox.
 */
const ICONS = {
  tekst: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8.26897 15.9814C8.06663 15.9814 7.88597 15.9224 7.72697 15.8042C7.56797 15.6859 7.46672 15.5294 7.42322 15.3347L5.45047 7.37995C5.40913 7.22661 5.4133 7.07428 5.46297 6.92294C5.51263 6.77178 5.59547 6.64653 5.71147 6.5472L11.4282 1.33044C11.5864 1.18111 11.7782 1.10645 12.0037 1.10645C12.2291 1.10645 12.4184 1.18111 12.5717 1.33044L18.2945 6.5472C18.4065 6.64653 18.4873 6.77178 18.537 6.92294C18.5866 7.07428 18.5908 7.22661 18.5495 7.37995L16.5825 15.3347C16.5388 15.5294 16.4367 15.6859 16.2762 15.8042C16.1157 15.9224 15.936 15.9814 15.737 15.9814H8.26897ZM8.92772 14.2722H15.0722L16.7902 7.46669L12.7917 3.86245V7.35119C13.0331 7.49019 13.2297 7.68036 13.3817 7.9217C13.5337 8.16286 13.6097 8.4287 13.6097 8.7192C13.6097 9.15553 13.4519 9.52795 13.1362 9.83645C12.8206 10.1451 12.44 10.2994 11.9945 10.2994C11.5488 10.2994 11.1701 10.1451 10.8582 9.83645C10.5462 9.52795 10.3902 9.15553 10.3902 8.7192C10.3902 8.4287 10.4682 8.16186 10.6242 7.91869C10.7802 7.67536 10.9788 7.4842 11.22 7.3452V3.85645L7.21572 7.46669L8.92772 14.2722ZM5.04497 21.1494C4.75047 21.1494 4.52538 21.0343 4.36972 20.8039C4.21422 20.5738 4.18605 20.3217 4.28522 20.0477L4.41147 19.6767C4.56213 19.2934 4.80155 18.9814 5.12972 18.7407C5.45788 18.5002 5.8273 18.3799 6.23797 18.3799H17.762C18.1685 18.3799 18.5358 18.5002 18.864 18.7407C19.1923 18.9814 19.4318 19.2934 19.5825 19.6767L19.7087 20.0477C19.8079 20.3217 19.7807 20.5738 19.6272 20.8039C19.4736 21.0343 19.2495 21.1494 18.955 21.1494H5.04497Z" />
    </svg>
  ),
  foto: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M11.9861 17.3607C13.2074 17.3607 14.2294 16.9499 15.0521 16.1282C15.8746 15.3066 16.2858 14.2861 16.2858 13.067C16.2858 11.8476 15.875 10.8298 15.0533 10.0135C14.2317 9.19731 13.2113 8.78923 11.9921 8.78923C10.7728 8.78923 9.75492 9.19673 8.93859 10.0117C8.12242 10.8267 7.71434 11.8431 7.71434 13.061C7.71434 14.2823 8.12184 15.3043 8.93684 16.127C9.75184 16.9495 10.7683 17.3607 11.9861 17.3607ZM11.9876 15.7412C11.2198 15.7412 10.5855 15.4867 10.0848 14.9777C9.58417 14.4687 9.33384 13.8303 9.33384 13.0625C9.33384 12.2946 9.58417 11.6594 10.0848 11.1567C10.5855 10.6541 11.2198 10.4027 11.9876 10.4027C12.7554 10.4027 13.3948 10.6541 13.9058 11.1567C14.4168 11.6594 14.6723 12.2946 14.6723 13.0625C14.6723 13.8303 14.4168 14.4687 13.9058 14.9777C13.3948 15.4867 12.7554 15.7412 11.9876 15.7412ZM3.55384 21.1495C3.09384 21.1495 2.695 20.9806 2.35734 20.6427C2.0195 20.3051 1.85059 19.9062 1.85059 19.4462V6.72873C1.85059 6.28373 2.0195 5.88765 2.35734 5.54048C2.695 5.19315 3.09384 5.01948 3.55384 5.01948H7.09734L8.47834 3.40548C8.63167 3.21015 8.81825 3.06782 9.03809 2.97848C9.25809 2.88915 9.49467 2.84448 9.74784 2.84448H14.2583C14.507 2.84448 14.7414 2.88915 14.9616 2.97848C15.1818 3.06782 15.3685 3.21015 15.5218 3.40548L16.9088 5.01948H20.4463C20.8913 5.01948 21.2874 5.19315 21.6346 5.54048C21.9819 5.88765 22.1556 6.28373 22.1556 6.72873V19.4462C22.1556 19.9062 21.9819 20.3051 21.6346 20.6427C21.2874 20.9806 20.8913 21.1495 20.4463 21.1495H3.55384ZM3.55384 19.4462H20.4463V6.72873H16.1371L14.2643 4.55373H9.74784L7.85109 6.72873H3.55384V19.4462Z" />
    </svg>
  ),
  illustratie: (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 10.5C8 11.3284 7.32843 12 6.5 12C5.67157 12 5 11.3284 5 10.5C5 9.67157 5.67157 9 6.5 9C7.32843 9 8 9.67157 8 10.5Z" />
      <path d="M10.5 8C11.3284 8 12 7.32843 12 6.5C12 5.67157 11.3284 5 10.5 5C9.67157 5 9 5.67157 9 6.5C9 7.32843 9.67157 8 10.5 8Z" />
      <path d="M17 6.5C17 7.32843 16.3284 8 15.5 8C14.6716 8 14 7.32843 14 6.5C14 5.67157 14.6716 5 15.5 5C16.3284 5 17 5.67157 17 6.5Z" />
      <path d="M7.5 17C8.32843 17 9 16.3284 9 15.5C9 14.6716 8.32843 14 7.5 14C6.67157 14 6 14.6716 6 15.5C6 16.3284 6.67157 17 7.5 17Z" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M1 12C1 5.92487 5.92487 1 12 1C17.9712 1 23 5.34921 23 11V11.0146C23 11.543 23.0001 12.4458 22.6825 13.4987C21.8502 16.2575 18.8203 16.9964 16.4948 16.4024C16.011 16.2788 15.5243 16.145 15.0568 16.0107C14.2512 15.7791 13.5177 16.4897 13.6661 17.2315L13.9837 18.8197L14.0983 19.5068C14.3953 21.289 13.0019 23.1015 11.0165 22.8498C7.65019 22.423 5.11981 21.1007 3.43595 19.1329C1.75722 17.171 1 14.6613 1 12ZM12 3C7.02944 3 3 7.02944 3 12C3 14.2854 3.64673 16.303 4.95555 17.8326C6.25924 19.3561 8.3 20.4894 11.2681 20.8657C11.7347 20.9249 12.2348 20.4915 12.1255 19.8356L12.0163 19.1803L11.7049 17.6237C11.2467 15.3325 13.4423 13.4657 15.6093 14.0885C16.0619 14.2186 16.529 14.3469 16.9897 14.4646C18.7757 14.9208 20.3744 14.2249 20.7677 12.921C20.997 12.161 21 11.5059 21 11C21 6.65079 17.0745 3 12 3Z"
      />
    </svg>
  )
} as const;
