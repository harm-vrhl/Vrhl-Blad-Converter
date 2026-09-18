"use client";

import type { Dispatch, SetStateAction } from "react";
import { cn } from "cn";
import type { Phase } from "@/components/article/useArticleRun";
import { Workflow, type WorkflowStep } from "@/components/Workflow";
import type { StoredJob, Totals } from "@/lib/client/db";
import type { Frontmatter, ImageVerdict } from "@/lib/types";

/** De Workflow als eiland links van het werkgebied, met de ruimte die het inneemt. */
export function WorkflowSidebar({
  sidebarOpen,
  setSidebarOpen,
  narrow,
  sidebarAnimates,
  steps,
  totals,
  phase,
  thumbs,
  job,
  frontmatter,
  verdicts,
  text,
}: {
  sidebarOpen: boolean;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  narrow: boolean;
  sidebarAnimates: boolean;
  steps: WorkflowStep[];
  totals: Totals | null;
  phase: Phase;
  thumbs: string[];
  job: StoredJob | null;
  frontmatter: Frontmatter | null;
  verdicts: ImageVerdict[];
  text: Record<number, string>;
}) {
  return (
    <>
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
        data-tour="workflow"
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
    </>
  );
}
