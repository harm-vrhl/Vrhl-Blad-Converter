"use client";

import type { ReactNode } from "react";
import { cn } from "cn";
import { Loader2 } from "lucide-react";
import { ArticleRow } from "@/components/magazine/ArticleRow";
import { summarizeSkipped } from "@/components/magazine/labels";
import { MagazineSidebar } from "@/components/magazine/MagazineSidebar";
import { MagazineStart } from "@/components/magazine/MagazineStart";
import { PageGrid } from "@/components/magazine/PageGrid";
import { RUNNING, useMagazine } from "@/components/magazine/useMagazine";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * Een volledig magazine: pagina voor pagina bekeken, tot een lijst artikelen
 * gemaakt, en daaruit kies je wat er omgezet wordt.
 *
 * Omzetten is de gewone artikel-run, maar op de achtergrond en een paar tegelijk:
 * je blijft op het overzicht en ziet per artikel hoe ver het is, en opent het pas
 * als je wilt. Het uitlezen van de PDF gebeurt in dit tabblad en is zwaar, dus dat
 * gaat één voor één; de verzoeken aan de server lopen naast elkaar.
 *
 * Alles staat in de opslag van deze browser: het magazine, zijn pagina's en de
 * PDF zelf, zodat artikelen er ook na een herlaadbeurt nog uit te knippen zijn.
 */
export function MagazineView({
  provider,
  modeSwitch,
  concurrency,
  onBusyChange,
  onOpen,
}: {
  provider: "openai" | "mistral";
  modeSwitch: ReactNode;
  /** How many articles run at the same time. */
  concurrency: number;
  onBusyChange?: (busy: boolean) => void;
  onOpen: (jobId: string) => void;
}) {

  const {
    phase,
    magazine,
    file,
    thumbs,
    rendered,
    scans,
    status,
    map,
    totals,
    selected,
    setSelected,
    notice,
    dragging,
    setDragging,
    cutting,
    progress,
    open,
    setOpen,
    converting,
    accept,
    analyze,
    convert,
    thumbOf,
    busy,
  } = useMagazine({ provider, concurrency, onBusyChange });

  if (!magazine && phase !== "scanning") {
    return <MagazineStart modeSwitch={modeSwitch} notice={notice} dragging={dragging} setDragging={setDragging} accept={accept} />;
  }

  const pageCount = magazine?.pageCount ?? rendered?.total ?? 0;
  const scanned = Object.values(scans);
  const lastOf = (run: string) => [...status].reverse().find((l) => l.run === run && l.page == null);
  const boundaryTotal = Number(/(\d+) overgang/.exec(lastOf("grenscontrole")?.detail ?? "")?.[1] ?? 0);
  const contentTotal = map?.questions?.length ?? 0;
  const chosenCount = map?.articles.filter((a) => selected.has(a.id)).length ?? 0;
  const states = Object.values(progress);
  const conversion = {
    total: states.length,
    done: states.filter((p) => p.state === "klaar").length,
    failed: states.filter((p) => p.state === "fout").length,
    running: states.filter((p) => p.state === "uitlezen" || p.state === "omzetten").length,
    cost: states.reduce((n, p) => n + (p.cost ?? 0), 0),
    currency: states.find((p) => p.currency)?.currency ?? "USD",
  };
  const unsure = map?.articles.filter((a) => !a.certain).length ?? 0;
  // Een analyse die is blijven steken heeft zijn bekeken pagina's nog staan; die
  // hoeven niet nog een keer langs het model.
  const canResume =
    phase !== "analyzing" && (magazine?.status === "running" || magazine?.status === "error");

  return (
    <div className="flex min-h-0 flex-1">
      <MagazineSidebar
        phase={phase}
        magazine={magazine}
        pageCount={pageCount}
        rendered={rendered}
        lastOf={lastOf}
        scanned={scanned}
        map={map}
        status={status}
        contentTotal={contentTotal}
        boundaryTotal={boundaryTotal}
        progress={progress}
        converting={converting}
        conversion={conversion}
        totals={totals}
      />

      <div className="min-w-0 flex-1 overflow-y-auto overscroll-contain px-6 pt-8 pb-24">
        {notice ? (
          <Alert variant="destructive" className="mb-6 max-w-2xl">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ) : null}

        <div className="mb-6 flex flex-wrap items-center gap-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{magazine?.filename ?? file?.name}</div>
            <div className="text-xs text-muted-foreground">
              {map
                ? `${map.articles.length} artikel(en)${unsure ? ` · ${unsure} nakijken` : ""}`
                : `${pageCount} pagina's`}
            </div>
          </div>
          <span className="flex-1" />
          {busy || converting ? null : modeSwitch}
          <Button variant="ghost" size="sm" asChild disabled={busy || converting}>
            <label htmlFor="magazine-upload" className={cn(busy || converting ? "pointer-events-none opacity-50" : "cursor-pointer")}>
              Ander magazine
            </label>
          </Button>
          {map && phase === "done" ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setSelected(chosenCount === map.articles.length ? new Set() : new Set(map.articles.map((a) => a.id)))
                }
              >
                {chosenCount === map.articles.length ? "Niets" : "Alles"}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy || converting} onClick={() => void analyze()}>
                Opnieuw analyseren
              </Button>
              <Button variant="brand" disabled={!chosenCount || cutting} onClick={() => void convert()}>
                {cutting ? (
                  <>
                    <Loader2 className="animate-spin" />
                    Uitknippen…
                  </>
                ) : (
                  `Omzetten${chosenCount ? ` (${chosenCount})` : ""}`
                )}
              </Button>
            </>
          ) : (
            <>
              {canResume ? (
                <Button
                  variant="outline"
                  disabled={busy || converting}
                  title="Wat al bekeken is, wordt niet opnieuw betaald"
                  onClick={() => void analyze(true)}
                >
                  Verder waar het stopte
                </Button>
              ) : null}
              <Button variant="brand" disabled={phase !== "ready" && phase !== "error"} onClick={() => void analyze()}>
                {phase === "analyzing" ? (
                  <>
                    <Loader2 className="animate-spin" />
                    Analyseren…
                  </>
                ) : (
                  "Analyseren"
                )}
              </Button>
            </>
          )}
        </div>
        <input
          id="magazine-upload"
          className="sr-only"
          type="file"
          accept=".pdf,application/pdf"
          disabled={busy || converting}
          onChange={(e) => {
            const picked = e.target.files?.[0];
            if (picked) void accept(picked);
            e.target.value = "";
          }}
        />

        {map?.articles.length ? (
          <ul className="divide-y divide-black/[0.06] overflow-hidden rounded-xl bg-white ring-1 ring-black/5">
            {map.articles.map((article) => (
              <ArticleRow
                key={article.id}
                article={article}
                checked={selected.has(article.id)}
                disabled={phase !== "done" || RUNNING.includes(progress[article.id]?.state ?? "klaar")}
                expanded={open.has(article.id)}
                onExpand={() =>
                  setOpen((prev) => {
                    const next = new Set(prev);
                    if (next.has(article.id)) next.delete(article.id);
                    else next.add(article.id);
                    return next;
                  })
                }
                progress={progress[article.id]}
                thumbOf={thumbOf}
                onToggle={() =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(article.id)) next.delete(article.id);
                    else next.add(article.id);
                    return next;
                  })
                }
                onOpen={onOpen}
              />
            ))}
          </ul>
        ) : map && phase === "done" ? (
          <p className="text-sm text-muted-foreground">Er zijn geen artikelen gevonden.</p>
        ) : (
          <PageGrid pageCount={pageCount} scans={scans} thumbs={thumbs} magazine={magazine} thumbOf={thumbOf} />
        )}

        {map?.skipped.length ? (
          <p className="mt-6 text-xs text-muted-foreground">
            Niet in een artikel: {summarizeSkipped(map)}.
          </p>
        ) : null}
      </div>
    </div>
  );
}

