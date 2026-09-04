'use client';

import type { PageResult, Patch } from '@/lib/types';

export interface PageStream {
  page: number;
  text: string;
  patches: Patch[];
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
            {page.text || ' '}
            {!page.result ? <span className="caret" /> : null}
          </pre>

          {page.patches.length ? (
            <ul className="patches">
              {page.patches.map((patch, i) => (
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

function describe(patch: Patch): string {
  return `${patch.style.join('+')} · "${clip(patch.find)}" in ${patch.target}`;
}

function clip(text: string): string {
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}
