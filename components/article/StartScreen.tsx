"use client";

import type { Dispatch, ReactNode, SetStateAction } from "react";
import { cn } from "cn";
import { Loader2, Package, UploadCloud } from "lucide-react";
import { Earlier } from "@/components/article/Earlier";
import { WisOpslag } from "@/components/article/WisOpslag";
import type { Phase } from "@/components/article/useArticleRun";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { deleteOwner, type StoredJob } from "@/lib/client/db";
import type { RenderStep } from "@/lib/client/render";

/** Het startscherm: de vraag, het sleepvak en wat er eerder is omgezet. */
export function StartScreen({
  mode,
  modeSwitch,
  notice,
  noticeOk,
  phase,
  dragging,
  setDragging,
  accept,
  renderStep,
  earlier,
  storage,
  openJob,
  refreshEarlier,
}: {
  mode: "artikel" | "magazine";
  modeSwitch: ReactNode;
  notice: string | null;
  noticeOk: boolean;
  phase: Phase;
  dragging: boolean;
  setDragging: Dispatch<SetStateAction<boolean>>;
  accept: (file: File, opening?: number) => Promise<StoredJob | null>;
  renderStep: { page: number; total: number; step: RenderStep | "opslaan" } | null;
  earlier: Array<StoredJob & { bytes: number }> | null;
  storage: { usage: number; quota: number } | null;
  openJob: (jobId: string) => Promise<void>;
  refreshEarlier: () => Promise<void>;
}) {
  const busy = phase === "rendering" || phase === "importing";
  return (
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
        data-tour="dropzone"
        htmlFor={busy ? undefined : "pdf-upload"}
        aria-disabled={busy}
        onDragOver={(e) => {
          e.preventDefault();
          if (busy) return;
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (busy) return;
          const file = e.dataTransfer.files[0];
          if (file) void accept(file);
        }}
        className={cn(
          "mt-10 flex min-h-64 w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-8 py-12 text-center transition-colors",
          phase === "rendering" || phase === "importing"
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
          {busy ? (
            <Loader2 className="size-6 animate-spin" />
          ) : (
            <UploadCloud className="size-6" />
          )}
        </span>
        <span className="grid gap-1">
          <span className="text-sm font-medium text-foreground">
            {phase === "rendering"
              ? "Pagina's renderen…"
              : phase === "importing"
                ? "Blad openen…"
                : dragging
                  ? "Laat los om te beginnen"
                  : "Sleep je PDF hierheen"}
          </span>
          <span className="text-xs">
            {phase === "rendering"
              ? renderStep
                ? `${renderStep.page}/${renderStep.total} · ${renderStep.step}`
                : "pdf.js leest het bestand"
              : phase === "importing"
                ? "in deze browser, zonder opnieuw om te zetten"
                : "of klik om een bestand te kiezen"}
          </span>
        </span>
        {busy ? null : (
          <span className="rounded-md border bg-background px-2 py-0.5 text-[11px] font-medium tracking-wide">
            PDF
          </span>
        )}
      </label>
      {busy ? null : (
        <Button variant="outline" size="sm" className="mt-4" data-tour="blad" asChild>
          <label htmlFor="pakket-upload" className="cursor-pointer">
            <Package className="size-4" />
            Blad openen
            <span className="text-muted-foreground">.blad</span>
          </label>
        </Button>
      )}
      {earlier?.length && !busy ? (
        <Earlier
          jobs={earlier}
          storage={storage}
          onOpen={(id) => void openJob(id)}
          onDelete={async (id) => {
            await deleteOwner(id);
            await refreshEarlier();
          }}
        />
      ) : !busy ? (
        <WisOpslag auto />
      ) : null}
    </div>
    </div>
  );
}
