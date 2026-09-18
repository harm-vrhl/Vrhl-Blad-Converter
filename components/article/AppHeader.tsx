"use client";

import type { Dispatch, ReactNode, SetStateAction } from "react";
import { ArrowLeft, Loader2, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "cn";
import type { Phase } from "@/components/article/useArticleRun";
import { PROVIDER_KEY, type Provider, type Settings } from "@/components/article/useSettings";
import { Logo } from "@/components/Logo";
import { ProviderSwitch } from "@/components/ProviderSwitch";
import { Button } from "@/components/ui/button";
import type { StoredJob } from "@/lib/client/db";
import { isPakketJob } from "@/lib/client/import";
import type { RenderStep } from "@/lib/client/render";

// Geen Tooltip hier met opzet: de hints bij de schakelaar en de knop van Vrhl-Blad-Studio zijn
// juist nodig als die knoppen uit staan, en een tooltip krijgt op een disabled
// element geen pointer-events. Het native title-attribuut wel.

/** De balk bovenaan: logo, zijbalkknop, terug, zoeken, provider en Omzetten. */
export function AppHeader({
  workspace,
  sidebarOpen,
  toggleSidebar,
  mode,
  view,
  setView,
  job,
  showMagazine,
  uploadDisabled,
  closeJob,
  phase,
  renderStep,
  thumbs,
  settings,
  provider,
  setProvider,
  converting,
  convert,
  zoek,
  uitleg,
}: {
  workspace: boolean;
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  mode: "artikel" | "magazine";
  view: "magazine" | "artikel";
  setView: Dispatch<SetStateAction<"magazine" | "artikel">>;
  job: StoredJob | null;
  showMagazine: boolean;
  uploadDisabled: boolean;
  closeJob: () => void;
  phase: Phase;
  renderStep: { page: number; total: number; step: RenderStep | "opslaan" } | null;
  thumbs: string[];
  settings: Settings | null;
  provider: Provider;
  setProvider: Dispatch<SetStateAction<Provider>>;
  converting: boolean;
  convert: (resume?: boolean) => Promise<boolean>;
  /** Zoekbalk, vast in deze balk zodat hij bij scrollen blijft staan. */
  zoek?: ReactNode;
  uitleg?: ReactNode;
}) {
  const terugNaarMagazine = mode === "magazine" && view === "artikel";
  const terugNaarStart = !!job && !showMagazine && mode === "artikel";
  return (
    <header className="z-20 shrink-0 border-b bg-white/80 backdrop-blur-md">
      <div className="flex h-14 items-center justify-between gap-4 px-6">
        <div className="flex items-center gap-3">
          <h1 className="flex">
            {terugNaarMagazine || terugNaarStart ? (
              <button
                type="button"
                disabled={terugNaarStart && uploadDisabled}
                className={cn(
                  "rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                  terugNaarStart && uploadDisabled ? "cursor-default opacity-50" : "hover:opacity-70",
                )}
                aria-label="Naar overzicht"
                title="Naar overzicht"
                onClick={() => {
                  if (terugNaarMagazine) setView("magazine");
                  else closeJob();
                }}
              >
                <Logo className="h-8" />
              </button>
            ) : (
              <Logo className="h-8" />
            )}
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
            <span
              className={cn(
                "hidden truncate text-xs text-muted-foreground",
                zoek ? "max-w-[10rem] lg:inline lg:max-w-xs" : "max-w-xs sm:inline"
              )}
            >
              {job.filename}
              {" · "}
              {phase === "rendering"
                ? renderStep
                  ? `${renderStep.page}/${renderStep.total} · ${renderStep.step}`
                  : `${thumbs.length}/${job.pageCount} klaar`
                : isPakketJob(job)
                  ? [job.pages.length ? `${job.pageCount} pagina's` : null, "geïmporteerd"]
                      .filter(Boolean)
                      .join(" · ")
                  : `${job.pageCount} pagina's`}
            </span>
          ) : null}
          {zoek ? <div data-tour="zoek" className="shrink-0">{zoek}</div> : null}
          {uitleg}
          {/* Uitgezet met AI_PROVIDER_CHOICE, niet weggehaald. */}
          {settings?.providerChoice ? (
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
          {job && !showMagazine && !isPakketJob(job) && (phase === "ready" || phase === "running" || phase === "error") ? (
            <Button
              variant="brand"
              data-tour="omzetten"
              disabled={converting || phase === "running"}
              onClick={() => void convert()}
            >
              {phase === "running" ? (
                <>
                  <Loader2 className="animate-spin" />
                  Bezig…
                </>
              ) : (
                "Omzetten"
              )}
            </Button>
          ) : null}
        </div>
      </div>
    </header>
  );
}
