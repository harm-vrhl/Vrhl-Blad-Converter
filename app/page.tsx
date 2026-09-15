"use client";

import { useEffect, useState } from "react";
import { Check, Copy, RotateCcw } from "lucide-react";
import { ArticleView } from "@/components/ArticleView";
import { AppHeader } from "@/components/article/AppHeader";
import { ExportToolbar } from "@/components/article/ExportToolbar";
import { StartScreen } from "@/components/article/StartScreen";
import { useArticleRun, type Tab } from "@/components/article/useArticleRun";
import { useExports } from "@/components/article/useExports";
import { useSettings } from "@/components/article/useSettings";
import { useSidebar } from "@/components/article/useSidebar";
import { WorkflowSidebar } from "@/components/article/WorkflowSidebar";
import { Checks } from "@/components/Checks";
import { MagazineView } from "@/components/MagazineView";
import { PageThumbs } from "@/components/PageThumbs";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export default function Home() {
  /** Even "Gekopieerd" naast de JSON, daarna weer de knop. */
  const [copied, setCopied] = useState(false);
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


  const { packing, pushing, downloadPackage, pushSanity, pakket, pakketJson } = useExports({ job, current, setNotice });

  const idle = !job && phase !== "rendering";
  const workspace = !showMagazine && !(idle || (phase === "rendering" && !job));
  const noticeOk = !!notice && notice.startsWith("Naar Sanity");

  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <AppHeader
        workspace={workspace}
        sidebarOpen={sidebarOpen}
        toggleSidebar={toggleSidebar}
        mode={mode}
        view={view}
        setView={setView}
        job={job}
        showMagazine={showMagazine}
        uploadDisabled={uploadDisabled}
        closeJob={closeJob}
        phase={phase}
        renderStep={renderStep}
        thumbs={thumbs}
        settings={settings}
        provider={provider}
        setProvider={setProvider}
        converting={converting}
        convert={convert}
      />

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
        <StartScreen
          mode={mode}
          modeSwitch={modeSwitch}
          notice={notice}
          noticeOk={noticeOk}
          phase={phase}
          dragging={dragging}
          setDragging={setDragging}
          accept={accept}
          renderStep={renderStep}
          earlier={earlier}
          storage={storage}
          openJob={openJob}
          refreshEarlier={refreshEarlier}
        />
      ) : (
        <div className="relative flex min-h-0 flex-1">
          <WorkflowSidebar
            sidebarOpen={sidebarOpen}
            setSidebarOpen={setSidebarOpen}
            narrow={narrow}
            sidebarAnimates={sidebarAnimates}
            steps={steps}
            totals={totals}
            phase={phase}
            thumbs={thumbs}
            job={job}
            frontmatter={frontmatter}
            verdicts={verdicts}
            text={text}
          />

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
                <ExportToolbar
                  pakket={pakket}
                  pakketJson={pakketJson}
                  packing={packing}
                  downloadPackage={downloadPackage}
                  pushing={pushing}
                  pushSanity={pushSanity}
                  settings={settings}
                />
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

