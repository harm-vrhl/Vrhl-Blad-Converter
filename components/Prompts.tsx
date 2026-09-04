'use client';

import { useEffect, useState } from 'react';
import type { PromptFile } from '@/lib/prompts';

/** Read-only view of prompts.json, so you can see what each run is actually told. */
export function Prompts() {
  const [file, setFile] = useState<PromptFile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/prompts')
      .then((res) => res.json())
      .then((body) => ('error' in body ? setError(body.error as string) : setFile(body as PromptFile)))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (error) return <p className="notice">{error}</p>;
  if (!file) return <p className="empty">Bezig met laden…</p>;

  return (
    <section className="prompts">
      <p className="empty">
        Deze teksten staan in <code>prompts.json</code> in de projectmap. Pas ze daar aan; de volgende run
        gebruikt de nieuwe versie, een herstart is niet nodig.
      </p>

      <article>
        <span className="label">Rules · gaat aan iedere run vooraf</span>
        <pre className="pagetext">{file.rules}</pre>
      </article>

      {Object.entries(file.runs).map(([key, run]) => (
        <article key={key}>
          <span className="label">
            {run.titel} · <code>{key}</code>
          </span>
          <dl className="kv">
            <dt>Wanneer</dt>
            <dd>{run.wanneer}</dd>
            <dt>Krijgt</dt>
            <dd>{run.krijgt}</dd>
            <dt>Levert</dt>
            <dd>{run.levert}</dd>
            <dt>Effort</dt>
            <dd>{run.effort ?? 'standaard uit .env.local'}</dd>
          </dl>
          <pre className="pagetext">{run.instructions}</pre>
        </article>
      ))}
    </section>
  );
}
