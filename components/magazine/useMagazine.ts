"use client";

import { useCallback, useEffect, useState } from "react";
import { pageRange, type StatusLine } from "@/components/magazine/labels";
import { streamRun, uploadArticle } from "@/lib/client/article";
import { analyzeMagazine } from "@/lib/client/analyze";
import { fileUrl, needFile, newId, putFile, saveMagazine, type StoredJob } from "@/lib/client/db";
import { cutArticle, scanMagazine } from "@/lib/client/magazine";
import type { RenderStep } from "@/lib/client/render";
import type {
  Magazine,
  MagazineEvent,
  MagazinePage,
  MagazineMap,
  MapArticle,
  PageScan,
} from "@/lib/magazine/types";
import { errorMessage, pad2 } from "@/lib/util";

export type Phase = "idle" | "scanning" | "ready" | "analyzing" | "done" | "error";

interface ConvertItem {
  article: MapArticle;
  file: File;
}

/** Where one chosen article is on its way to being converted. */
export interface ArticleProgress {
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

export const RUNNING: ArticleProgress["state"][] = ["wacht", "uitlezen", "omzetten"];

const STEP_LABEL: Record<RenderStep | "opslaan", string> = {
  renderen: "renderen",
  beelden: "beeld",
  lettertypen: "letters",
  opslaan: "opslaan",
};

/** A dense page's text layer runs to some thousands of characters; more is not text. */
const TEXT_LIMIT = 40_000;

export interface Totals {
  runs: number;
  tokens: number;
  ms: number;
  cost: { total: number; currency: string };
}

/**
 * Alle state van de magazinestand: inlezen, analyseren, en de gekozen artikelen
 * op de achtergrond omzetten.
 */
export function useMagazine({
  provider,
  concurrency,
  onBusyChange,
}: {
  provider: "openai" | "mistral";
  concurrency: number;
  onBusyChange?: (busy: boolean) => void;
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
      setNotice(errorMessage(err));
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
      setNotice(errorMessage(err));
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
            update(id, { state: "fout", error: errorMessage(err) });
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
      setNotice(`De artikelen konden niet worden uitgeknipt: ${errorMessage(err)}`);
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

  return {
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
  };
}
