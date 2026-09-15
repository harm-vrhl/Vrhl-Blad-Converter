"use client";

import type { Dispatch, SetStateAction } from "react";
import { ArrowLeft, Loader2, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import type { Phase } from "@/components/article/useArticleRun";
import { PROVIDER_KEY, type Provider, type Settings } from "@/components/article/useSettings";
import { Logo } from "@/components/Logo";
import { ProviderSwitch } from "@/components/ProviderSwitch";
import { Button } from "@/components/ui/button";
import type { StoredJob } from "@/lib/client/db";
import type { RenderStep } from "@/lib/client/render";

// Geen Tooltip hier met opzet: de hints bij de schakelaar en de Sanity-knop zijn
// juist nodig als die knoppen uit staan, en een tooltip krijgt op een disabled
// element geen pointer-events. Het native title-attribuut wel.

/** De balk bovenaan: logo, zijbalkknop, terug, bestand, provider en Convert. */
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
}) {
  return (
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
  );
}
