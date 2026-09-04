"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { ArticleView } from "@/components/ArticleView";
import { Checks } from "@/components/Checks";
import { Prompts } from "@/components/Prompts";
import { Stream, type PageStream } from "@/components/Stream";
import { renderPdf } from "@/lib/client/render";
import { toMarkdown } from "@/lib/export";
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
type Tab = "stream" | "article" | "markdown" | "json" | "checks" | "prompts";

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
  const [results, setResults] = useState<Record<number, PageResult>>({});
  const [running, setRunning] = useState<Record<number, string[]>>({});
  const [frontmatter, setFrontmatter] = useState<Frontmatter | null>(null);
  const [verdicts, setVerdicts] = useState<ImageVerdict[]>([]);
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

  const convert = useCallback(async () => {
    if (!job) return;
    setPhase("running");
    setStatus([]);
    setText({});
    setPatches({});
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
          setTab("article");
          setStatus((prev) => [
            ...prev,
            {
              run: "klaar",
              state: "ok",
              detail: `${event.runs} runs · ${event.tokens} tokens`,
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
    ]);
    return [...numbers]
      .sort((a, b) => a - b)
      .map((page) => ({
        page,
        text: text[page] ?? "",
        patches: patches[page] ?? [],
        result: results[page],
        running: running[page] ?? [],
      }));
  }, [text, patches, results, running]);

  const pageResults = useMemo(
    () => Object.values(results).sort((a, b) => a.page - b.page),
    [results],
  );

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
              {thumbs.length ? (
                <div className="thumbs" style={{ marginTop: "1rem" }}>
                  {thumbs.map((src, i) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={i} src={src} alt={`pagina ${i + 1}`} />
                  ))}
                </div>
              ) : null}
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
                "article",
                "markdown",
                "json",
                "checks",
                "prompts",
              ] as Tab[]
            ).map((t) => (
              <button
                key={t}
                data-active={tab === t}
                onClick={() => setTab(t)}
                disabled={t !== "stream" && t !== "prompts" && t !== "checks" && !doc}
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
                <button onClick={() => download("artikel.md", toMarkdown(doc))}>
                  Download MD
                </button>
              </>
            ) : null}
          </div>

          {tab === "stream" ? (
            <>
              {frontmatter ? (
                <dl className="kv frontmatter">
                  <dt>Chapeau</dt>
                  <dd>{frontmatter.chapeau ?? "geen"}</dd>
                  <dt>Titel</dt>
                  <dd>{frontmatter.title ?? "geen"}</dd>
                  <dt>Ondertitel</dt>
                  <dd>{frontmatter.subtitle ?? "geen"}</dd>
                  <dt>Auteur</dt>
                  <dd>{frontmatter.authors.join(", ") || "geen"}</dd>
                  <dt>Fotograaf</dt>
                  <dd>{frontmatter.photographers.join(", ") || "geen"}</dd>
                  <dt>Illustrator</dt>
                  <dd>{frontmatter.illustrators.join(", ") || "geen"}</dd>
                  <dt>Datum</dt>
                  <dd>{frontmatter.date ?? "geen"}</dd>
                  <dt>Intro</dt>
                  <dd>{frontmatter.intro ?? "geen"}</dd>
                </dl>
              ) : null}
              <Stream pages={streams} />
              {!streams.length && !frontmatter ? (
                <p className="empty">{BLURB}</p>
              ) : null}
            </>
          ) : null}

          {tab === "article" && doc && job ? (
            <ArticleView doc={doc} jobId={job.id} />
          ) : null}
          {tab === "markdown" && doc ? (
            <pre className="json">{toMarkdown(doc)}</pre>
          ) : null}
          {tab === "json" && doc ? (
            <pre className="json">{JSON.stringify(doc, null, 2)}</pre>
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

const LABELS: Record<Tab, string> = {
  stream: "Live",
  article: "Artikel",
  markdown: "Markdown",
  json: "JSON",
  checks: "Controle",
  prompts: "Prompts",
};

const BLURB =
  "Per pagina schrijft één run de tekst uit in leesvolgorde. Alle andere runs kijken naar diezelfde tekst en leveren alleen patches: een stukje styling, een tussenkop, een quote met zijn plek. Die patches worden deterministisch toegepast, dus de runs kunnen tegelijk draaien zonder elkaar in de weg te zitten.";

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
