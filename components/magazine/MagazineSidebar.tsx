"use client";

import type { ReactNode } from "react";
import {
  CircleAlert,
  FileSearch,
  Layers,
  ListChecks,
  Loader2,
  Sparkles,
  Split,
  UploadCloud,
  type LucideIcon,
} from "lucide-react";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from "@/components/ai-elements/chain-of-thought";
import { money, stateOf, type StatusLine } from "@/components/magazine/labels";
import type { ArticleProgress, Phase, Totals } from "@/components/magazine/useMagazine";
import type { Magazine, MagazineMap, PageScan } from "@/lib/magazine/types";

/** De stappen van het in kaart brengen, en wat het kostte. */
export function MagazineSidebar({
  phase,
  magazine,
  pageCount,
  rendered,
  lastOf,
  scanned,
  map,
  status,
  contentTotal,
  boundaryTotal,
  progress,
  converting,
  conversion,
  totals,
}: {
  phase: Phase;
  magazine: Magazine | null;
  pageCount: number;
  rendered: { page: number; total: number } | null;
  lastOf: (run: string) => StatusLine | undefined;
  scanned: PageScan[];
  map: MagazineMap | null;
  status: StatusLine[];
  contentTotal: number;
  boundaryTotal: number;
  progress: Record<string, ArticleProgress>;
  converting: boolean;
  conversion: { total: number; done: number; failed: number; running: number; cost: number; currency: string };
  totals: Totals | null;
}) {
  return (
    <aside className="flex min-h-0 w-96 shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar" aria-label="Magazine" data-tour="magazine-sidebar">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
        <ChainOfThought defaultOpen>
          <ChainOfThoughtHeader>
            {phase === "analyzing" ? "Magazine in kaart brengen" : phase === "done" ? "Magazine in kaart" : "Magazine"}
          </ChainOfThoughtHeader>
          <ChainOfThoughtContent>
            <Stage
              icon={UploadCloud}
              label="Pagina's klaarzetten"
              state={phase === "scanning" ? "bezig" : magazine && magazine.pages.length >= pageCount ? "klaar" : "wacht"}
              detail={phase === "scanning" && rendered ? `${rendered.page}/${rendered.total}` : `${pageCount} pagina's`}
            />
            <Stage
              icon={FileSearch}
              label="Pagina's bekijken"
              state={stateOf(lastOf("paginascan"))}
              detail={
                lastOf("paginascan")
                  ? lastOf("paginascan")?.state === "start"
                    ? `${scanned.length}/${pageCount} bekeken`
                    : lastOf("paginascan")?.detail
                  : undefined
              }
            />
            <Stage icon={Layers} label="Aan elkaar rijgen" state={stateOf(lastOf("rijgen"))} detail={lastOf("rijgen")?.detail}>
              {map?.notes.length ? (
                <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                  {map.notes.map((note, i) => (
                    <li key={i}>{note}</li>
                  ))}
                </ul>
              ) : null}
            </Stage>
            {map?.basis === "inhoudsopgave" || lastOf("inhoudscontrole") ? (
              <Stage
                icon={ListChecks}
                label="Inhoud toewijzen"
                state={stateOf(lastOf("inhoudscontrole"))}
                detail={
                  lastOf("inhoudscontrole")?.state === "start"
                    ? `${status.filter((l) => l.run === "inhoudscontrole" && l.page != null && l.state !== "start").length}/${contentTotal} pagina's`
                    : lastOf("inhoudscontrole")?.detail
                }
              />
            ) : (
              <Stage
                icon={Split}
                label="Grenscontrole"
                state={stateOf(lastOf("grenscontrole"))}
                detail={
                  lastOf("grenscontrole")?.state === "start"
                    ? `${map?.boundaries.length ?? 0}/${boundaryTotal} overgangen`
                    : lastOf("grenscontrole")?.detail
                }
              />
            )}
            {Object.keys(progress).length ? (
              <Stage
                icon={Sparkles}
                label="Omzetten"
                state={converting ? "bezig" : conversion.failed ? "fout" : "klaar"}
                detail={[
                  `${conversion.done}/${conversion.total} klaar`,
                  conversion.running ? `${conversion.running} bezig` : "",
                  conversion.failed ? `${conversion.failed} mislukt` : "",
                  conversion.cost ? money(conversion.cost, conversion.currency) : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              />
            ) : null}
          </ChainOfThoughtContent>
        </ChainOfThought>
      </div>
      {totals ? (
        <div className="grid shrink-0 grid-cols-2 gap-x-4 gap-y-2 border-t border-sidebar-border px-4 py-3 text-xs">
          <div>
            <div className="text-muted-foreground">Tijd</div>
            <div className="tabular-nums">{Math.round(totals.ms / 1000)} s</div>
          </div>
          <div>
            <div className="text-muted-foreground">Tokens</div>
            <div className="tabular-nums">
              {totals.tokens.toLocaleString("nl-NL")}
              <span className="ml-1 text-muted-foreground">in {totals.runs} runs</span>
            </div>
          </div>
          <div className="col-span-2">
            <div className="text-muted-foreground">Kosten</div>
            <div className="tabular-nums">
              {totals.cost.currency} {totals.cost.total.toFixed(totals.cost.total < 1 ? 3 : 2).replace(".", ",")}
            </div>
          </div>
        </div>
      ) : null}
    </aside>
  );
}

function Stage({
  icon,
  label,
  state,
  detail,
  children,
}: {
  icon: LucideIcon;
  label: string;
  state: "wacht" | "bezig" | "klaar" | "fout";
  detail?: string;
  children?: ReactNode;
}) {
  return (
    <ChainOfThoughtStep
      icon={state === "fout" ? CircleAlert : state === "bezig" ? Loader2 : icon}
      label={label}
      description={detail}
      status={state === "klaar" ? "complete" : state === "bezig" ? "active" : "pending"}
      className={state === "fout" ? "text-[var(--destructive)]" : undefined}
    >
      {children}
    </ChainOfThoughtStep>
  );
}

