"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArticleView } from "@/components/ArticleView";
import { Checks } from "@/components/Checks";
import { PageThumbs } from "@/components/PageThumbs";
import { renderPdf, type RenderStep } from "@/lib/client/render";
import { blankFrontmatter, compileArticle } from "@/lib/compile";
import { toPackage } from "@/lib/canonical";
import { toMdx } from "@/lib/mdx";
import { fromMdx } from "@/lib/frommdx";
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
type Tab = "paginas" | "artikel" | "mdx" | "checks";

interface Step {
  key: string;
  label: string;
  state: "wacht" | "bezig" | "klaar" | "fout";
  detail: string;
}

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
   * De MDX zoals iemand hem heeft bijgewerkt, of null zolang niemand iets deed.
   * Null en "gelijk aan wat de AI schreef" zijn niet hetzelfde: alleen dat eerste
   * betekent dat er niets te herstellen valt.
   */
  const [mdxEdit, setMdxEdit] = useState<string | null>(null);
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
  const uploadDisabled = phase === "rendering" || phase === "running";

  const accept = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setNotice("Alleen PDF-bestanden.");
      return;
    }
    setPhase("rendering");
    setNotice(null);
    setStatus([]);
    setTotals(null);
    setMdxEdit(null);
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
      // The page count is only known once pdf.js opens the file, so the job is
      // created while the first page is being rendered.
      let current: Job | null = null;
      await renderPdf(
        file,
        async (rendered, total) => {
        if (!current) {
          const form = new FormData();
          form.set("file", file);
          form.set("pageCount", String(total));
          const res = await fetch("/api/jobs", { method: "POST", body: form });
          const body = (await res.json()) as {
            job: Job;
            missingKeys: string[];
            error?: string;
          };
          if (!res.ok) throw new Error(body.error ?? "upload mislukt");
          current = body.job;
          setJob(body.job);
          if (body.missingKeys.length)
            setNotice(
              `Ontbrekende sleutels in .env.local: ${body.missingKeys.join(", ")}`,
            );
        }
        setRenderStep({ page: rendered.page, total, step: "uploaden" });
        const form = new FormData();
        form.set("page", String(rendered.page));
        form.set("width", String(rendered.width));
        form.set("height", String(rendered.height));
        form.set("image", rendered.image, `page-${rendered.page}.jpeg`);
        form.set("thumb", rendered.thumb, `thumb-${rendered.page}.jpeg`);
        // The bitmaps ripped out of this page travel with it.
        form.set(
          "ripped",
          JSON.stringify(
            rendered.ripped.map((r) => ({
              width: r.width,
              height: r.height,
              placed: r.placed,
              areaPct: r.areaPct,
              dpi: r.dpi,
              mime: r.mime,
            })),
          ),
        );
        // The PDF's own record of what is bold and what is italic.
        form.set("styling", JSON.stringify(rendered.styling));
        form.set("typography", rendered.typography);
        form.set("words", JSON.stringify(rendered.words));
        rendered.tiles.forEach((tile, i) => {
          form.set(`tile${i}`, tile, `tile-${i}.jpeg`);
        });
        rendered.ripped.forEach((r, i) => {
          const ext = r.mime === "image/png" ? "png" : "jpeg";
          form.set(`rip${i}`, r.full, `rip-${i}.${ext}`);
          form.set(`ripThumb${i}`, r.thumb, `rip-${i}-thumb.${ext}`);
        });
        const res = await fetch(`/api/jobs/${current.id}/pages`, {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok)
          throw new Error(`pagina ${rendered.page} kon niet worden opgeslagen`);
        setThumbs((prev) => [...prev, rendered.previewUrl]);
      },
        (page, total, step) => setRenderStep({ page, total, step }),
      );
      // The ripped bitmaps are added per page on the server, so pick the job up
      // again once every page has landed.
      if (current) {
        const res = await fetch(`/api/jobs/${(current as Job).id}`);
        if (res.ok) setJob((await res.json()) as Job);
      }
      setRenderStep(null);
      setPhase("ready");
    } catch (err) {
      setRenderStep(null);
      setNotice(err instanceof Error ? err.message : String(err));
      setPhase("error");
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

  const convert = useCallback(async () => {
    if (!job) return;
    setPhase("running");
    setStatus([]);
    setTotals(null);
    setMdxEdit(null);
    setText({});
    setPatches({});
    setFragments({});
    setResults({});
    setDoc(null);
    setNotice(null);
    setTab("artikel");

    try {
      const res = await fetch(`/api/jobs/${job.id}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      if (!res.body) throw new Error("geen stream ontvangen");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          const line = chunk.replace(/^data: ?/, "").trim();
          if (line) handle(JSON.parse(line) as RunEvent);
        }
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
      setPhase("error");
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
  }, [job, provider]);


  /**
   * Het artikel als Vrhl Content Package: pakket.json plus het beeld, in een ZIP.
   *
   * Wat in de MDX is bijgewerkt gaat mee. De server kent alleen wat de run heeft
   * opgeslagen, dus het artikel zoals het nu op het scherm staat reist mee in de
   * body; anders levert de knop iets anders af dan je ziet.
   */
  const downloadPackage = useCallback(async () => {
    if (!job || !doc) return;
    setPacking(true);
    setNotice(null);
    try {
      let current = doc;
      if (mdxEdit !== null) {
        try {
          current = fromMdx(mdxEdit, doc, job.images ?? []);
        } catch {
          current = doc; // halfgetypte MDX is geen reden om niets te leveren
        }
      }
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
  }, [job, doc, mdxEdit]);

  /**
   * Het artikel naar Sanity, als concept.
   *
   * Wat hier weggaat is het pakket, niet het artikelobject: de importer leest
   * hetzelfde formaat dat ook naar MDX of Word gaat. Het schrijven zelf gebeurt
   * op de server, want het token hoort de browser nooit te zien.
   */
  const pushSanity = useCallback(async () => {
    if (!job || !doc) return;
    setPushing(true);
    setNotice(null);
    try {
      let current = doc;
      if (mdxEdit !== null) {
        try {
          current = fromMdx(mdxEdit, doc, job.images ?? []);
        } catch {
          current = doc;
        }
      }
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
  }, [job, doc, mdxEdit]);

  /**
   * Het canonieke pakket, en de MDX die eruit volgt.
   *
   * De MDX komt niet meer rechtstreeks uit het artikelobject maar uit het
   * pakket, zodat er één bron is waar elke vertaalslag uit leest. Wat je in de
   * MDX-tab ziet is dus letterlijk wat er in het pakket staat.
   */
  const pakket = useMemo(
    () => (doc ? toPackage(doc, { images: job?.images ?? [] }) : null),
    [doc, job],
  );
  const mdx = useMemo(() => (pakket ? toMdx(pakket) : ""), [pakket]);

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

    const stage = (key: string, label: string, run: string, detail?: string): Step => {
      const seen = last(run);
      if (!seen) return { key, label, state: "wacht", detail: "" };
      return {
        key,
        label,
        state: seen.state === "fail" ? "fout" : seen.state === "ok" ? "klaar" : "bezig",
        detail: detail ?? seen.detail ?? "",
      };
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
        state: failed ? "fout" : done ? "klaar" : busy ? "bezig" : "wacht",
        detail: failed
          ? (failed.detail ?? "mislukt")
          : done
            ? `${done.blocks.length} blokken · ${done.patches.length} opmaak`
            : busy
              ? BUSY[busy.run] ?? busy.run
              : "",
      });
    }

    out.push(stage("klaar", "Samenvoegen", "compileren"));
    return out;
  }, [status, results, job]);

  const preview: ArticleDocument | null = useMemo(() => {
    if (doc && mdxEdit !== null) {
      // Halfgetypte MDX is geen reden om het artikel te laten verdwijnen; wat er
      // nog niet van te lezen valt, blijft even staan zoals het stond.
      try {
        return fromMdx(mdxEdit, doc, job?.images ?? []);
      } catch {
        return doc;
      }
    }
    if (doc) return doc;

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
  }, [doc, mdxEdit, frontmatter, pageResults, results, text, patches, fragments, approved, job]);

  const idle = !job && phase !== "rendering";

  return (
    <div className="frame">
      <header className="masthead">
        <h1>Vrhl · Blad Converter</h1>
        {job ? (
          <div className="mast-actions">
            <span className="mast-meta">
              {job.filename}
              {" · "}
              {phase === "rendering"
                ? renderStep
                  ? `${renderStep.page}/${renderStep.total} · ${renderStep.step}`
                  : `${thumbs.length}/${job.pageCount} klaar`
                : `${job.pageCount} pagina's`}
            </span>
            <label
              className="quiet"
              htmlFor={uploadDisabled ? undefined : "pdf-upload"}
              aria-disabled={uploadDisabled}
            >
              Andere PDF
            </label>
            {settings ? (
              <div className="provider" role="radiogroup" aria-label="Taalmodel">
                {settings.providers.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={provider === p.id}
                    data-active={provider === p.id}
                    disabled={!p.ready || p.limit === 0 || phase === "running"}
                    title={
                      !p.ready
                        ? `geen sleutel voor ${p.label}`
                        : p.limit === 0
                          ? `${p.label} staat op 0 requests per minuut; zet een limiet aan op admin.mistral.ai/plateforme/limits`
                          : p.limit
                            ? `${p.model} · ${p.limit} requests per minuut`
                            : p.model
                    }
                    onClick={() => {
                      setProvider(p.id);
                      try {
                        window.localStorage.setItem(PROVIDER_KEY, p.id);
                      } catch {
                        /* a remembered choice is a convenience, not a need */
                      }
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            ) : null}
            <button
              className="action"
              disabled={
                phase !== "ready" && phase !== "done" && phase !== "error"
              }
              onClick={() => void convert()}
            >
              {phase === "running" ? "Bezig…" : "Convert"}
            </button>
          </div>
        ) : null}
      </header>

      <input
        id="pdf-upload"
        className="file-input"
        type="file"
        disabled={uploadDisabled}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void accept(file);
          e.target.value = "";
        }}
      />

      {notice ? <p className="notice">{notice}</p> : null}

      {idle || (phase === "rendering" && !job) ? (
        <div
          className="landing"
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
        >
          <label
            className="dropzone"
            htmlFor={phase === "rendering" ? undefined : "pdf-upload"}
            data-active={dragging}
            aria-disabled={phase === "rendering"}
          >
            {phase === "rendering"
              ? "Pagina's renderen…"
              : "Leg hier een PDF neer"}
          </label>
        </div>
      ) : (
        <div className="work">
          {status.length ? (
            <ol className="steps">
              {steps.map((step) => (
                <li key={step.key} data-state={step.state}>
                  <span className="dot" aria-hidden />
                  <span className="what">{step.label}</span>
                  <span className="how">{step.detail}</span>
                </li>
              ))}
            </ol>
          ) : null}

          {totals ? (
            <dl className="kv total">
              <dt>Tijd</dt>
              <dd>{duration(totals.ms)}</dd>
              <dt>Tokens</dt>
              <dd>
                {totals.tokens.toLocaleString("nl-NL")}
                <span className="aside"> in {totals.runs} runs</span>
              </dd>
              {totals.cost ? (
                <>
                  <dt>Kosten</dt>
                  <dd>
                    {money(totals.cost.total, totals.cost.currency)}
                    <span className="aside">
                      {" "}
                      {money(totals.cost.ai, totals.cost.currency)} model +{" "}
                      {money(totals.cost.ocr, totals.cost.currency)} OCR
                    </span>
                  </dd>
                </>
              ) : null}
            </dl>
          ) : null}

          {status.length || totals || phase === "running" || phase === "done" ? (
            <div className="tabs">
              {(["paginas", "artikel", "mdx", "checks"] as Tab[]).map((t) => (
                <button
                  key={t}
                  data-active={tab === t}
                  onClick={() => setTab(t)}
                  disabled={ALWAYS.includes(t) ? false : !doc}
                >
                  {LABELS[t]}
                </button>
              ))}
              <span style={{ flex: 1 }} />
              {doc ? (
                <>
                  <button
                    onClick={() =>
                      download("artikel.json", JSON.stringify(doc, null, 2))
                    }
                  >
                    Download JSON
                  </button>
                  <button onClick={() => download("artikel.mdx", mdxEdit ?? mdx)}>
                    Download MDX
                  </button>
                  <button
                    className="action"
                    disabled={packing}
                    onClick={() => void downloadPackage()}
                  >
                    {packing ? "Inpakken…" : "Download pakket"}
                  </button>
                  <button
                    className="action"
                    disabled={pushing || !settings?.sanity?.ready}
                    title={
                      settings?.sanity?.ready
                        ? `Als concept naar ${settings.sanity.projectId} · ${settings.sanity.dataset}`
                        : "Vul NEXT_PUBLIC_SANITY_PROJECT_ID, NEXT_PUBLIC_SANITY_DATASET en SANITY_API_TOKEN in .env.local"
                    }
                    onClick={() => void pushSanity()}
                  >
                    {pushing ? "Versturen…" : "Push naar Sanity"}
                  </button>
                </>
              ) : null}
            </div>
          ) : null}

          {(tab === "paginas" || !status.length) && job ? (
            <PageThumbs
              thumbs={thumbs}
              jobId={job.id}
              pages={job.pages}
              pageCount={job.pageCount}
            />
          ) : null}

          {tab === "artikel" ? (
            preview && job ? (
              <section className="pane preview" data-running={phase === "running"}>
                <header>
                  <span className="label">Artikel</span>
                  <span className="pulse">
                    {phase === "running"
                      ? `${pageResults.length}/${job.pageCount} pagina's`
                      : `${preview.content.length} blokken`}
                  </span>
                </header>
                <ArticleView doc={preview} jobId={job.id} />
              </section>
            ) : null
          ) : null}

          {tab === "mdx" && doc ? (
            <section className="editor">
              <header>
                <span className="label">
                  MDX{mdxEdit !== null ? " · bijgewerkt" : ""}
                </span>
                {mdxEdit !== null ? (
                  <button className="link" onClick={() => setMdxEdit(null)}>
                    Terug naar wat de AI schreef
                  </button>
                ) : null}
              </header>
              <textarea
                className="json"
                spellCheck={false}
                value={mdxEdit ?? mdx}
                onChange={(e) => setMdxEdit(e.target.value)}
              />
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
      )}
    </div>
  );
}

/** Tabs that show something of their own, run or no run. */
const ALWAYS: Tab[] = ["paginas", "artikel", "checks"];

const LABELS: Record<Tab, string> = {
  paginas: "Pagina's",
  artikel: "Artikel",
  mdx: "MDX",
  checks: "Controle",
};


type Provider = "openai" | "mistral";

interface Settings {
  ocrPricePerPage: number;
  currency: string;
  provider: Provider;
  providers: Array<{ id: Provider; label: string; model: string; ready: boolean; limit: number | null }>;
  /** Of deze installatie naar Sanity kan schrijven, en waarheen. */
  sanity?: { ready: boolean; projectId: string | null; dataset: string | null };
}

const PROVIDER_KEY = "vrhl.provider";

/** An amount, in the notation the rest of the interface uses. */
function money(amount: number, currency = "USD"): string {
  return `${currency} ${amount
    .toFixed(amount < 0.1 ? 4 : amount < 1 ? 3 : 2)
    .replace(".", ",")}`;
}

/** How long the run took, in the shortest form that still reads. */
function duration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1).replace(".", ",")} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return rest ? `${minutes} m ${rest} s` : `${minutes} m`;
}

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
