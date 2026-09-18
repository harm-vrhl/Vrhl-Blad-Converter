import type { WorkflowStep } from "@/components/Workflow";
import type { StoredJob } from "@/lib/client/db";
import type { PageResult } from "@/lib/types";

type Step = WorkflowStep;

/** What each run is called while it is still going. */
const BUSY: Record<string, string> = {
  "leesvolgorde": "tekst uitschrijven…",
  "opmaak uit de PDF": "opmaak uit de PDF…",
  "opmaak": "opmaak van het beeld lezen…",
  pagina: "bezig…",
};

export interface StatusLine {
  run: string;
  page?: number;
  state: "start" | "ok" | "fail";
  detail?: string;
}

/**
 * The run, as a handful of steps rather than as its log.
 *
 * The pipeline emits a line for every start and every finish of every run on
 * every page: for a six-page article that is forty entries of "leesvolgorde ·
 * p3". Useful while building it, unreadable while using it. The
 * same events are folded here into the few things someone actually waits for -
 * the document-wide stages, and then one row per page - so the list says where
 * the job IS instead of everything it has done.
 */
export function workflowSteps(
  status: StatusLine[],
  results: Record<number, PageResult>,
  job: StoredJob | null,
): Step[] {
  if (!status.length && !job) return [];
  if (job?.origin === "pakket") {
    return [
      {
        key: "import",
        label: "Geïmporteerd pakket",
        kind: "compile",
        state: "klaar",
        detail: job.pages.length ? `${job.pageCount} pagina's` : "",
      },
    ];
  }

  const last = (run: string, page?: number) =>
    [...status].reverse().find((l) => l.run === run && (page === undefined || l.page === page));

  const stage = (
    key: string,
    label: string,
    run: string,
    kind: Step["kind"] = "stage",
    detail?: string,
  ): Step => {
    const seen = last(run);
    if (!seen) return { key, label, state: "wacht", detail: "", kind };
    return {
      key,
      label,
      kind,
      state: seen.state === "fail" ? "fout" : seen.state === "ok" ? "klaar" : "bezig",
      detail: detail ?? seen.detail ?? "",
    };
  };

  const runState = (line?: StatusLine): Step["state"] | undefined => {
    if (!line) return undefined;
    return line.state === "fail" ? "fout" : line.state === "ok" ? "klaar" : "bezig";
  };

  const out: Step[] = [
    stage("ocr", "Tekst lezen", "woordindex"),
    stage("front", "Kop en auteurs", "frontmatter"),
    stage("beeld", "Beeld beoordelen", "beeldbeoordeling"),
  ];

  // One row per page, whatever the pipeline happens to be doing on it.
  for (let page = 1; page <= (job?.pageCount ?? 0); page++) {
    const done = results[page];
    const failed = status.find((l) => l.page === page && l.state === "fail");
    const busy = [...status].reverse().find((l) => l.page === page && l.state === "start");

    out.push({
      key: `p${page}`,
      label: `Pagina ${page}`,
      kind: "page",
      page,
      state: failed ? "fout" : done ? "klaar" : busy ? "bezig" : "wacht",
      detail: failed
        ? (failed.detail ?? "mislukt")
        : done
          ? `${done.blocks.length} blokken · ${done.patches.length} opmaak`
          : busy
            ? BUSY[busy.run] ?? busy.run
            : "",
      textRun: runState(last("leesvolgorde", page)),
      styleRun: runState(
        last("opmaak", page) ?? last("opmaak uit de PDF", page),
      ),
      coverage: done ? Math.round(done.check.score * 100) : undefined,
      unknown: done?.check.unknown.length ? done.check.unknown : undefined,
    });
  }

  out.push(stage("klaar", "Samenvoegen", "compileren", "compile"));
  return out;
}
