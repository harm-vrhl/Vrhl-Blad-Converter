"use client";

import { cn } from "cn";
import { ChevronRight, Columns2, ListChecks, Loader2, TriangleAlert } from "lucide-react";
import { money, pageLabel } from "@/components/magazine/labels";
import type { ArticleProgress } from "@/components/magazine/useMagazine";
import { Button } from "@/components/ui/button";
import type { MapArticle } from "@/lib/magazine/types";

/**
 * Eén regel per artikel: kiezen, waar het staat, of er iets na te kijken is, en hoe
 * ver het omzetten is. Wat er verder over te zeggen valt klapt uit.
 */
export function ArticleRow({
  article,
  checked,
  disabled,
  expanded,
  onExpand,
  progress,
  thumbOf,
  onToggle,
  onOpen,
}: {
  article: MapArticle;
  checked: boolean;
  disabled: boolean;
  expanded: boolean;
  onExpand: () => void;
  progress?: ArticleProgress;
  thumbOf: (pdf: number) => string | undefined;
  onToggle: () => void;
  onOpen: (jobId: string) => void;
}) {
  const first = thumbOf(article.pages[0]);
  return (
    <li className={cn(checked && "bg-black/[0.02]")}>
      <div className="flex items-center gap-3 px-3 py-2">
        <input
          type="checkbox"
          className="size-4 shrink-0 accent-foreground"
          checked={checked}
          disabled={disabled}
          onChange={onToggle}
          aria-label={`${article.title ?? "Artikel zonder kop"} selecteren`}
        />
        {first ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={first} alt="" className="h-9 w-auto shrink-0 rounded-[3px] bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.08)]" />
        ) : (
          <span className="h-9 w-6 shrink-0 rounded-[3px] bg-muted" />
        )}
        <button
          type="button"
          onClick={onExpand}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          title={article.about || undefined}
        >
          <ChevronRight
            className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")}
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{article.title ?? "(zonder kop)"}</span>
            <span className="block truncate text-xs tabular-nums text-muted-foreground">
              {article.rubric ? <span className="tracking-wide uppercase">{article.rubric} · </span> : null}
              {pageLabel(article)}
            </span>
          </span>
        </button>
        <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
          {!article.certain ? (
            <TriangleAlert className="size-3.5 text-[var(--destructive)]" aria-label="nakijken">
              <title>nakijken</title>
            </TriangleAlert>
          ) : null}
          {article.shared.length ? (
            <Columns2 className="size-3.5" aria-label="deelt een pagina">
              <title>deelt een pagina met een ander artikel</title>
            </Columns2>
          ) : null}
          {article.sources.includes("inhoudsopgave") ? (
            <ListChecks className="size-3.5" aria-label="in de inhoudsopgave">
              <title>staat in de inhoudsopgave</title>
            </ListChecks>
          ) : null}
        </span>
        {progress ? (
          <span className="flex shrink-0 justify-end">
            <ProgressCell progress={progress} onOpen={onOpen} />
          </span>
        ) : null}
      </div>
      {expanded ? (
        <div className="space-y-2 px-3 pb-3 pl-[4.75rem] text-xs text-muted-foreground">
          {article.about ? <p className="text-sm text-foreground/80">{article.about}</p> : null}
          <div className="flex flex-wrap gap-1">
            {article.pages.map((pdf) => {
              const src = thumbOf(pdf);
              return src ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={pdf}
                  src={src}
                  alt={`PDF-pagina ${pdf}`}
                  className={cn(
                    "h-20 w-auto rounded bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.08)]",
                    article.shared.includes(pdf) && "shadow-[0_0_0_2px_rgba(0,0,0,0.35)]",
                  )}
                />
              ) : null;
            })}
          </div>
          {article.notes.length ? (
            <ul className="space-y-1">
              {article.notes.map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
          ) : null}
          {progress?.error ? <p className="text-[var(--destructive)]">{progress.error}</p> : null}
        </div>
      ) : null}
    </li>
  );
}

function ProgressCell({ progress, onOpen }: { progress: ArticleProgress; onOpen: (jobId: string) => void }) {
  if (progress.state === "wacht") return <span className="text-xs text-muted-foreground">in de wachtrij</span>;
  if (progress.state === "uitlezen" || progress.state === "omzetten") {
    const label =
      progress.state === "uitlezen"
        ? progress.detail ?? "uitlezen"
        : `${progress.pages ?? 0}/${progress.pageCount ?? "?"} pagina's`;
    return (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
        <Loader2 className="size-3.5 animate-spin" />
        {label}
      </span>
    );
  }
  if (progress.state === "fout") {
    return (
      <span className="text-xs text-[var(--destructive)]" title={progress.error}>
        mislukt
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2">
      {progress.cost ? (
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {money(progress.cost, progress.currency ?? "USD")}
        </span>
      ) : null}
      {progress.jobId ? (
        <Button variant="outline" size="xs" onClick={() => onOpen(progress.jobId as string)}>
          Openen
        </Button>
      ) : null}
    </span>
  );
}

