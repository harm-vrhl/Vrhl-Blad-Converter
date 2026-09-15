"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { cn } from "cn";
import {
  BookOpen,
  ChevronRight,
  CircleAlert,
  Columns2,
  FileSearch,
  Layers,
  ListChecks,
  Loader2,
  Sparkles,
  Split,
  TriangleAlert,
  UploadCloud,
  type LucideIcon,
} from "lucide-react";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from "@/components/ai-elements/chain-of-thought";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { streamRun, uploadArticle } from "@/lib/client/article";
import { analyzeMagazine } from "@/lib/client/analyze";
import { fileUrl, needFile, newId, putFile, saveMagazine } from "@/lib/client/db";
import { cutArticle, scanMagazine } from "@/lib/client/magazine";
import { pad2 } from "@/lib/util";
import type { RenderStep } from "@/lib/client/render";
import type { StoredJob } from "@/lib/client/db";
import type {
  Magazine,
  MagazineEvent,
  MagazinePage,
  MagazineMap,
  MapArticle,
  PageScan,
} from "@/lib/magazine/types";

type Phase = "idle" | "scanning" | "ready" | "analyzing" | "done" | "error";

interface ConvertItem {
  article: MapArticle;
  file: File;
}

/** Where one chosen article is on its way to being converted. */
interface ArticleProgress {
  state: "wacht" | "uitlezen" | "omzetten" | "klaar" | "fout";
  jobId?: string;
  /** What the browser is doing with it while it is being read. */
  detail?: string;
  pages?: number;
  pageCount?: number;
  cost?: number;
  currency?: string;
  error?: string;
}

const RUNNING: ArticleProgress["state"][] = ["wacht", "uitlezen", "omzetten"];

const STEP_LABEL: Record<RenderStep | "opslaan", string> = {
  renderen: "renderen",
  beelden: "beeld",
  lettertypen: "letters",
  opslaan: "opslaan",
};

/** A dense page's text layer runs to some thousands of characters; more is not text. */
const TEXT_LIMIT = 40_000;

interface StatusLine {
  run: string;
  page?: number;
  state: "start" | "ok" | "fail";
  detail?: string;
}

interface Totals {
  runs: number;
  tokens: number;
  ms: number;
  cost: { total: number; currency: string };
}

const KIND_LABEL: Record<string, string> = {
  omslag: "omslag",
  inhoudsopgave: "inhoudsopgave",
  artikel: "artikel",
  advertentie: "advertentie",
  colofon: "colofon",
  overig: "overig",
};

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
  const [phase, setPhase] = useState<Phase>("idle");
  const [magazine, setMagazine] = useState<Magazine | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [rendered, setRendered] = useState<{ page: number; total: number } | null>(null);
  const [scans, setScans] = useState<Record<number, PageScan>>({});
  const [status, setStatus] = useState<StatusLine[]>([]);
  const [map, setMap] = useState<MagazineMap | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [cutting, setCutting] = useState(false);
  const [progress, setProgress] = useState<Record<string, ArticleProgress>>({});
  const [open, setOpen] = useState<Set<string>>(new Set());
  const converting = Object.values(progress).some((p) => RUNNING.includes(p.state));

  useEffect(() => {
    onBusyChange?.(converting);
  }, [converting, onBusyChange]);

  const accept = useCallback(async (next: File) => {
    if (!next.name.toLowerCase().endsWith(".pdf")) {
      setNotice("Alleen PDF-bestanden.");
      return;
    }
    setPhase("scanning");
    setNotice(null);
    setMagazine(null);
    setFile(next);
    setThumbs([]);
    setScans({});
    setStatus([]);
    setMap(null);
    setTotals(null);
    setSelected(new Set());
    setRendered(null);

    try {
      let current: Magazine | null = null;
      await scanMagazine(next, async (page, total) => {
        setRendered({ page: page.pdf, total });
        if (!current) {
          current = {
            id: newId(),
            kind: "magazine",
            filename: next.name,
            pageCount: total,
            pages: [],
            createdAt: new Date().toISOString(),
            status: "uploading",
            error: null,
            map: null,
          };
          await putFile(current.id, "source.pdf", next);
          await saveMagazine(current);
        }
        const stored: MagazinePage = {
          pdf: page.pdf,
          width: page.width,
          height: page.height,
          image: await putFile(current.id, `page-${pad2(page.pdf)}.jpeg`, page.image),
          thumb: await putFile(current.id, `thumb-${pad2(page.pdf)}.jpeg`, page.thumb),
          text: page.text.slice(0, TEXT_LIMIT),
          label: page.label?.trim().slice(0, 40) || null,
        };
        current.pages = [...current.pages.filter((p) => p.pdf !== page.pdf), stored].sort((a, b) => a.pdf - b.pdf);
        current.status = current.pages.length >= current.pageCount ? "ready" : "uploading";
        await saveMagazine(current);
        setMagazine({ ...current });
        setThumbs((prev) => [...prev, page.previewUrl]);
      });
      setRendered(null);
      setPhase("ready");
    } catch (err) {
      setRendered(null);
      setNotice(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, []);

  const analyze = useCallback(async () => {
    if (!magazine) return;
    setPhase("analyzing");
    setNotice(null);
    setScans({});
    setStatus([]);
    setMap(null);
    setTotals(null);
    setSelected(new Set());

    let failed = false;
    try {
      for await (const event of analyzeMagazine(magazine.id, provider)) handle(event);
      if (!failed) setPhase((p) => (p === "analyzing" ? "done" : p));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }

    function handle(event: MagazineEvent) {
      switch (event.type) {
        case "status":
          setStatus((prev) => [...prev, event]);
          if (event.state === "fail" && event.page == null && event.run !== "paginascan") {
            failed = true;
            setNotice(event.detail ?? event.run);
            setPhase("error");
          }
          break;
        case "scan":
          setScans((prev) => ({ ...prev, [event.scan.pdf]: event.scan }));
          break;
        case "map":
          setMap(event.map);
          break;
        case "done":
          setMap(event.map);
          setTotals({ runs: event.runs, tokens: event.tokens, ms: event.ms, cost: event.cost });
          setPhase("done");
          break;
      }
    }
  }, [magazine, provider]);

  const runArticles = useCallback(
    async (items: ConvertItem[]) => {
      const update = (id: string, patch: Partial<ArticleProgress>) =>
        setProgress((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { state: "wacht" }), ...patch } }));
      setProgress((prev) => {
        const next = { ...prev };
        for (const { article } of items) next[article.id] = { state: "wacht" };
        return next;
      });

      const queue = [...items];
      // One upload at a time: every page is rendered and its bitmaps ripped in this
      // tab, and two of those side by side only make both slower.
      let reading: Promise<void> = Promise.resolve();

      const worker = async () => {
        for (let item = queue.shift(); item; item = queue.shift()) {
          const id = item.article.id;
          try {
            const before = reading;
            let release = () => {};
            reading = new Promise<void>((done) => (release = done));
            let job: StoredJob;
            try {
              await before;
              update(id, { state: "uitlezen", detail: "PDF openen" });
              job = await uploadArticle(item.file, {
                // The cut PDF starts at the article's first page, so its opening
                // is simply its first one or two pages.
                opening: item.article.opening.length || undefined,
                context: { title: item.article.title, rubric: item.article.rubric, about: item.article.about },
                onJob: (created) => update(id, { jobId: created.id }),
                onPage: (page) => URL.revokeObjectURL(page.previewUrl),
                onStep: (page, total, step) => update(id, { detail: `${STEP_LABEL[step]} ${page}/${total}` }),
              });
            } finally {
              release();
            }

            update(id, { state: "omzetten", jobId: job.id, pages: 0, pageCount: job.pageCount, detail: undefined });
            const seen = { pages: 0, failure: null as string | null };
            const ok = await streamRun(job.id, provider, (event) => {
              if (event.type === "page") update(id, { pages: ++seen.pages });
              if (event.type === "status" && event.state === "fail" && event.page == null) {
                seen.failure = event.detail ?? event.run;
              }
              if (event.type === "done" && event.cost) {
                update(id, { cost: event.cost.total, currency: event.cost.currency });
              }
            });
            update(id, ok ? { state: "klaar" } : { state: "fout", error: seen.failure ?? "de run stopte zonder artikel" });
          } catch (err) {
            update(id, { state: "fout", error: err instanceof Error ? err.message : String(err) });
          }
        }
      };

      await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
    },
    [provider, concurrency],
  );

  const convert = useCallback(async () => {
    if (!map || !magazine) return;
    const chosen = map.articles.filter((a) => selected.has(a.id) && a.pages.length);
    if (!chosen.length) return;
    setCutting(true);
    setNotice(null);
    try {
      // The browser still has the file after an upload; after a reload it comes
      // out of this browser's storage.
      const source = file
        ? await file.arrayBuffer()
        : await needFile(magazine.id, "source.pdf").then((blob) => blob.arrayBuffer());
      const base = magazine.filename.replace(/\.pdf$/i, "");
      const items: ConvertItem[] = [];
      for (const article of chosen) {
        // Named after the magazine and the printed pages, so a second run of the
        // same article gets the same name and updates instead of duplicating.
        const range = pageRange(article, true);
        const name = `${base} - ${range.startsWith("pdf") ? range : `p${range}`}.pdf`.replace(/[\\/:*?"<>|]/g, "_");
        items.push({ article, file: await cutArticle(source, article.pages, name) });
      }
      setSelected(new Set());
      void runArticles(items);
    } catch (err) {
      setNotice(`De artikelen konden niet worden uitgeknipt: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCutting(false);
    }
  }, [map, magazine, selected, file, runArticles]);

  // The thumbnails out of storage, for a magazine that was opened again rather
  // than rendered in this session.
  const [stored, setStored] = useState<Record<number, string>>({});
  useEffect(() => {
    // While the pages are still being rendered, the render's own previews show.
    if (!magazine || phase === "scanning") return;
    let live = true;
    void Promise.all(
      magazine.pages.map(async (p) => [p.pdf, await fileUrl(magazine.id, p.thumb)] as const),
    ).then((pairs) => {
      if (live) setStored(Object.fromEntries(pairs.filter((pair): pair is readonly [number, string] => !!pair[1])));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [magazine?.id, phase]);

  const thumbOf = useCallback(
    (pdf: number) => thumbs[pdf - 1] ?? stored[pdf],
    [thumbs, stored],
  );

  const busy = phase === "scanning" || phase === "analyzing";

  if (!magazine && phase !== "scanning") {
    return (
      <div className="mx-auto flex min-h-0 w-full max-w-xl flex-1 flex-col items-center justify-center px-6 py-16">
        <h2 className="text-center text-3xl font-semibold tracking-tight">Wat zullen we omzetten?</h2>
        <p className="mt-2 text-center text-sm text-muted-foreground">
          Een volledig magazine. We zoeken uit waar de artikelen staan, jij kiest welke.
        </p>
        <div className="mt-6">{modeSwitch}</div>
        {notice ? (
          <Alert variant="destructive" className="mt-8 w-full">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ) : null}
        <label
          htmlFor="magazine-upload"
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node)) return;
            setDragging(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const dropped = e.dataTransfer.files[0];
            if (dropped) void accept(dropped);
          }}
          className={cn(
            "mt-8 flex min-h-64 w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-8 py-12 text-center transition-colors",
            dragging
              ? "cursor-copy border-foreground bg-muted text-foreground"
              : "cursor-pointer border-muted-foreground/30 bg-card/60 text-muted-foreground hover:border-muted-foreground/55 hover:bg-muted/50",
          )}
        >
          <span className={cn("flex size-14 items-center justify-center rounded-full", dragging ? "bg-foreground/10" : "bg-muted")}>
            <BookOpen className="size-6" />
          </span>
          <span className="grid gap-1">
            <span className="text-sm font-medium text-foreground">
              {dragging ? "Laat los om te beginnen" : "Sleep je magazine hierheen"}
            </span>
            <span className="text-xs">of klik om een bestand te kiezen</span>
          </span>
          <span className="rounded-md border bg-background px-2 py-0.5 text-[11px] font-medium tracking-wide">PDF</span>
        </label>
        <input
          id="magazine-upload"
          className="sr-only"
          type="file"
          accept=".pdf,application/pdf"
          onChange={(e) => {
            const picked = e.target.files?.[0];
            if (picked) void accept(picked);
            e.target.value = "";
          }}
        />
      </div>
    );
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

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex min-h-0 w-96 shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar" aria-label="Magazine">
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
          <ChainOfThought defaultOpen>
            <ChainOfThoughtHeader>
              {phase === "analyzing" ? "Magazine in kaart brengen" : phase === "done" ? "Magazine in kaart" : "Magazine"}
            </ChainOfThoughtHeader>
            <ChainOfThoughtContent>
              <Stage
                icon={UploadCloud}
                label="Pagina's klaarzetten"
                state={phase === "scanning" ? "bezig" : magazine && magazine.pages.length >= pageCount ? "klaar" : "wacht"}
                detail={phase === "scanning" && rendered ? `${rendered.page}/${rendered.total}` : `${pageCount} pagina's`}
              />
              <Stage
                icon={FileSearch}
                label="Pagina's bekijken"
                state={stateOf(lastOf("paginascan"))}
                detail={
                  lastOf("paginascan")
                    ? lastOf("paginascan")?.state === "start"
                      ? `${scanned.length}/${pageCount} bekeken`
                      : lastOf("paginascan")?.detail
                    : undefined
                }
              />
              <Stage icon={Layers} label="Aan elkaar rijgen" state={stateOf(lastOf("rijgen"))} detail={lastOf("rijgen")?.detail}>
                {map?.notes.length ? (
                  <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                    {map.notes.map((note, i) => (
                      <li key={i}>{note}</li>
                    ))}
                  </ul>
                ) : null}
              </Stage>
              {map?.basis === "inhoudsopgave" || lastOf("inhoudscontrole") ? (
                <Stage
                  icon={ListChecks}
                  label="Inhoud toewijzen"
                  state={stateOf(lastOf("inhoudscontrole"))}
                  detail={
                    lastOf("inhoudscontrole")?.state === "start"
                      ? `${status.filter((l) => l.run === "inhoudscontrole" && l.page != null && l.state !== "start").length}/${contentTotal} pagina's`
                      : lastOf("inhoudscontrole")?.detail
                  }
                />
              ) : (
                <Stage
                  icon={Split}
                  label="Grenscontrole"
                  state={stateOf(lastOf("grenscontrole"))}
                  detail={
                    lastOf("grenscontrole")?.state === "start"
                      ? `${map?.boundaries.length ?? 0}/${boundaryTotal} overgangen`
                      : lastOf("grenscontrole")?.detail
                  }
                />
              )}
              {Object.keys(progress).length ? (
                <Stage
                  icon={Sparkles}
                  label="Omzetten"
                  state={converting ? "bezig" : conversion.failed ? "fout" : "klaar"}
                  detail={[
                    `${conversion.done}/${conversion.total} klaar`,
                    conversion.running ? `${conversion.running} bezig` : "",
                    conversion.failed ? `${conversion.failed} mislukt` : "",
                    conversion.cost ? money(conversion.cost, conversion.currency) : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                />
              ) : null}
            </ChainOfThoughtContent>
          </ChainOfThought>
        </div>
        {totals ? (
          <div className="grid shrink-0 grid-cols-2 gap-x-4 gap-y-2 border-t border-sidebar-border px-4 py-3 text-xs">
            <div>
              <div className="text-muted-foreground">Tijd</div>
              <div className="tabular-nums">{Math.round(totals.ms / 1000)} s</div>
            </div>
            <div>
              <div className="text-muted-foreground">Tokens</div>
              <div className="tabular-nums">
                {totals.tokens.toLocaleString("nl-NL")}
                <span className="ml-1 text-muted-foreground">in {totals.runs} runs</span>
              </div>
            </div>
            <div className="col-span-2">
              <div className="text-muted-foreground">Kosten</div>
              <div className="tabular-nums">
                {totals.cost.currency} {totals.cost.total.toFixed(totals.cost.total < 1 ? 3 : 2).replace(".", ",")}
              </div>
            </div>
          </div>
        ) : null}
      </aside>

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
          <div className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-4">
            {Array.from({ length: pageCount }, (_, i) => {
              const scan = scans[i + 1];
              const src = thumbs[i] ?? (magazine?.pages.length ? thumbOf(i + 1) : undefined);
              return (
                <div key={i}>
                  {src ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={src} alt="" className="w-full rounded-lg bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.06)]" />
                  ) : (
                    <div className="aspect-[1/1.414] w-full rounded-lg bg-muted/60" />
                  )}
                  <span className="mt-1.5 block truncate text-xs text-muted-foreground">
                    PDF {i + 1}
                    {scan ? ` · ${scan.error ? "mislukt" : KIND_LABEL[scan.kind]}${scan.folio ? ` · p. ${scan.folio}` : ""}` : ""}
                  </span>
                  {scan?.pieces.filter((p) => p.starts).map((p, j) => (
                    <span key={j} className="block truncate text-xs text-foreground">
                      {p.title ?? "(zonder kop)"}
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
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

/**
 * Eén regel per artikel: kiezen, waar het staat, of er iets na te kijken is, en hoe
 * ver het omzetten is. Wat er verder over te zeggen valt klapt uit.
 */
function ArticleRow({
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

function Stage({
  icon,
  label,
  state,
  detail,
  children,
}: {
  icon: LucideIcon;
  label: string;
  state: "wacht" | "bezig" | "klaar" | "fout";
  detail?: string;
  children?: ReactNode;
}) {
  return (
    <ChainOfThoughtStep
      icon={state === "fout" ? CircleAlert : state === "bezig" ? Loader2 : icon}
      label={label}
      description={detail}
      status={state === "klaar" ? "complete" : state === "bezig" ? "active" : "pending"}
      className={state === "fout" ? "text-[var(--destructive)]" : undefined}
    >
      {children}
    </ChainOfThoughtStep>
  );
}

function stateOf(line?: StatusLine): "wacht" | "bezig" | "klaar" | "fout" {
  if (!line) return "wacht";
  return line.state === "fail" ? "fout" : line.state === "ok" ? "klaar" : "bezig";
}

/** "12-15, 18" out of printed numbers where they are known, else out of PDF pages. */
function pageRange(article: MapArticle, printed: boolean): string {
  const useFolios = printed && article.folios.every((f) => f && /^\d+$/.test(f));
  const numbers = useFolios ? article.folios.map(Number) : article.pages;
  const parts: string[] = [];
  let start = numbers[0];
  let prev = numbers[0];
  for (const n of [...numbers.slice(1), NaN]) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}-${prev}`);
    start = n;
    prev = n;
  }
  return (useFolios ? "" : "pdf") + parts.join(",");
}

function pageLabel(article: MapArticle): string {
  const count = `${article.pages.length} pag.`;
  const opening = article.opening.length > 1 ? " · opent op een spread" : "";
  const printed = pageRange(article, true);
  const where = printed.startsWith("pdf")
    ? `PDF ${printed.replace(/^pdf/, "").replace(/,/g, ", ")}`
    : `p. ${printed.replace(/,/g, ", ")}`;
  return `${where} · ${count}${opening}`;
}

function money(amount: number, currency: string): string {
  return `${currency} ${amount.toFixed(amount < 1 ? 3 : 2).replace(".", ",")}`;
}

function summarizeSkipped(map: MagazineMap): string {
  const byKind = new Map<string, number[]>();
  for (const s of map.skipped) byKind.set(s.kind, [...(byKind.get(s.kind) ?? []), s.pdf]);
  return [...byKind]
    .map(([kind, pages]) => `${KIND_LABEL[kind] ?? kind} (PDF ${pages.join(", ")})`)
    .join(" · ");
}
