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
  PanelLeftClose,
  PanelLeftOpen,
  RotateCcw,
  UploadCloud,
} from "lucide-react";
import { ArticleView } from "@/components/ArticleView";
import { Earlier } from "@/components/article/Earlier";
import { useArticleRun, type Tab } from "@/components/article/useArticleRun";
import { PROVIDER_KEY, useSettings } from "@/components/article/useSettings";
import { useSidebar } from "@/components/article/useSidebar";
import { Checks } from "@/components/Checks";
import { Logo } from "@/components/Logo";
import { MagazineView } from "@/components/MagazineView";
import { PageThumbs } from "@/components/PageThumbs";
import { ProviderSwitch } from "@/components/ProviderSwitch";
import { QuietToolbar, ToolbarButton, ToolbarRule } from "@/components/QuietToolbar";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Workflow } from "@/components/Workflow";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
// Geen Tooltip hier met opzet: de hints bij de schakelaar en de Sanity-knop zijn
// juist nodig als die knoppen uit staan, en een tooltip krijgt op een disabled
// element geen pointer-events. Het native title-attribuut wel.
import { deleteOwner } from "@/lib/client/db";
import { packageZip, pushToSanity } from "@/lib/client/exports";
import { toPackage } from "@/lib/canonical";
import { toMdx } from "@/lib/mdx";
import { errorMessage } from "@/lib/util";

export default function Home() {
  /** Even "Gekopieerd" naast de JSON, daarna weer de knop. */
  const [copied, setCopied] = useState(false);
  /** Het inpakken van het canonieke pakket leest al het beeld uit de opslag. */
  const [packing, setPacking] = useState(false);
  /** Het duwen naar Sanity, dat eerst het beeld één voor één uploadt. */
  const [pushing, setPushing] = useState<{ done: number; total: number } | null>(null);
  const [dragging, setDragging] = useState(false);
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
  const { settings, provider, setProvider, setSettings } = useSettings();
  const { sidebarOpen, setSidebarOpen, narrow, sidebarAnimates, toggleSidebar } = useSidebar();
  const {
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
  } = useArticleRun({ provider, setSettings, setProvider, setView });
  const uploadDisabled = phase === "rendering" || phase === "running" || converting;
  const showMagazine = mode === "magazine" && view === "magazine";

  // Een run leeft in dit tabblad. Wie het sluit, stopt hem; dat mag niet per ongeluk.
  useEffect(() => {
    if (phase !== "running" && phase !== "rendering" && !converting) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [phase, converting]);

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
   * Wat in de Artikel-tab is rechtgezet gaat mee: het artikel zoals het nu op
   * het scherm staat, niet zoals de run het achterliet. Het inpakken gebeurt in
   * de browser, want daar staat het beeld.
   */
  const downloadPackage = useCallback(async () => {
    if (!job || !current) return;
    setPacking(true);
    setNotice(null);
    try {
      const { blob, name } = await packageZip(job, current);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setNotice(
        `Het pakket kon niet worden gemaakt: ${errorMessage(err)}`,
      );
    } finally {
      setPacking(false);
    }
  }, [job, current]);

  /**
   * Het artikel naar Sanity, als concept.
   *
   * Wat hier weggaat is het pakket, niet het artikelobject: de importer leest
   * hetzelfde formaat dat ook naar MDX of Word gaat, met de correcties erin. De
   * browser stuurt het beeld één voor één; het schrijven zelf gebeurt op de
   * server, want het token hoort de browser nooit te zien.
   */
  const pushSanity = useCallback(async () => {
    if (!job || !current) return;
    setPushing({ done: 0, total: 0 });
    setNotice(null);
    try {
      const body = await pushToSanity(job, current, (done, total) => setPushing({ done, total }));

      const deel = [
        `${body.documents.length} document(en) als concept weggeschreven`,
        body.uploaded ? `${body.uploaded} afbeelding(en) geupload` : null,
        body.created.length ? `nieuw aangemaakt: ${body.created.join(", ")}` : null,
      ].filter(Boolean);
      setNotice(
        `Naar Sanity: ${deel.join(" · ")}.${
          body.warnings.length ? ` Let op: ${body.warnings.join(" · ")}` : ""
        }`,
      );
    } catch (err) {
      setNotice(
        `Het duwen naar Sanity is niet gelukt: ${errorMessage(err)}`,
      );
    } finally {
      setPushing(null);
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

  const idle = !job && phase !== "rendering";
  const workspace = !showMagazine && !(idle || (phase === "rendering" && !job));
  const noticeOk = !!notice && notice.startsWith("Naar Sanity");

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <header className="z-20 shrink-0 border-b bg-white/80 backdrop-blur-md">
        <div className="flex h-14 items-center justify-between gap-4 px-6">
          <div className="flex items-center gap-3">
            <h1 className="flex">
              <Logo className="h-8" />
            </h1>
            {workspace ? (
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:text-foreground"
                aria-controls="workflow-sidebar"
                aria-expanded={sidebarOpen}
                aria-label={sidebarOpen ? "Zijbalk inklappen" : "Zijbalk openen"}
                title={sidebarOpen ? "Zijbalk inklappen" : "Zijbalk openen"}
                onClick={toggleSidebar}
              >
                {sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
              </Button>
            ) : null}
          </div>
          <div className="flex min-w-0 items-center justify-end gap-2">
            {mode === "magazine" && view === "artikel" ? (
              <Button variant="ghost" size="sm" onClick={() => setView("magazine")}>
                <ArrowLeft />
                Magazine
              </Button>
            ) : null}
            {job && !showMagazine && mode === "artikel" ? (
              <Button variant="ghost" size="sm" disabled={uploadDisabled} onClick={closeJob}>
                <ArrowLeft />
                Overzicht
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
            {job && !showMagazine && phase !== "running" && (job.status === "running" || job.status === "error") && job.pages.length >= job.pageCount ? (
              <Button
                variant="outline"
                disabled={converting}
                title="Wat al klaar was, wordt niet opnieuw betaald"
                onClick={() => void convert(true)}
              >
                Verder waar het stopte
              </Button>
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
        // Scrollt zelf: met de lijst eronder past het startscherm niet altijd, en de
        // pagina als geheel scrollt niet.
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto flex min-h-full w-full max-w-xl flex-col items-center justify-center px-6 py-16">
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
          {earlier?.length && phase !== "rendering" ? (
            <Earlier
              jobs={earlier}
              storage={storage}
              onOpen={(id) => void openJob(id)}
              onDelete={async (id) => {
                await deleteOwner(id);
                await refreshEarlier();
              }}
            />
          ) : null}
        </div>
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1">
          {/* De ruimte die het eiland inneemt. Die groeit en krimpt, zodat het
              werkgebied gelijkmatig meeschuift; het eiland zelf houdt zijn breedte
              en schuift alleen, dus de inhoud ervan loopt niet opnieuw af. */}
          <div
            aria-hidden
            className={cn(
              "shrink-0",
              sidebarAnimates &&
                "transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
            )}
            style={{ width: sidebarOpen && !narrow ? "calc(24rem + 1.5rem)" : 0 }}
          />
          {narrow && sidebarOpen ? (
            <button
              type="button"
              aria-label="Zijbalk sluiten"
              className="absolute inset-0 z-20 cursor-default bg-black/10 backdrop-blur-[1px]"
              onClick={() => setSidebarOpen(false)}
            />
          ) : null}
          <aside
            id="workflow-sidebar"
            aria-label="Omzetten"
            inert={!sidebarOpen}
            className={cn(
              "absolute inset-y-3 left-3 z-30 flex w-96 max-w-[calc(100%-1.5rem)] flex-col overflow-hidden rounded-2xl border border-[var(--sidebar-border)] bg-[var(--sidebar)] shadow-[0_1px_2px_rgba(0,0,0,0.04),0_12px_32px_-8px_rgba(0,0,0,0.12)]",
              sidebarAnimates &&
                "transition-[translate,opacity] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
              sidebarOpen ? "translate-x-0 opacity-100" : "-translate-x-[calc(100%+1.5rem)] opacity-0",
            )}
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
                    disabled={!!pushing || !settings?.sanity?.ready}
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
                    {pushing
                      ? pushing.total && pushing.done < pushing.total
                        ? `Beeld ${pushing.done + 1}/${pushing.total}`
                        : "Versturen…"
                      : "Sanity"}
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

type Mode = "artikel" | "magazine";

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
