'use client';

import type { PageResult, Patch } from '@/lib/types';
import type { StyleFragment } from '@/lib/agents/styling';

export interface PageStream {
  page: number;
  text: string;
  patches: Patch[];
  /** What run 2 read off the page, which usually lands before run 1 is finished. */
  fragments: StyleFragment[];
  result?: PageResult;
  running: string[];
}

/** What the model is writing, per page, while it writes it. */
export function Stream({ pages }: { pages: PageStream[] }) {
  if (!pages.length) return null;

  return (
    <div className="stream">
      {pages.map((page) => (
        <section className="pane" key={page.page}>
          <header>
            <span className="label">Pagina {page.page}</span>
            <span className="pulse">
              {page.result
                ? `${page.result.blocks.length} alinea's · ${Math.round(page.result.check.score * 100)}% dekking`
                : page.running.join(' · ') || 'wacht'}
            </span>
          </header>

          <pre className="pagetext">
            {marked(page.text, page.fragments)}
            {!page.result ? <span className="caret" /> : null}
          </pre>

          {settled(page).length ? (
            <ul className="patches">
              {settled(page).map((patch, i) => (
                <li key={i} data-dropped={page.result?.dropped.includes(i) ?? false}>
                  {describe(patch)}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}
    </div>
  );
}

/**
 * The text as it arrives, with run 2's marks already on it.
 *
 * Run 2 no longer waits for run 1, so by the time a paragraph has finished
 * streaming its typography is usually already known. Setting it here rather than
 * once the page is done means the reader watches the page appear the way it will
 * look, instead of watching plain text and then seeing it change under them.
 *
 * This is a preview and it says so by being simple: it marks every occurrence of
 * a fragment it can find, where the real placer picks the one occurrence that was
 * meant. The page's own result replaces it a moment later.
 */
function marked(text: string, fragments: StyleFragment[]): React.ReactNode {
  if (!text || !fragments.length) return text || ' ';

  // Longest first, so a fragment inside another one cannot cut it in half.
  const wanted = fragments
    .filter((f) => f.kind === 'text' && f.text.length > 1)
    .sort((a, b) => b.text.length - a.text.length);

  const style = new Array<Set<string> | undefined>(text.length);
  for (const fragment of wanted) {
    for (let at = text.indexOf(fragment.text); at >= 0; at = text.indexOf(fragment.text, at + 1)) {
      for (let i = at; i < at + fragment.text.length; i++) {
        const carried = (style[i] ??= new Set<string>());
        for (const mark of fragment.style) carried.add(mark);
      }
    }
  }

  const out: React.ReactNode[] = [];
  let start = 0;
  const key = (i: number) => [...(style[i] ?? [])].sort().join('+');
  for (let i = 1; i <= text.length; i++) {
    if (i < text.length && key(i) === key(start)) continue;
    out.push(wrap(text.slice(start, i), style[start], out.length));
    start = i;
  }
  return out;
}

function wrap(text: string, style: Set<string> | undefined, key: number): React.ReactNode {
  if (!style?.size) return text;
  let node: React.ReactNode = text;
  if (style.has('underline')) node = <u>{node}</u>;
  if (style.has('italic')) node = <em>{node}</em>;
  if (style.has('bold')) node = <strong>{node}</strong>;
  return <span key={key}>{node}</span>;
}

/**
 * While the page is running these arrive one at a time and are shown as they
 * come. Once it is finished the page's own list is the one to show: it is the
 * placed list, and only that one lines up with the indices the applier refused.
 */
function settled(page: PageStream): Patch[] {
  return page.result ? page.result.patches : page.patches;
}

function describe(patch: Patch): string {
  return `${patch.style.join('+')} · "${clip(patch.find)}" in ${patch.target}`;
}

function clip(text: string): string {
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}
