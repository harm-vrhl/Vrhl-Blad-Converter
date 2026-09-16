"use client";

import {
  ChevronDown,
  Download,
  FileCode,
  FileJson,
  FileText,
  Globe,
  Loader2,
  Package,
  UploadCloud,
  type LucideIcon,
} from "lucide-react";
import type { Settings } from "@/components/article/useSettings";
import { QuietToolbar, ToolbarButton, ToolbarRule } from "@/components/QuietToolbar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ExportFormaat } from "@/lib/client/exports";

// Geen Tooltip op de Sanity-knop, met opzet: zie AppHeader.

interface Optie {
  formaat: ExportFormaat;
  label: string;
  extensie: string;
  uitleg: string;
  icoon: LucideIcon;
}

/**
 * De formaten, in de volgorde van het menu. Het pakket staat apart onderaan:
 * dat is geen weergave van het artikel maar het artikel zelf, met beeld, voor
 * wie het elders wil inlezen.
 */
const WEERGAVEN: Optie[] = [
  { formaat: "json", label: "JSON", extensie: ".json", uitleg: "Het pakket, zonder beeld", icoon: FileJson },
  { formaat: "html", label: "HTML", extensie: ".html", uitleg: "Eén bestand, beeld erin", icoon: Globe },
  { formaat: "mdx", label: "MDX", extensie: ".mdx", uitleg: "Voor de Vrhl-Blad-site", icoon: FileCode },
  { formaat: "docx", label: "Word", extensie: ".docx", uitleg: "Om te bewerken of te delen", icoon: FileText },
];
const PAKKET: Optie = {
  formaat: "zip",
  label: "Pakket",
  extensie: ".zip",
  uitleg: "JSON plus al het beeld",
  icoon: Package,
};

const BEZIG: Record<ExportFormaat, string> = {
  docx: "Word maken…",
  html: "HTML maken…",
  mdx: "MDX maken…",
  json: "JSON maken…",
  zip: "Inpakken…",
};

/** Exporteren in één menu, en daarnaast Sanity: dat is geen download maar versturen. */
export function ExportToolbar({
  ready,
  exporting,
  exportAs,
  pushing,
  pushSanity,
  settings,
}: {
  ready: boolean;
  exporting: ExportFormaat | null;
  exportAs: (formaat: ExportFormaat) => Promise<void>;
  pushing: { done: number; total: number } | null;
  pushSanity: () => Promise<void>;
  settings: Settings | null;
}) {
  return (
    <QuietToolbar aria-label="Exporteren">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <ToolbarButton type="button" disabled={!ready || !!exporting}>
            {exporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
            {exporting ? BEZIG[exporting] : "Exporteren"}
            {exporting ? null : <ChevronDown className="size-3 opacity-60" />}
          </ToolbarButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Downloaden als</DropdownMenuLabel>
          {WEERGAVEN.map((optie) => (
            <Item key={optie.formaat} optie={optie} exportAs={exportAs} />
          ))}
          <DropdownMenuSeparator />
          <Item optie={PAKKET} exportAs={exportAs} />
        </DropdownMenuContent>
      </DropdownMenu>
      <ToolbarRule />
      <ToolbarButton
        type="button"
        disabled={!!pushing || !settings?.sanity?.ready}
        title={
          settings?.sanity?.ready
            ? `Als concept naar ${settings.sanity.projectId} · ${settings.sanity.dataset}`
            : "Vul NEXT_PUBLIC_SANITY_PROJECT_ID, NEXT_PUBLIC_SANITY_DATASET en SANITY_API_TOKEN in"
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
  );
}

function Item({ optie, exportAs }: { optie: Optie; exportAs: (formaat: ExportFormaat) => Promise<void> }) {
  const Icoon = optie.icoon;
  return (
    <DropdownMenuItem onSelect={() => void exportAs(optie.formaat)}>
      <Icoon className="size-4 text-muted-foreground" />
      <span className="grid min-w-0 flex-1 leading-tight">
        <span>
          {optie.label} <span className="text-muted-foreground">{optie.extensie}</span>
        </span>
        <span className="text-xs text-muted-foreground">{optie.uitleg}</span>
      </span>
    </DropdownMenuItem>
  );
}
