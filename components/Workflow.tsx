"use client";

import { cn } from "cn";
import {
  Check,
  CircleAlert,
  FileText,
  Heading,
  ImageIcon,
  Layers,
  Loader2,
  ScanText,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep,
} from "@/components/ai-elements/chain-of-thought";
import {
  QueueItem,
  QueueItemContent,
  QueueItemDescription,
  QueueItemImage,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from "@/components/ai-elements/queue";
import type {
  ExtractedImage,
  Frontmatter,
  ImageVerdict,
} from "@/lib/types";

export interface WorkflowStep {
  key: string;
  label: string;
  state: "wacht" | "bezig" | "klaar" | "fout";
  detail: string;
  kind: "stage" | "page" | "compile";
  page?: number;
  /** Run 1 on this page, when the step is a page. */
  textRun?: "wacht" | "bezig" | "klaar" | "fout";
  /** Run 2 or the PDF font table, when the step is a page. */
  styleRun?: "wacht" | "bezig" | "klaar" | "fout";
  coverage?: number;
  unknown?: string[];
}

interface Totals {
  runs: number;
  tokens: number;
  ms: number;
  ocrPages: number;
  cost: { ai: number; ocr: number; total: number; currency: string } | null;
}

const STAGE_ICON: Record<string, LucideIcon> = {
  ocr: ScanText,
  front: Heading,
  beeld: ImageIcon,
  klaar: Layers,
};

/**
 * De run, als een inklapbare keten in de linker kolom. Wat hij toont is wat de
 * job op dit moment weet: de kop, welke beelden blijven, de woorddekking per
 * pagina, en de zin die nu wordt uitgeschreven. Niet de log eronder.
 */
export function Workflow({
  steps,
  totals,
  phase,
  thumbs,
  jobId,
  frontmatter,
  verdicts,
  images,
  text,
}: {
  steps: WorkflowStep[];
  totals: Totals | null;
  phase: "idle" | "rendering" | "ready" | "running" | "done" | "error";
  thumbs: string[];
  jobId: string | null;
  frontmatter: Frontmatter | null;
  verdicts: ImageVerdict[];
  images: ExtractedImage[];
  text: Record<number, string>;
}) {
  const stages = steps.filter((step) => step.kind === "stage");
  const pages = steps.filter((step) => step.kind === "page");
  const compile = steps.find((step) => step.kind === "compile");

  const pagesDone = pages.filter((step) => step.state === "klaar").length;
  const pagesBusy = pages.some((step) => step.state === "bezig");
  const pagesFailed = pages.some((step) => step.state === "fout");
  const pagesStatus = cotStatus(
    pagesFailed
      ? "fout"
      : pagesBusy
        ? "bezig"
        : pagesDone === pages.length && pages.length
          ? "klaar"
          : "wacht",
  );

  const finished = steps.filter((step) => step.state === "klaar").length;
  const pct = steps.length ? Math.round((finished / steps.length) * 100) : 0;
  const busy = steps.find((step) => step.state === "bezig");
  const activity = busy
    ? busy.kind === "page" && busy.detail
      ? `${busy.label} · ${busy.detail}`
      : busy.detail || busy.label
    : null;

  const title =
    phase === "running"
      ? "Bezig met omzetten"
      : phase === "done"
        ? "Omzetten klaar"
        : phase === "error"
          ? "Omzetten mislukt"
          : "Omzetten";

  const kept = verdicts.filter((v) => v.keep);
  const dropped = verdicts.filter((v) => !v.keep);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
        <ChainOfThought defaultOpen>
          <ChainOfThoughtHeader>
            <span className="flex items-center gap-2">
              {title}
              {steps.length ? (
                <ChainOfThoughtSearchResults>
                  <ChainOfThoughtSearchResult>
                    {finished}/{steps.length}
                  </ChainOfThoughtSearchResult>
                </ChainOfThoughtSearchResults>
              ) : null}
            </span>
          </ChainOfThoughtHeader>

          {steps.length ? (
            <div className="space-y-1.5">
              {activity ? (
                <p className="text-xs text-muted-foreground">{activity}</p>
              ) : null}
              <div
                className="h-0.5 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
                aria-label="Voortgang"
              >
                <div
                  className="h-full bg-foreground transition-[width] duration-500"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          ) : null}

          <ChainOfThoughtContent>
          {stages.map((step) => {
            if (step.key === "front") {
              return (
                <StageStep
                  key={step.key}
                  step={step}
                  quiet={!!frontmatter?.title}
                >
                  <FrontFindings frontmatter={frontmatter} />
                </StageStep>
              );
            }
            if (step.key === "beeld") {
              return (
                <StageStep
                  key={step.key}
                  step={step}
                  quiet={kept.length + dropped.length > 0}
                >
                  <ImageFindings
                    jobId={jobId}
                    images={images}
                    kept={kept}
                    dropped={dropped}
                    pending={step.state === "wacht" || step.state === "bezig"}
                  />
                </StageStep>
              );
            }
            if (step.key === "ocr") {
              return (
                <StageStep
                  key={step.key}
                  step={step}
                  quiet={/\d+\s*woorden/.test(step.detail)}
                >
                  <OcrFindings detail={step.detail} />
                </StageStep>
              );
            }
            return <StageStep key={step.key} step={step} />;
          })}

          {pages.length ? (
            <ChainOfThoughtStep
              icon={pagesFailed ? CircleAlert : pagesBusy ? Loader2 : FileText}
              label="Pagina's"
              description={pagesFailed ? "een pagina is mislukt" : undefined}
              status={pagesStatus}
              className={pagesFailed ? "text-destructive" : undefined}
            >
              <QueueSection defaultOpen>
                <QueueSectionTrigger>
                  <QueueSectionLabel
                    count={pagesBusy ? pagesDone : pages.length}
                    label={
                      pagesBusy
                        ? `van ${pages.length} klaar`
                        : "pagina's"
                    }
                  />
                </QueueSectionTrigger>
                <QueueSectionContent>
                  <QueueList className="mt-1">
                    {pages.map((page) => (
                      <PageRow
                        key={page.key}
                        page={page}
                        thumb={
                          page.page != null ? thumbs[page.page - 1] : undefined
                        }
                        snippet={
                          page.state === "bezig" && page.page != null
                            ? peek(text[page.page] ?? "")
                            : ""
                        }
                      />
                    ))}
                  </QueueList>
                </QueueSectionContent>
              </QueueSection>
            </ChainOfThoughtStep>
          ) : null}

          {compile ? (
            <StageStep
              step={compile}
              quiet={/\d+\s*blokken/.test(compile.detail)}
            >
              <CompileFindings detail={compile.detail} />
            </StageStep>
          ) : null}
          </ChainOfThoughtContent>
        </ChainOfThought>
      </div>

      {totals ? (
        <div className="grid shrink-0 grid-cols-2 gap-x-4 gap-y-2 border-t border-sidebar-border px-4 py-3 text-xs">
          <div>
            <div className="text-muted-foreground">Tijd</div>
            <div className="tabular-nums text-foreground">
              {duration(totals.ms)}
            </div>
          </div>
          <div>
            <div className="text-muted-foreground">Tokens</div>
            <div className="tabular-nums text-foreground">
              {totals.tokens.toLocaleString("nl-NL")}
              <span className="ml-1 text-muted-foreground">
                in {totals.runs} runs
              </span>
            </div>
          </div>
          {totals.cost ? (
            <div className="col-span-2">
              <div className="text-muted-foreground">Kosten</div>
              <div className="tabular-nums text-foreground">
                {money(totals.cost.total, totals.cost.currency)}
                <span className="ml-1 text-muted-foreground">
                  {money(totals.cost.ai, totals.cost.currency)} model +{" "}
                  {money(totals.cost.ocr, totals.cost.currency)} OCR
                </span>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PageRow({
  page,
  thumb,
  snippet,
}: {
  page: WorkflowStep;
  thumb?: string;
  snippet: string;
}) {
  const pageDone = page.state === "klaar";
  const weak = page.coverage != null && page.coverage < 98;
  const unknowns = (page.unknown ?? []).slice(0, 3);
  const extraUnknown = (page.unknown?.length ?? 0) - unknowns.length;

  return (
    <QueueItem className="px-1">
      <div className="flex items-start gap-2">
        <QueueItemIndicator
          completed={pageDone}
          className={
            page.state === "bezig"
              ? "animate-pulse border-foreground bg-foreground"
              : page.state === "fout"
                ? "border-destructive bg-destructive"
                : page.state === "wacht"
                  ? "opacity-50"
                  : undefined
          }
        />
        <QueueItemContent
          completed={pageDone}
          className={
            page.state === "bezig"
              ? "text-foreground"
              : page.state === "fout"
                ? "text-destructive"
                : page.state === "wacht"
                  ? "text-muted-foreground/50"
                  : undefined
          }
        >
          {page.label}
        </QueueItemContent>
        {page.state === "bezig" ? (
          <Loader2 className="mt-0.5 size-3 shrink-0 animate-spin text-foreground" />
        ) : null}
        {thumb ? (
          <QueueItemImage
            src={thumb}
            alt=""
            className="ml-auto h-7 w-5 rounded-sm"
          />
        ) : null}
      </div>

      {page.textRun || page.styleRun ? (
        <div className="ml-6 flex flex-wrap gap-1">
          <RunChip label="Tekst" state={page.textRun} />
          <RunChip label="Opmaak" state={page.styleRun} />
        </div>
      ) : null}

      {snippet ? (
        <p className="ml-6 line-clamp-2 font-mono text-[11px] leading-relaxed text-muted-foreground/80">
          {snippet}
          <span className="ml-0.5 inline-block h-3 w-px translate-y-0.5 animate-pulse bg-foreground/50" />
        </p>
      ) : page.detail ? (
        <QueueItemDescription
          completed={pageDone}
          className={page.state === "fout" ? "text-destructive" : undefined}
        >
          {page.detail}
        </QueueItemDescription>
      ) : null}

      {pageDone && (page.coverage != null || unknowns.length) ? (
        <ChainOfThoughtSearchResults className="ml-6 mt-0.5 gap-1">
          {page.coverage != null ? (
            <ChainOfThoughtSearchResult
              variant={weak ? "destructive" : "secondary"}
            >
              {page.coverage}% woorden
            </ChainOfThoughtSearchResult>
          ) : null}
          {unknowns.map((word) => (
            <ChainOfThoughtSearchResult key={word} variant="destructive">
              {word}
            </ChainOfThoughtSearchResult>
          ))}
          {extraUnknown > 0 ? (
            <ChainOfThoughtSearchResult variant="destructive">
              +{extraUnknown}
            </ChainOfThoughtSearchResult>
          ) : null}
        </ChainOfThoughtSearchResults>
      ) : null}
    </QueueItem>
  );
}

function RunChip({
  label,
  state,
}: {
  label: string;
  state?: WorkflowStep["state"];
}) {
  const done = state === "klaar";
  const busy = state === "bezig";
  const fail = state === "fout";
  const wait = !state || state === "wacht";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] leading-none",
        fail && "border-destructive/30 text-destructive",
        busy && "border-foreground/20 text-foreground",
        done && "border-transparent bg-muted text-muted-foreground",
        wait && "border-transparent text-muted-foreground/40",
      )}
    >
      {busy ? (
        <Loader2 className="size-2.5 animate-spin" />
      ) : done ? (
        <Check className="size-2.5" strokeWidth={3} />
      ) : fail ? (
        <CircleAlert className="size-2.5" />
      ) : null}
      {label}
    </span>
  );
}

function StageStep({
  step,
  children,
  quiet,
}: {
  step: WorkflowStep;
  children?: ReactNode;
  quiet?: boolean;
}) {
  const Icon =
    step.state === "fout"
      ? CircleAlert
      : step.state === "bezig"
        ? Loader2
        : (STAGE_ICON[step.key] ?? FileText);

  return (
    <ChainOfThoughtStep
      icon={Icon}
      label={step.label}
      description={quiet ? undefined : step.detail || undefined}
      status={cotStatus(step.state)}
      className={step.state === "fout" ? "text-destructive" : undefined}
    >
      {children}
    </ChainOfThoughtStep>
  );
}

function OcrFindings({ detail }: { detail: string }) {
  const pages = detail.match(/(\d+)\s*pagina/);
  const words = detail.match(/(\d+)\s*woorden/);
  if (!pages && !words) return null;
  return (
    <ChainOfThoughtSearchResults>
      {pages ? (
        <ChainOfThoughtSearchResult>
          {pages[1]} pagina{pages[1] === "1" ? "" : "'s"}
        </ChainOfThoughtSearchResult>
      ) : null}
      {words ? (
        <ChainOfThoughtSearchResult>
          {Number(words[1]).toLocaleString("nl-NL")} woorden
        </ChainOfThoughtSearchResult>
      ) : null}
    </ChainOfThoughtSearchResults>
  );
}

function FrontFindings({ frontmatter }: { frontmatter: Frontmatter | null }) {
  if (!frontmatter) return null;
  const people = [
    ...frontmatter.authors,
    ...frontmatter.photographers,
    ...frontmatter.illustrators,
  ].filter(Boolean);
  if (!frontmatter.title && !people.length && !frontmatter.chapeau) return null;
  return (
    <div className="space-y-1.5">
      {frontmatter.chapeau ? (
        <p className="text-[11px] tracking-wide text-muted-foreground uppercase">
          {frontmatter.chapeau}
        </p>
      ) : null}
      {frontmatter.title ? (
        <p className="text-sm leading-snug text-foreground">
          {frontmatter.title}
        </p>
      ) : null}
      {frontmatter.subtitle ? (
        <p className="text-xs text-muted-foreground">{frontmatter.subtitle}</p>
      ) : null}
      {people.length ? (
        <ChainOfThoughtSearchResults>
          {people.slice(0, 6).map((name) => (
            <ChainOfThoughtSearchResult key={name}>
              {name}
            </ChainOfThoughtSearchResult>
          ))}
        </ChainOfThoughtSearchResults>
      ) : null}
    </div>
  );
}

function ImageFindings({
  jobId,
  images,
  kept,
  dropped,
  pending,
}: {
  jobId: string | null;
  images: ExtractedImage[];
  kept: ImageVerdict[];
  dropped: ImageVerdict[];
  pending: boolean;
}) {
  if (pending && !images.length) return null;
  const byId = new Map(images.map((image) => [image.id, image]));
  const shown = kept
    .map((v) => byId.get(v.id))
    .filter((image): image is ExtractedImage => !!image)
    .slice(0, 8);

  return (
    <div className="space-y-1.5">
      {kept.length || dropped.length ? (
        <ChainOfThoughtSearchResults>
          {kept.length ? (
            <ChainOfThoughtSearchResult>
              {kept.length} bruikbaar
            </ChainOfThoughtSearchResult>
          ) : null}
          {dropped.length ? (
            <ChainOfThoughtSearchResult>
              {dropped.length} decoratief
            </ChainOfThoughtSearchResult>
          ) : null}
        </ChainOfThoughtSearchResults>
      ) : images.length ? (
        <ChainOfThoughtSearchResults>
          <ChainOfThoughtSearchResult>
            {images.length} bitmap{images.length === 1 ? "" : "s"}
          </ChainOfThoughtSearchResult>
        </ChainOfThoughtSearchResults>
      ) : null}
      {shown.length && jobId ? (
        <div className="flex flex-wrap gap-1.5">
          {shown.map((image) => (
            <QueueItemImage
              key={image.id}
              src={`/api/jobs/${jobId}/artifact/${image.thumb}`}
              alt=""
              className="h-8 w-8 rounded"
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CompileFindings({ detail }: { detail: string }) {
  const blocks = detail.match(/(\d+)\s*blokken/);
  const seams = detail.match(/(\d+)\s*paginanaad/);
  if (!blocks && !seams) return null;
  return (
    <ChainOfThoughtSearchResults>
      {blocks ? (
        <ChainOfThoughtSearchResult>
          {blocks[1]} blokken
        </ChainOfThoughtSearchResult>
      ) : null}
      {seams ? (
        <ChainOfThoughtSearchResult>
          {seams[1]} naad{seams[1] === "1" ? "" : "en"}
        </ChainOfThoughtSearchResult>
      ) : null}
    </ChainOfThoughtSearchResults>
  );
}

function peek(raw: string): string {
  const plain = raw
    .replace(/\[continues-[^\]]+\]/g, "")
    .replace(/\[image:[^\]]+\]/g, "")
    .replace(/\[insert:[^\]]+\]/g, "")
    .replace(/\[\/insert\]/g, "")
    .replace(/^[#>~\-]\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return "";
  return plain.length <= 110 ? plain : `…${plain.slice(-110)}`;
}

function cotStatus(
  state: WorkflowStep["state"],
): "complete" | "active" | "pending" {
  if (state === "bezig") return "active";
  if (state === "wacht") return "pending";
  return "complete";
}

function money(amount: number, currency = "USD"): string {
  return `${currency} ${amount
    .toFixed(amount < 0.1 ? 4 : amount < 1 ? 3 : 2)
    .replace(".", ",")}`;
}

function duration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1).replace(".", ",")} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  return rest ? `${minutes} m ${rest} s` : `${minutes} m`;
}
