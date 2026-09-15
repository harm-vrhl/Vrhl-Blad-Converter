"use client";

import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { livePreview } from "@/components/article/preview";
import { workflowSteps, type StatusLine } from "@/components/article/steps";
import type { Provider, Settings } from "@/components/article/useSettings";
import type { WorkflowStep } from "@/components/Workflow";
import type { StyleFragment } from "@/lib/agents/styling";
import { streamRun, uploadArticle } from "@/lib/client/article";
import {
  estimate,
  fileUrl,
  getData,
  listJobs,
  loadJob,
  saveJob,
  sizeOf,
  type StoredJob,
  type Totals,
} from "@/lib/client/db";
import type { RenderStep } from "@/lib/client/render";
import { frameTitlesAsHeadings } from "@/lib/compile";
import { boxOnly } from "@/lib/imagefilter";
import type {
  ArticleDocument,
  Frontmatter,
  ImageVerdict,
  PageResult,
  Patch,
  RunEvent,
} from "@/lib/types";
import { errorMessage } from "@/lib/util";

export type Phase = "idle" | "rendering" | "ready" | "running" | "done" | "error";
export type Tab = "paginas" | "artikel" | "json" | "checks";

type Step = WorkflowStep;

/**
 * Eén artikel omzetten, of een eerder omgezet artikel terug in beeld: alle state
 * van het artikelscherm, en wat daaruit volgt (de stappen en de live preview).
 */
export function useArticleRun({
  provider,
  setSettings,
  setProvider,
  setView,
}: {
  provider: Provider;
  setSettings: Dispatch<SetStateAction<Settings | null>>;
  setProvider: Dispatch<SetStateAction<Provider>>;
  /** In magazinestand: een geopend artikel laat de lijst los. */
  setView: Dispatch<SetStateAction<"magazine" | "artikel">>;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [job, setJob] = useState<StoredJob | null>(null);
  /** Wat er in deze browser eerder is omgezet, voor de lijst op het startscherm. */
  const [earlier, setEarlier] = useState<Array<StoredJob & { bytes: number }> | null>(null);
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [status, setStatus] = useState<StatusLine[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  /**
   * Het artikel zoals iemand het in de Artikel-tab heeft rechtgezet, of null
   * zolang niemand iets deed. Null en "gelijk aan wat de AI schreef" zijn niet
   * hetzelfde: alleen dat eerste betekent dat er niets te herstellen valt.
   */
  const [edited, setEdited] = useState<ArticleDocument | null>(null);
  const [text, setText] = useState<Record<number, string>>({});
  const [patches, setPatches] = useState<Record<number, Patch[]>>({});
  // What run 2 read off the page. It lands while run 1 is still writing, which
  // is what lets the pane set the words as they arrive.
  const [fragments, setFragments] = useState<Record<number, StyleFragment[]>>({});
  const [results, setResults] = useState<Record<number, PageResult>>({});
  const [frontmatter, setFrontmatter] = useState<Frontmatter | null>(null);
  const [verdicts, setVerdicts] = useState<ImageVerdict[]>([]);
  const [doc, setDoc] = useState<ArticleDocument | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("paginas");
  const [renderStep, setRenderStep] = useState<{
    page: number;
    total: number;
    step: RenderStep | "opslaan";
  } | null>(null);
  /** Het afgeronde artikel met de correcties erin: wat de exports krijgen. */
  const current = edited ?? doc;

  const accept = useCallback(async (file: File, opening?: number): Promise<StoredJob | null> => {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setNotice("Alleen PDF-bestanden.");
      return null;
    }
    setPhase("rendering");
    setNotice(null);
    setStatus([]);
    setTotals(null);
    setEdited(null);
    setText({});
    setPatches({});
    setFragments({});
    setResults({});
    setFrontmatter(null);
    setVerdicts([]);
    setDoc(null);
    setJob(null);
    setThumbs([]);
    setRenderStep(null);
    setTab("paginas");

    try {
      const landed = await uploadArticle(file, {
        opening,
        onJob: (created) => setJob({ ...created }),
        onPage: (rendered) => setThumbs((prev) => [...prev, rendered.previewUrl]),
        onStep: (page, total, step) => setRenderStep({ page, total, step }),
      });
      setJob({ ...landed });
      setRenderStep(null);
      setPhase("ready");
      return landed;
    } catch (err) {
      setRenderStep(null);
      setNotice(errorMessage(err));
      setPhase("error");
      return null;
    }
  }, []);

  /** Resolves true when the run reached its end with an article. */
  const convert = useCallback(async (resume = false): Promise<boolean> => {
    const run = job;
    if (!run) return false;
    let finished = false;
    setPhase("running");
    setStatus([]);
    setTotals(null);
    setEdited(null);
    setText({});
    setPatches({});
    setFragments({});
    setResults({});
    setDoc(null);
    setNotice(null);
    setTab("artikel");

    try {
      finished = await streamRun(run.id, provider, handle, { resume });
      // De run schreef de job bij in de opslag; het scherm neemt die stand over.
      const stored = await loadJob(run.id);
      if (stored) setJob(stored);
    } catch (err) {
      setNotice(errorMessage(err));
      setPhase("error");
      finished = false;
    }

    // A run is where the provider's limits are learned; pick them up afterwards
    // so the switch can say what the key is allowed.
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: Settings | null) => {
        if (!body) return;
        setSettings(body);
        // A provider that turned out closed cannot stay selected behind a disabled
        // switch. Only the selection moves; the remembered preference stays, so
        // it comes back once the limit is set.
        const open = body.providers.filter((p) => p.ready && p.limit !== 0);
        setProvider((current) =>
          open.some((p) => p.id === current) ? current : (open[0]?.id ?? current),
        );
      })
      .catch(() => undefined);

    function handle(event: RunEvent) {
      switch (event.type) {
        case "status":
          setStatus((prev) => [...prev, event]);
          // A page that fails is logged; only a failure without a page number
          // means the whole run is over.
          if (event.state === "fail" && event.page == null) {
            setNotice(event.detail ?? event.run);
            setPhase("error");
          }
          break;
        case "delta":
          // A form feed means the run started over; drop what came before.
          setText((prev) => ({
            ...prev,
            [event.page]:
              event.text === "\f" ? "" : (prev[event.page] ?? "") + event.text,
          }));
          break;
        case "styling":
          setFragments((prev) => ({ ...prev, [event.page]: event.fragments }));
          break;
        case "patch":
          setPatches((prev) => ({
            ...prev,
            [event.page]: [...(prev[event.page] ?? []), event.patch],
          }));
          break;
        case "page":
          setResults((prev) => ({ ...prev, [event.page]: event.result }));
          break;
        case "frontmatter":
          setFrontmatter(event.frontmatter);
          break;
        case "images":
          setVerdicts(event.verdicts);
          break;
        case "done":
          setDoc(event.document);
          setPhase("done");
          // The article is already on screen, at the top of this same tab; what
          // the run cost belongs under the steps that spent it.
          setTotals({
            runs: event.runs,
            tokens: event.tokens,
            ms: event.ms,
            ocrPages: event.ocr?.pages ?? 0,
            cost: event.cost ?? null,
          });
          break;
      }
    }
    return finished;
  }, [job, provider]);

  /** Een eerder omgezet artikel terug in beeld, uit de opslag van deze browser. */
  const openJob = useCallback(async (jobId: string) => {
    try {
      const loaded = await loadJob(jobId);
      if (!loaded) throw new Error("dit artikel staat niet (meer) in de opslag van deze browser");
      const saved = (await getData<PageResult[]>(jobId, "pages.json")) ?? [];
      const pageThumbs = await Promise.all(loaded.pages.map((p) => fileUrl(jobId, p.thumb)));

      setStatus([]);
      setTotals(loaded.totals);
      setEdited(loaded.edited && frameTitlesAsHeadings(loaded.edited));
      setText({});
      setPatches({});
      setFragments({});
      setNotice(null);
      setRenderStep(null);
      setJob(loaded);
      setThumbs(pageThumbs.filter((url): url is string => !!url));
      setResults(Object.fromEntries(saved.map((p) => [p.page, p])));
      setVerdicts(loaded.verdicts ?? []);
      setFrontmatter(loaded.document?.frontmatter ?? null);
      setDoc(loaded.document && frameTitlesAsHeadings(loaded.document));
      setPhase(loaded.document ? "done" : "ready");
      setTab(loaded.document ? "artikel" : "paginas");
      setView("artikel");
    } catch (err) {
      setNotice(errorMessage(err));
    }
  }, []);

  /** Terug naar het startscherm, met de lijst van wat er eerder is omgezet. */
  const closeJob = useCallback(() => {
    setJob(null);
    setDoc(null);
    setEdited(null);
    setThumbs([]);
    setStatus([]);
    setTotals(null);
    setResults({});
    setText({});
    setPatches({});
    setFragments({});
    setFrontmatter(null);
    setVerdicts([]);
    setNotice(null);
    setPhase("idle");
    setTab("paginas");
  }, []);

  /** De lijst op het startscherm, en hoeveel ruimte alles samen inneemt. */
  const refreshEarlier = useCallback(async () => {
    try {
      const jobs = await listJobs();
      setEarlier(await Promise.all(jobs.map(async (j) => ({ ...j, bytes: await sizeOf(j.id) }))));
      setStorage(await estimate());
    } catch {
      setEarlier([]);
    }
  }, []);

  useEffect(() => {
    if (!job) void refreshEarlier();
  }, [job, refreshEarlier]);

  // Correcties blijven bewaard: even na de laatste wijziging gaan ze de opslag in.
  useEffect(() => {
    if (!job || phase !== "done") return;
    const timer = window.setTimeout(() => {
      void loadJob(job.id).then((stored) => {
        if (!stored || stored.edited === edited) return;
        stored.edited = edited;
        return saveJob(stored);
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [edited, job, phase]);

  const pageResults = useMemo(
    () => Object.values(results).sort((a, b) => a.page - b.page),
    [results],
  );

  // The images run 1 was allowed to place: everything the triage kept. Before
  // the verdicts arrive nothing is rejected yet, which is also what the pipeline
  // does with a triage that failed.
  const approved = useMemo(() => {
    const rejected = new Set(verdicts.filter((v) => !v.keep).map((v) => v.id));
    return (job?.images ?? []).filter((image) => !rejected.has(image.id));
  }, [job, verdicts]);
  const boxed = useMemo(() => boxOnly(job?.images ?? [], verdicts), [job, verdicts]);

  const steps: Step[] = useMemo(() => workflowSteps(status, results, job), [status, results, job]);

  const preview: ArticleDocument | null = useMemo(
    () =>
      livePreview({ current, frontmatter, pageResults, results, text, patches, fragments, approved, boxed, job }),
    [current, frontmatter, pageResults, results, text, patches, fragments, approved, boxed, job],
  );

  return {
    phase,
    job,
    earlier,
    storage,
    thumbs,
    status,
    totals,
    edited,
    setEdited,
    text,
    frontmatter,
    verdicts,
    doc,
    notice,
    setNotice,
    tab,
    setTab,
    renderStep,
    current,
    pageResults,
    steps,
    preview,
    accept,
    convert,
    openJob,
    closeJob,
    refreshEarlier,
  };
}
