"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, RotateCcw } from "lucide-react";
import { ArticleView } from "@/components/ArticleView";
import { AppHeader } from "@/components/article/AppHeader";
import { ExportToolbar } from "@/components/article/ExportToolbar";
import { StartScreen } from "@/components/article/StartScreen";
import { useArticleRun, type Tab } from "@/components/article/useArticleRun";
import { useExports } from "@/components/article/useExports";
import { useSettings } from "@/components/article/useSettings";
import { useSidebar } from "@/components/article/useSidebar";
import { isPakketJob } from "@/lib/client/import";
import { STUDIO, STUDIO_GELUKT } from "@/lib/studio";
import { useControle } from "@/components/article/useControle";
import { UitlegKnop } from "@/components/article/Uitleg";
import { Zoekbalk } from "@/components/article/Zoekbalk";
import { naarPlek, naarZoek } from "@/components/article/naarPlek";
import { WorkflowSidebar } from "@/components/article/WorkflowSidebar";
import { Checks } from "@/components/Checks";
import { MagazineView } from "@/components/MagazineView";
import { PageThumbs } from "@/components/PageThumbs";
import { SegmentedControl } from "@/components/SegmentedControl";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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
  const uploadDisabled = phase === "rendering" || phase === "importing" || phase === "running" || converting;
  const showMagazine = mode === "magazine" && view === "magazine";

  // Een run leeft in dit tabblad. Wie het sluit, stopt hem; dat mag niet per ongeluk.
  useEffect(() => {
    if (phase !== "running" && phase !== "rendering" && phase !== "importing" && !converting) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [phase, converting]);

  const modeSwitch = (
    <div data-tour="mode">
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
    </div>
  );


  const { exporting, pushing, exportAs, pushSanity, pakket, pakketJson } = useExports({ job, current, setNotice });
  const controle = useControle({ job, current, pageResults, verdicts });
  /** Het vangnet voor Vrhl-Blad-Studio: open als er nog iets openstaat in de Controle-tab. */
  const [vangnet, setVangnet] = useState(false);
  const open = controle.oordeel.oplossen + controle.oordeel.nakijken;

  /**
   * Naar Vrhl-Blad-Studio, maar niet ongemerkt met een artikel waar nog iets aan
   * schort. Downloads vragen dit niet: die zijn niet definitief, versturen naar het
   * CMS wel een stap verder.
   */
  const verstuur = async () => {
    if (controle.oordeel.stand !== "klaar") {
      setVangnet(true);
      return;
    }
    await pushSanity();
  };

  const springNaar = async (zoek: string, markeer?: string, nth?: number) => {
    setTab("artikel");
    const gevonden = await naarPlek(zoek, markeer, nth);
    if (!gevonden) {
      setNotice("Deze plek is niet meer te vinden in het artikel. Misschien is de tekst al aangepast.");
    }
  };

  const springZoek = useCallback(
    (query: string, index: number, flits: boolean) => {
      setTab("artikel");
      void naarZoek(query, index, flits);
    },
    [setTab]
  );

  const idle = !job && phase !== "rendering" && phase !== "importing";
  const workspace = !showMagazine && !(idle || ((phase === "rendering" || phase === "importing") && !job));
  const noticeOk = !!notice && notice.startsWith(STUDIO_GELUKT);

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
        uitleg={
          <UitlegKnop
            auto={idle && earlier !== null && earlier.length === 0}
            openSidebar={() => setSidebarOpen(true)}
            naarArtikel={() => setTab("artikel")}
          />
        }
        zoek={
          !showMagazine && preview && job ? (
            <Zoekbalk key={job.id} doc={preview} onSpring={springZoek} />
          ) : null
        }
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
      <input
        id="pakket-upload"
        className="sr-only"
        type="file"
        accept=".blad,.zip,application/zip"
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

      {showMagazine ? null : idle || ((phase === "rendering" || phase === "importing") && !job) ? (
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
              <div data-tour="tabs">
                <SegmentedControl
                  aria-label="Weergave"
                  value={tab}
                  onChange={(next) => setTab(next)}
                  options={(job && isPakketJob(job) && !job.pages.length
                    ? (["artikel", "json", "checks"] as Tab[])
                    : (["paginas", "artikel", "json", "checks"] as Tab[])
                  ).map((t) => ({
                    id: t,
                    label:
                      t === "checks" && doc ? (
                        <span className="inline-flex items-center gap-1.5">
                          {LABELS[t]}
                          <TellerControle stand={controle.oordeel.stand} open={open} />
                        </span>
                      ) : (
                        LABELS[t]
                      ),
                    disabled: ALWAYS.includes(t) ? false : !doc,
                  }))}
                />
              </div>
              <span className="flex-1" />
              {doc ? (
                <ExportToolbar
                  ready={!!pakket}
                  exporting={exporting}
                  exportAs={exportAs}
                  pushing={pushing}
                  pushSanity={verstuur}
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
                        Terug naar {isPakketJob(job) ? "het pakket" : "AI-resultaat"}
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
                  data-tour="artikel"
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
              owner={job?.id}
              pages={pageResults}
              images={job?.images ?? []}
              verdicts={verdicts}
              bevindingen={controle.bevindingen}
              oordeel={controle.oordeel}
              overeenkomst={controle.overeenkomst}
              nagekeken={controle.nagekeken}
              ocrBeschikbaar={controle.ocrBeschikbaar}
              ocr={controle.ocr}
              onToggle={controle.toggle}
              onNaarPlek={(zoek, markeer, nth) => void springNaar(zoek, markeer, nth)}
              current={current}
            />
          ) : null}

          <Dialog open={vangnet} onOpenChange={setVangnet}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>
                  {controle.oordeel.stand === "oplossen" ? "Dit artikel is nog niet klaar" : "Nog niet alles is nagekeken"}
                </DialogTitle>
                <DialogDescription>
                  {vangnetTekst(controle.oordeel, controle.bevindingen.find((b) => b.ernst !== "info" && !controle.nagekeken.has(b.id))?.titel)}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setVangnet(false);
                    void pushSanity();
                  }}
                >
                  Toch als concept versturen
                </Button>
                <Button
                  variant="brand"
                  onClick={() => {
                    setVangnet(false);
                    setTab("checks");
                  }}
                >
                  Naar Controle
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
          </div>
        </div>
      )}
    </div>
  );
}



/** Hoeveel er nog openstaat, in de kleur van het oordeel, naast het tabblad Controle. */
function TellerControle({ stand, open }: { stand: "oplossen" | "nakijken" | "klaar"; open: number }) {
  if (stand === "klaar") {
    return null;
  }
  return (
    <span
      className={
        stand === "oplossen"
          ? "rounded-full bg-destructive/15 px-1.5 text-[11px] leading-4 font-medium tabular-nums text-destructive"
          : "rounded-full bg-amber-100 px-1.5 text-[11px] leading-4 font-medium tabular-nums text-amber-900"
      }
    >
      {open}
    </span>
  );
}

function vangnetTekst(oordeel: { oplossen: number; nakijken: number }, eerste: string | undefined): string {
  const delen = [
    oordeel.oplossen ? `${oordeel.oplossen} punt${oordeel.oplossen === 1 ? "" : "en"} moet${oordeel.oplossen === 1 ? "" : "en"} opgelost` : null,
    oordeel.nakijken ? `${oordeel.nakijken} punt${oordeel.nakijken === 1 ? "" : "en"} om na te kijken` : null,
  ].filter(Boolean);
  return (
    `In de Controle-tab staat nog ${delen.join(" en ")}` +
    (eerste ? `, zoals: ${eerste}.` : ".") +
    ` Het gaat als concept naar ${STUDIO}, dus er staat nog niets live.`
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

