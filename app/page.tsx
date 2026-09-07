"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArticleView } from "@/components/ArticleView";
import { Checks } from "@/components/Checks";
import { Ocr } from "@/components/Ocr";
import { PageThumbs } from "@/components/PageThumbs";
import { Prompts } from "@/components/Prompts";
import { Stream, type PageStream } from "@/components/Stream";
import { renderPdf } from "@/lib/client/render";
import { blankFrontmatter, compileArticle } from "@/lib/compile";
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
type Tab = "stream" | "ocr" | "mdx" | "checks" | "prompts";

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
  const [text, setText] = useState<Record<number, string>>({});
  const [patches, setPatches] = useState<Record<number, Patch[]>>({});
  // What run 2 read off the page. It lands while run 1 is still writing, which
  // is what lets the pane set the words as they arrive.
  const [fragments, setFragments] = useState<Record<number, StyleFragment[]>>({});
  const [results, setResults] = useState<Record<number, PageResult>>({});
  const [running, setRunning] = useState<Record<number, string[]>>({});
  const [frontmatter, setFrontmatter] = useState<Frontmatter | null>(null);
  const [verdicts, setVerdicts] = useState<ImageVerdict[]>([]);
  // How this installation stands by default, and what the optional OCR costs.
  const [settings, setSettings] = useState<Settings | null>(null);
  const [doc, setDoc] = useState<ArticleDocument | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [tab, setTab] = useState<Tab>("stream");
  const input = useRef<HTMLInputElement>(null);

  const accept = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      setNotice("Alleen PDF-bestanden.");
      return;
    }
    setPhase("rendering");
    setNotice(null);
    setStatus([]);
    setText({});
    setPatches({});
    setFragments({});
    setResults({});
    setRunning({});
    setFrontmatter(null);
    setVerdicts([]);
    setDoc(null);
    setThumbs([]);
    setTab("stream");

    try {
      // The page count is only known once pdf.js opens the file, so the job is
      // created while the first page is being rendered.
      let current: Job | null = null;
      await renderPdf(file, async (rendered, total) => {
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
        });
        if (!res.ok)
          throw new Error(`pagina ${rendered.page} kon niet worden opgeslagen`);
        setThumbs((prev) => [...prev, rendered.previewUrl]);
      });
      // The ripped bitmaps are added per page on the server, so pick the job up
      // again once every page has landed.
      if (current) {
        const res = await fetch(`/api/jobs/${(current as Job).id}`);
        if (res.ok) setJob((await res.json()) as Job);
      }
      setPhase("ready");
    } catch (err) {
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
    setText({});
    setPatches({});
    setFragments({});
    setResults({});
    setRunning({});
    setDoc(null);
    setNotice(null);
    setTab("stream");

    try {
      const res = await fetch(`/api/jobs/${job.id}/run`, { method: "POST" });
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

    function handle(event: RunEvent) {
      switch (event.type) {
        case "status":
          setStatus((prev) => [...prev, event]);
          if (event.page != null) {
            setRunning((prev) => {
              const open = new Set(prev[event.page as number] ?? []);
              if (event.state === "start") open.add(event.run);
              else open.delete(event.run);
              return { ...prev, [event.page as number]: [...open] };
            });
          }
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
          // The article is already on screen, at the top of this same tab.
          setStatus((prev) => [
            ...prev,
            {
              run: "klaar",
              state: "ok",
              detail:
                `${event.runs} runs · ${event.tokens} tokens · ${duration(event.ms)}` +
                (event.ocr ? ` · OCR ${event.ocr.calls} calls, ${event.ocr.pages} pagina's` : "") +
                (event.cost ? ` · ${receipt(event.cost)}` : ""),
            },
          ]);
          break;
      }
    }
  }, [job]);

  const streams: PageStream[] = useMemo(() => {
    const numbers = new Set<number>([
      ...Object.keys(text).map(Number),
      ...Object.keys(results).map(Number),
      ...Object.keys(patches).map(Number),
      ...Object.keys(fragments).map(Number),
    ]);
    return [...numbers]
      .sort((a, b) => a - b)
      .map((page) => ({
        page,
        text: text[page] ?? "",
        patches: patches[page] ?? [],
        fragments: fragments[page] ?? [],
        result: results[page],
        running: running[page] ?? [],
      }));
  }, [text, patches, fragments, results, running]);

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
  const preview: ArticleDocument | null = useMemo(() => {
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
  }, [doc, frontmatter, pageResults, results, text, patches, approved, job]);

  return (
    <div className="frame">
      <header className="masthead">
        <h1>Vrhl · Blad Converter</h1>
        <span className="meta">magazine → één verticale kolom</span>
      </header>

      <div className="columns">
        <aside className="rail">
          {notice ? <p className="notice">{notice}</p> : null}

          <span className="label">Bron</span>
          <button
            className="dropzone"
            data-active={dragging}
            disabled={phase === "rendering" || phase === "running"}
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files[0];
              if (file) void accept(file);
            }}
          >
            {job ? job.filename : "Leg hier een PDF neer"}
          </button>
          <input
            ref={input}
            type="file"
            accept="application/pdf"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void accept(file);
            }}
          />

          {job ? (
            <>
              <hr className="rule" />
              <dl className="kv">
                <dt>Pagina&apos;s</dt>
                <dd>{job.pageCount}</dd>
                <dt>Gerenderd</dt>
                <dd>{thumbs.length}</dd>
                <dt>Klaar</dt>
                <dd>{pageResults.length}</dd>
              </dl>
              <PageThumbs thumbs={thumbs} jobId={job.id} pages={job.pages} />
            </>
          ) : null}

          <hr className="rule" />
          <button
            className="action"
            disabled={
              phase !== "ready" && phase !== "done" && phase !== "error"
            }
            onClick={() => void convert()}
          >
            {phase === "running" ? "Bezig…" : "Convert"}
          </button>

          {status.length ? (
            <ul className="log">
              {status.map((line, i) => (
                <li key={i} data-state={line.state}>
                  <span className="mark">
                    {line.state === "start"
                      ? "\u203a"
                      : line.state === "fail"
                        ? "\u00d7"
                        : "\u00b7"}
                  </span>
                  <span>
                    {line.run}
                    {line.page ? (
                      <span className="page"> · p{line.page}</span>
                    ) : null}
                  </span>
                  <span className="detail">{line.detail ?? ""}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </aside>

        <main className="stage">
          <div className="tabs">
            {(
              [
                "stream",
                "ocr",
                "mdx",
                "checks",
                "prompts",
              ] as Tab[]
            ).map((t) => (
              <button
                key={t}
                data-active={tab === t}
                onClick={() => setTab(t)}
                disabled={ALWAYS.includes(t) ? false : t === "ocr" ? !job : !doc}
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
                <button onClick={() => download("artikel.mdx", toMdx(doc))}>
                  Download MDX
                </button>
              </>
            ) : null}
          </div>

          {tab === "stream" ? (
            <>
              {preview && job ? (
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
              ) : null}

              {/* Wat run 1 letterlijk schreef, met zijn eigen blokmarkeringen. Het
                  artikel hierboven laat zien wat daaruit volgde; dit is waar je
                  kijkt als dat niet klopt. Open terwijl het loopt, dicht zodra
                  het klaar is - dan is het artikel het antwoord, niet de bouw. */}
              {streams.length ? (
                <details className="raw" open={phase === "running"}>
                  <summary>
                    Wat de runs schreven
                    <span className="pulse">
                      {streams.length} pagina&apos;s ·{" "}
                      {streams.reduce(
                        (n, p) => n + (p.result?.patches.length ?? p.patches.length),
                        0,
                      )}{" "}
                      opmaak
                    </span>
                  </summary>
                  <Stream pages={streams} />
                </details>
              ) : null}
              {!streams.length && !frontmatter ? (
                <p className="empty">{BLURB}</p>
              ) : null}
            </>
          ) : null}

          {tab === "ocr" ? <Ocr jobId={job?.id ?? null} /> : null}
          {tab === "mdx" && doc ? (
            <pre className="json">{toMdx(doc)}</pre>
          ) : null}
          {tab === "checks" ? (
            <Checks
              pages={pageResults}
              images={job?.images ?? []}
              verdicts={verdicts}
            />
          ) : null}
          {tab === "prompts" ? <Prompts /> : null}
        </main>
      </div>
    </div>
  );
}

/** Tabs that show something of their own, run or no run. */
const ALWAYS: Tab[] = ["stream", "checks", "prompts"];

const LABELS: Record<Tab, string> = {
  stream: "Artikel",
  ocr: "OCR",
  mdx: "MDX",
  checks: "Controle",
  prompts: "Prompts",
};

const BLURB =
  "Per pagina schrijft één run de tekst uit in leesvolgorde. Wat vet of cursief staat komt niet uit een model maar uit het fontregister van de PDF zelf — deterministisch, en dus elke keer hetzelfde. Alleen een pagina zonder tekstlaag, een scan of een advertentie, wordt alsnog bekeken. Een woordindex uit de OCR kijkt alles na.";

interface Settings {
  ocrPricePerPage: number;
  currency: string;
}

/** The bill, split so it can be checked against the providers' own pricing. */
function receipt(cost: {
  ai: number;
  ocr: number;
  total: number;
  currency: string;
}): string {
  return `${money(cost.total, cost.currency)} (${money(cost.ai, cost.currency)} model + ${money(
    cost.ocr,
    cost.currency,
  )} OCR)`;
}

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
