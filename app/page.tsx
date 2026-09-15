"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "cn";
import {
  ArrowLeft,
  Check,
  Copy,
  FileCode,
  FileJson,
  Loader2,
  Package,
  RotateCcw,
  UploadCloud,
} from "lucide-react";
import { ArticleView } from "@/components/ArticleView";
import { Checks } from "@/components/Checks";
import { MagazineView } from "@/components/MagazineView";
import { PageThumbs } from "@/components/PageThumbs";
import { ProviderSwitch } from "@/components/ProviderSwitch";
import { QuietToolbar, ToolbarButton, ToolbarRule } from "@/components/QuietToolbar";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Workflow, type WorkflowStep } from "@/components/Workflow";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
// Geen Tooltip hier met opzet: de hints bij de schakelaar en de Sanity-knop zijn
// juist nodig als die knoppen uit staan, en een tooltip krijgt op een disabled
// element geen pointer-events. Het native title-attribuut wel.
import { streamRun, uploadArticle } from "@/lib/client/article";
import type { RenderStep } from "@/lib/client/render";
import { blankFrontmatter, compileArticle } from "@/lib/compile";
import { toPackage } from "@/lib/canonical";
import { toMdx } from "@/lib/mdx";
import { parsePage } from "@/lib/pagemarkup";
import { applyStyles } from "@/lib/patch";
import { placeFragments } from "@/lib/place";
import type { StyleFragment } from "@/lib/agents/styling";
import type {
  ArticleDocument,
  Frontmatter,
  Job,
  ImageVerdict,
  PageResult,
  Patch,
  RunEvent,
} from "@/lib/types";

type Phase = "idle" | "rendering" | "ready" | "running" | "done" | "error";
type Tab = "paginas" | "artikel" | "json" | "checks";

type Step = WorkflowStep;

/** What each run is called while it is still going. */
const BUSY: Record<string, string> = {
  "run 1 leesvolgorde": "tekst uitschrijven…",
  "opmaak uit de PDF": "opmaak uit de PDF…",
  "run 2 opmaak": "opmaak van het beeld lezen…",
  pagina: "bezig…",
};

/** What the whole run came to: the receipt under the steps that spent it. */
interface Totals {
  runs: number;
  tokens: number;
  ms: number;
  ocrPages: number;
  cost: { ai: number; ocr: number; total: number; currency: string } | null;
}

interface StatusLine {
  run: string;
  page?: number;
  state: "start" | "ok" | "fail";
  detail?: string;
}

export default function Home() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [job, setJob] = useState<Job | null>(null);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [status, setStatus] = useState<StatusLine[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  /**
   * Het artikel zoals iemand het in de Artikel-tab heeft rechtgezet, of null
   * zolang niemand iets deed. Null en "gelijk aan wat de AI schreef" zijn niet
   * hetzelfde: alleen dat eerste betekent dat er niets te herstellen valt.
   */
  const [edited, setEdited] = useState<ArticleDocument | null>(null);
  /** Even "Gekopieerd" naast de JSON, daarna weer de knop. */
  const [copied, setCopied] = useState(false);
  const [text, setText] = useState<Record<number, string>>({});
  const [patches, setPatches] = useState<Record<number, Patch[]>>({});
  // What run 2 read off the page. It lands while run 1 is still writing, which
  // is what lets the pane set the words as they arrive.
  const [fragments, setFragments] = useState<Record<number, StyleFragment[]>>({});
  const [results, setResults] = useState<Record<number, PageResult>>({});
  const [frontmatter, setFrontmatter] = useState<Frontmatter | null>(null);
  const [verdicts, setVerdicts] = useState<ImageVerdict[]>([]);
  // How this installation stands by default, and what the optional OCR costs.
  const [settings, setSettings] = useState<Settings | null>(null);
  const [provider, setProvider] = useState<Provider>("openai");
  const [doc, setDoc] = useState<ArticleDocument | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Het inpakken van het canonieke pakket loopt over de server en duurt even. */
  const [packing, setPacking] = useState(false);
  /** Idem voor het duwen naar Sanity, dat bovendien beeld uploadt. */
  const [pushing, setPushing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [tab, setTab] = useState<Tab>("paginas");
  const [renderStep, setRenderStep] = useState<{
    page: number;
    total: number;
    step: RenderStep | "uploaden";
  } | null>(null);
  /**
   * Eén artikel-PDF, zoals altijd, of een volledig magazine waarin eerst gezocht
   * wordt waar de artikelen staan. Het magazine blijft gemonteerd zodra het een
   * keer open is geweest, zodat de lijst er nog staat als je van een omgezet
   * artikel terugkomt.
   */
  const [mode, setMode] = useState<Mode>("artikel");
  const [magazineOpened, setMagazineOpened] = useState(false);
  /** In magazinestand: kijk je naar de lijst of naar een artikel eruit? */
  const [view, setView] = useState<"magazine" | "artikel">("magazine");
  /** Of het magazine op de achtergrond artikelen aan het omzetten is. */
  const [converting, setConverting] = useState(false);
  const uploadDisabled = phase === "rendering" || phase === "running" || converting;
  const showMagazine = mode === "magazine" && view === "magazine";
  /** Het afgeronde artikel met de correcties erin: wat de exports krijgen. */
  const current = edited ?? doc;

  const accept = useCallback(async (file: File, opening?: number): Promise<Job | null> => {
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
        onJob: (created, missingKeys) => {
          setJob(created);
          if (missingKeys.length)
            setNotice(`Ontbrekende sleutels in .env.local: ${missingKeys.join(", ")}`);
        },
        onPage: (rendered) => setThumbs((prev) => [...prev, rendered.previewUrl]),
        onStep: (page, total, step) => setRenderStep({ page, total, step }),
      });
      setJob(landed);
      setRenderStep(null);
      setPhase("ready");
      return landed;
    } catch (err) {
      setRenderStep(null);
      setNotice(err instanceof Error ? err.message : String(err));
      setPhase("error");
      return null;
    }
  }, []);

  useEffect(() => {
    let live = true;
    fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: Settings | null) => {
        if (!live || !body) return;
        setSettings(body);
        let remembered: string | null = null;
        try {
          remembered = window.localStorage.getItem(PROVIDER_KEY);
        } catch {
          remembered = null;
        }
        const usable = body.providers.filter((p) => p.ready && p.limit !== 0).map((p) => p.id);
        const pick = [remembered, body.provider].find(
          (id): id is Provider => !!id && usable.includes(id as Provider),
        );
        if (pick) setProvider(pick);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  /** Resolves true when the run reached its end with an article. */
  const convert = useCallback(async (target?: Job): Promise<boolean> => {
    const run = target ?? job;
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
      finished = await streamRun(run.id, provider, handle);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
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

  /** Een eerder omgezet artikel terug in beeld, uit wat de run heeft opgeslagen. */
  const openJob = useCallback(async (jobId: string) => {
    try {
      const res = await fetch(`/api/jobs/${jobId}`);
      if (!res.ok) throw new Error("dit artikel is niet meer te vinden");
      const loaded = (await res.json()) as Job;
      const saved = await fetch(`/api/jobs/${jobId}/artifact/pages.json`)
        .then((r) => (r.ok ? (r.json() as Promise<PageResult[]>) : []))
        .catch(() => [] as PageResult[]);
      const triage = await fetch(`/api/jobs/${jobId}/artifact/images.json`)
        .then((r) =>
          r.ok
            ? (r.json() as Promise<{ verdicts?: ImageVerdict[]; rejected?: Record<string, string> }>)
            : null,
        )
        .catch(() => null);
      const verdictList = triage?.verdicts ?? [];
      for (const [id, reason] of Object.entries(triage?.rejected ?? {})) {
        if (!verdictList.some((v) => v.id === id)) verdictList.push({ id, keep: false, kind: "ornament", reason });
      }

      setStatus([]);
      setTotals(null);
      setEdited(null);
      setText({});
      setPatches({});
      setFragments({});
      setNotice(null);
      setRenderStep(null);
      setJob(loaded);
      setThumbs(loaded.pages.map((p) => `/api/jobs/${jobId}/artifact/${p.thumb}`));
      setResults(Object.fromEntries(saved.map((p) => [p.page, p])));
      setVerdicts(verdictList);
      setFrontmatter(loaded.document?.frontmatter ?? null);
      setDoc(loaded.document);
      setPhase(loaded.document ? "done" : "ready");
      setTab(loaded.document ? "artikel" : "paginas");
      setView("artikel");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const modeSwitch = (
    <SegmentedControl
      aria-label="Soort PDF"
      value={mode}
      disabled={uploadDisabled}
      onChange={(next) => {
        setMode(next);
        if (next === "magazine") {
          setMagazineOpened(true);
          setView("magazine");
        }
      }}
      options={[
        { id: "artikel", label: "Eén artikel" },
        { id: "magazine", label: "Volledig magazine" },
      ]}
    />
  );


  /**
   * Het artikel als Vrhl Content Package: pakket.json plus het beeld, in een ZIP.
   *
   * Wat in de Artikel-tab is rechtgezet gaat mee. De server kent alleen wat de
   * run heeft opgeslagen, dus het artikel zoals het nu op het scherm staat reist
   * mee in de body; anders levert de knop iets anders af dan je ziet.
   */
  const downloadPackage = useCallback(async () => {
    if (!job || !current) return;
    setPacking(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/jobs/${job.id}/package`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: current }),
      });
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const named = /filename="([^"]+)"/.exec(
        res.headers.get("content-disposition") ?? "",
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = named?.[1] ?? "pakket.zip";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setNotice(
        `Het pakket kon niet worden gemaakt: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setPacking(false);
    }
  }, [job, current]);

  /**
   * Het artikel naar Sanity, als concept.
   *
   * Wat hier weggaat is het pakket, niet het artikelobject: de importer leest
   * hetzelfde formaat dat ook naar MDX of Word gaat, met de correcties erin. Het schrijven zelf gebeurt
   * op de server, want het token hoort de browser nooit te zien.
   */
  const pushSanity = useCallback(async () => {
    if (!job || !current) return;
    setPushing(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/jobs/${job.id}/sanity`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: current }),
      });
      const body = (await res.json()) as {
        documents?: unknown[];
        created?: string[];
        uploaded?: number;
        warnings?: string[];
        error?: string;
        detail?: string;
      };
      if (!res.ok) throw new Error(body.detail ? `${body.error} (${body.detail})` : (body.error ?? `fout ${res.status}`));

      const deel = [
        `${body.documents?.length ?? 0} document(en) als concept weggeschreven`,
        body.uploaded ? `${body.uploaded} afbeelding(en) geupload` : null,
        body.created?.length ? `nieuw aangemaakt: ${body.created.join(", ")}` : null,
      ].filter(Boolean);
      setNotice(
        `Naar Sanity: ${deel.join(" · ")}.${
          body.warnings?.length ? ` Let op: ${body.warnings.join(" · ")}` : ""
        }`,
      );
    } catch (err) {
      setNotice(
        `Het duwen naar Sanity is niet gelukt: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setPushing(false);
    }
  }, [job, current]);

  /**
   * Het canonieke pakket, zoals het naar Sanity en in de ZIP gaat.
   *
   * De JSON-tab laat precies dit zien, en de MDX-export wordt hier uit
   * geschreven, net zoals elke andere vertaalslag dat zou doen.
   */
  const pakket = useMemo(
    () => (current ? toPackage(current, { images: job?.images ?? [] }) : null),
    [current, job],
  );
  const pakketJson = useMemo(
    () => (pakket ? JSON.stringify(pakket, null, 2) : ""),
    [pakket],
  );

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

  // The article as it stands right now, built by the same compileArticle the
  // pipeline finishes with. That is the point: the live preview cannot drift
  // from the result. The frontmatter appears the moment it is read, and a page
  // that is still being written is parsed here from run 1's own output, with
  // the same parser the server uses - so the column fills block by block, and
  // the page's real result takes over the moment its two runs are done.
  //
  // The typography is laid on here too, with the same placer the server uses.
  // Run 2 no longer waits for run 1, so its marks are usually in before the text
  // has finished arriving; placing them here is what lets the reader watch a
  // paragraph appear already set rather than watch it change afterwards.
  /**
   * The run, as a handful of steps rather than as its log.
   *
   * The pipeline emits a line for every start and every finish of every run on
   * every page: for a six-page article that is forty entries of "run 1
   * leesvolgorde · p3". Useful while building it, unreadable while using it. The
   * same events are folded here into the few things someone actually waits for -
   * the document-wide stages, and then one row per page - so the list says where
   * the job IS instead of everything it has done.
   */
  const steps: Step[] = useMemo(() => {
    if (!status.length && !job) return [];

    const last = (run: string, page?: number) =>
      [...status].reverse().find((l) => l.run === run && (page === undefined || l.page === page));

    const stage = (
      key: string,
      label: string,
      run: string,
      kind: Step["kind"] = "stage",
      detail?: string,
    ): Step => {
      const seen = last(run);
      if (!seen) return { key, label, state: "wacht", detail: "", kind };
      return {
        key,
        label,
        kind,
        state: seen.state === "fail" ? "fout" : seen.state === "ok" ? "klaar" : "bezig",
        detail: detail ?? seen.detail ?? "",
      };
    };

    const runState = (line?: StatusLine): Step["state"] | undefined => {
      if (!line) return undefined;
      return line.state === "fail" ? "fout" : line.state === "ok" ? "klaar" : "bezig";
    };

    const out: Step[] = [
      stage("ocr", "Tekst lezen", "woordindex"),
      stage("front", "Kop en auteurs", "frontmatter"),
      stage("beeld", "Beeld beoordelen", "beeldbeoordeling"),
    ];

    // One row per page, whatever the pipeline happens to be doing on it.
    for (let page = 1; page <= (job?.pageCount ?? 0); page++) {
      const done = results[page];
      const failed = status.find((l) => l.page === page && l.state === "fail");
      const busy = [...status].reverse().find((l) => l.page === page && l.state === "start");

      out.push({
        key: `p${page}`,
        label: `Pagina ${page}`,
        kind: "page",
        page,
        state: failed ? "fout" : done ? "klaar" : busy ? "bezig" : "wacht",
        detail: failed
          ? (failed.detail ?? "mislukt")
          : done
            ? `${done.blocks.length} blokken · ${done.patches.length} opmaak`
            : busy
              ? BUSY[busy.run] ?? busy.run
              : "",
        textRun: runState(last("run 1 leesvolgorde", page)),
        styleRun: runState(
          last("run 2 opmaak", page) ?? last("opmaak uit de PDF", page),
        ),
        coverage: done ? Math.round(done.check.score * 100) : undefined,
        unknown: done?.check.unknown.length ? done.check.unknown : undefined,
      });
    }

    out.push(stage("klaar", "Samenvoegen", "compileren", "compile"));
    return out;
  }, [status, results, job]);

  const preview: ArticleDocument | null = useMemo(() => {
    if (current) return current;

    const pages: PageResult[] = [...pageResults];
    for (const [key, raw] of Object.entries(text)) {
      const page = Number(key);
      if (results[page] || !raw.trim()) continue;
      const { blocks, continuity } = parsePage(page, raw, approved);
      // The server's placed patches once it has sent them, and until then run 2's
      // own fragments, placed against the text that has arrived so far.
      const marks = patches[page]?.length
        ? patches[page]
        : placeFragments(blocks, fragments[page] ?? []).patches;
      const applied = applyStyles(blocks, marks);
      pages.push({
        page,
        blocks,
        patches: marks,
        dropped: applied.dropped,
        content: applied.content,
        continuity,
        check: { unknown: [], overused: [], score: 1 },
        warnings: [],
      });
    }
    pages.sort((a, b) => a.page - b.page);

    if (!frontmatter && !pages.length) return null;
    return compileArticle(
      frontmatter ?? blankFrontmatter(),
      pages,
      { file: job?.filename ?? "", pages: pages.map((p) => p.page) },
      approved,
    ).document;
  }, [current, frontmatter, pageResults, results, text, patches, fragments, approved, job]);

  const idle = !job && phase !== "rendering";
  const noticeOk = !!notice && notice.startsWith("Naar Sanity");

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <header className="z-20 shrink-0 border-b bg-white/80 backdrop-blur-md">
        <div className="flex h-14 items-center justify-between gap-4 px-6">
          <h1 className="flex items-baseline gap-2 text-sm tracking-tight">
            <span className="font-semibold">Vrhl</span>
            <span className="text-muted-foreground">Blad</span>
          </h1>
          <div className="flex min-w-0 items-center justify-end gap-2">
            {mode === "magazine" && view === "artikel" ? (
              <Button variant="ghost" size="sm" onClick={() => setView("magazine")}>
                <ArrowLeft />
                Magazine
              </Button>
            ) : null}
            {job && !showMagazine ? (
              <>
                <span className="hidden max-w-xs truncate text-xs text-muted-foreground sm:inline">
                  {job.filename}
                  {" · "}
                  {phase === "rendering"
                    ? renderStep
                      ? `${renderStep.page}/${renderStep.total} · ${renderStep.step}`
                      : `${thumbs.length}/${job.pageCount} klaar`
                    : `${job.pageCount} pagina's`}
                </span>
                {uploadDisabled || mode === "magazine" ? (
                  mode === "magazine" ? null : (
                    <span className="px-2.5 text-sm text-muted-foreground/50">
                      Andere PDF
                    </span>
                  )
                ) : (
                  <Button variant="ghost" size="sm" asChild>
                    <label htmlFor="pdf-upload" className="cursor-pointer">
                      Andere PDF
                    </label>
                  </Button>
                )}
              </>
            ) : null}
            {settings ? (
              <ProviderSwitch
                providers={settings.providers}
                value={provider}
                disabled={phase === "running" || converting}
                onChange={(id) => {
                  setProvider(id);
                  try {
                    window.localStorage.setItem(PROVIDER_KEY, id);
                  } catch {
                    /* a remembered choice is a convenience, not a need */
                  }
                }}
              />
            ) : null}
            {job && !showMagazine ? (
              <Button
                variant="brand"
                disabled={
                  converting ||
                  (phase !== "ready" && phase !== "done" && phase !== "error")
                }
                onClick={() => void convert()}
              >
                {phase === "running" ? (
                  <>
                    <Loader2 className="animate-spin" />
                    Bezig…
                  </>
                ) : (
                  "Convert"
                )}
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      <input
        id="pdf-upload"
        className="sr-only"
        type="file"
        accept=".pdf,application/pdf"
        disabled={uploadDisabled}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void accept(file);
          e.target.value = "";
        }}
      />

      {magazineOpened ? (
        <div hidden={!showMagazine} className="flex min-h-0 flex-1 flex-col">
          <MagazineView
            provider={provider}
            modeSwitch={modeSwitch}
            concurrency={settings?.articleConcurrency ?? 3}
            onBusyChange={setConverting}
            onOpen={(jobId) => void openJob(jobId)}
          />
        </div>
      ) : null}

      {showMagazine ? null : idle || (phase === "rendering" && !job) ? (
        <div className="mx-auto flex min-h-0 w-full max-w-xl flex-1 flex-col items-center justify-center px-6 py-16">
          <h2 className="text-center text-3xl font-semibold tracking-tight">
            Wat zullen we omzetten?
          </h2>
          <p className="mt-2 text-center text-sm text-muted-foreground">
            Een magazine-PDF. Kolommen, kaders en foto&apos;s worden één artikel.
          </p>
          {mode === "artikel" ? <div className="mt-6">{modeSwitch}</div> : null}
          {notice ? (
            <Alert
              variant={noticeOk ? "default" : "destructive"}
              className="mt-8 w-full"
            >
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          ) : null}
          <label
            htmlFor={phase === "rendering" ? undefined : "pdf-upload"}
            aria-disabled={phase === "rendering"}
            onDragOver={(e) => {
              e.preventDefault();
              if (phase === "rendering") return;
              setDragging(true);
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node)) return;
              setDragging(false);
            }}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (phase === "rendering") return;
              const file = e.dataTransfer.files[0];
              if (file) void accept(file);
            }}
            className={cn(
              "mt-10 flex min-h-64 w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-8 py-12 text-center transition-colors",
              phase === "rendering"
                ? "cursor-default border-border bg-muted/30 text-muted-foreground"
                : dragging
                  ? "cursor-copy border-foreground bg-muted text-foreground"
                  : "cursor-pointer border-muted-foreground/30 bg-card/60 text-muted-foreground hover:border-muted-foreground/55 hover:bg-muted/50",
            )}
          >
            <span
              className={cn(
                "flex size-14 items-center justify-center rounded-full",
                dragging ? "bg-foreground/10" : "bg-muted",
              )}
            >
              {phase === "rendering" ? (
                <Loader2 className="size-6 animate-spin" />
              ) : (
                <UploadCloud className="size-6" />
              )}
            </span>
            <span className="grid gap-1">
              <span className="text-sm font-medium text-foreground">
                {phase === "rendering"
                  ? "Pagina's renderen…"
                  : dragging
                    ? "Laat los om te beginnen"
                    : "Sleep je PDF hierheen"}
              </span>
              <span className="text-xs">
                {phase === "rendering"
                  ? renderStep
                    ? `${renderStep.page}/${renderStep.total} · ${renderStep.step}`
                    : "pdf.js leest het bestand"
                  : "of klik om een bestand te kiezen"}
              </span>
            </span>
            {phase === "rendering" ? null : (
              <span className="rounded-md border bg-background px-2 py-0.5 text-[11px] font-medium tracking-wide">
                PDF
              </span>
            )}
          </label>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside
            className="flex min-h-0 w-96 shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar"
            aria-label="Omzetten"
          >
            <Workflow
              steps={steps}
              totals={totals}
              phase={phase}
              thumbs={thumbs}
              jobId={job?.id ?? null}
              frontmatter={frontmatter}
              verdicts={verdicts}
              images={job?.images ?? []}
              text={text}
            />
          </aside>

          <div className="min-w-0 flex-1 overflow-y-auto overscroll-contain px-6 pt-8 pb-24">
          {notice ? (
            <Alert
              variant={noticeOk ? "default" : "destructive"}
              className="mb-6 max-w-2xl"
            >
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          ) : null}

          {status.length || totals || phase === "running" || phase === "done" ? (
            <div className="mb-8 flex flex-wrap items-center gap-2">
              <SegmentedControl
                aria-label="Weergave"
                value={tab}
                onChange={(next) => setTab(next)}
                options={(["paginas", "artikel", "json", "checks"] as Tab[]).map(
                  (t) => ({
                    id: t,
                    label: LABELS[t],
                    disabled: ALWAYS.includes(t) ? false : !doc,
                  }),
                )}
              />
              <span className="flex-1" />
              {doc ? (
                <QuietToolbar aria-label="Exporteren">
                  <ToolbarButton
                    type="button"
                    onClick={() => download("pakket.json", pakketJson)}
                  >
                    <FileJson className="size-3.5" />
                    JSON
                  </ToolbarButton>
                  <ToolbarButton
                    type="button"
                    onClick={() => pakket && download("artikel.mdx", toMdx(pakket))}
                  >
                    <FileCode className="size-3.5" />
                    MDX
                  </ToolbarButton>
                  <ToolbarButton
                    type="button"
                    disabled={packing}
                    onClick={() => void downloadPackage()}
                  >
                    {packing ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Package className="size-3.5" />
                    )}
                    {packing ? "Inpakken…" : "Pakket"}
                  </ToolbarButton>
                  <ToolbarRule />
                  <ToolbarButton
                    type="button"
                    disabled={pushing || !settings?.sanity?.ready}
                    title={
                      settings?.sanity?.ready
                        ? `Als concept naar ${settings.sanity.projectId} · ${settings.sanity.dataset}`
                        : "Vul NEXT_PUBLIC_SANITY_PROJECT_ID, NEXT_PUBLIC_SANITY_DATASET en SANITY_API_TOKEN in .env.local"
                    }
                    onClick={() => void pushSanity()}
                  >
                    {pushing ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <UploadCloud className="size-3.5" />
                    )}
                    {pushing ? "Versturen…" : "Sanity"}
                  </ToolbarButton>
                </QuietToolbar>
              ) : null}
            </div>
          ) : null}

          {tab === "paginas" && job ? (
            <PageThumbs
              thumbs={thumbs}
              jobId={job.id}
              pages={job.pages}
              pageCount={job.pageCount}
            />
          ) : null}

          {tab === "artikel" ? (
            preview && job ? (
              <section className="mb-8">
                <div className="mb-3 flex min-h-7 items-center gap-3 text-xs text-muted-foreground">
                  {doc && edited ? (
                    <>
                      <span className="font-medium text-foreground">Bijgewerkt</span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        onClick={() => setEdited(null)}
                      >
                        <RotateCcw className="size-3.5" />
                        Terug naar AI-resultaat
                      </Button>
                    </>
                  ) : doc ? (
                    <span>
                      Klik in de tekst om te corrigeren. ⌘B, ⌘I en ⌘U voor
                      opmaak; een blok leegmaken haalt het weg.
                    </span>
                  ) : null}
                  <span className="ml-auto whitespace-nowrap">
                    {phase === "running"
                      ? `${pageResults.length}/${job.pageCount} pagina's`
                      : `${preview.content.length} blokken`}
                  </span>
                </div>
                <div
                  className="overflow-hidden rounded-2xl shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.04)] ring-1 ring-black/5"
                  data-running={phase === "running" ? "true" : undefined}
                >
                  <ArticleView
                    doc={preview}
                    jobId={job.id}
                    onEdit={doc ? setEdited : undefined}
                  />
                </div>
              </section>
            ) : null
          ) : null}

          {tab === "json" && pakket ? (
            <section className="overflow-hidden rounded-xl bg-black/[0.04]">
              <header className="flex items-center gap-4 px-4 py-2.5">
                <span className="text-sm text-muted-foreground">
                  pakket.json · alleen-lezen
                  {edited ? " · met je correcties" : ""}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  onClick={() => {
                    void navigator.clipboard.writeText(pakketJson).then(() => {
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1500);
                    });
                  }}
                >
                  {copied ? <Check /> : <Copy />}
                  {copied ? "Gekopieerd" : "Kopiëren"}
                </Button>
              </header>
              <pre className="px-4 pb-4 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
                {pakketJson}
              </pre>
            </section>
          ) : null}
          {tab === "checks" ? (
            <Checks
              pages={pageResults}
              images={job?.images ?? []}
              verdicts={verdicts}
            />
          ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

/** Tabs that show something of their own, run or no run. */
const ALWAYS: Tab[] = ["paginas", "artikel", "checks"];

const LABELS: Record<Tab, string> = {
  paginas: "Pagina's",
  artikel: "Artikel",
  json: "JSON",
  checks: "Controle",
};


type Provider = "openai" | "mistral";
type Mode = "artikel" | "magazine";

interface Settings {
  ocrPricePerPage: number;
  currency: string;
  provider: Provider;
  providers: Array<{ id: Provider; label: string; model: string; ready: boolean; limit: number | null }>;
  /** Hoeveel artikelen uit een magazine tegelijk worden omgezet. */
  articleConcurrency?: number;
  /** Of deze installatie naar Sanity kan schrijven, en waarheen. */
  sanity?: { ready: boolean; projectId: string | null; dataset: string | null };
}

const PROVIDER_KEY = "vrhl.provider";

function download(filename: string, content: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/plain;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
