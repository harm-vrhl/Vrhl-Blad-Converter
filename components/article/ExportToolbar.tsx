"use client";

import {
  ChevronDown,
  Download,
  FileCode,
  FileJson,
  FileText,
  Globe,
  ImageIcon,
  Loader2,
  Package,
  Printer,
  Type,
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
import { STUDIO } from "@/lib/studio";

// Geen Tooltip op de knop van Vrhl-Blad-Studio, met opzet: zie AppHeader.

interface Optie {
  formaat: ExportFormaat;
  label: string;
  extensie: string;
  /** Alleen bij Blad: dat is bewaren, geen weergave. */
  uitleg?: string;
  icoon: LucideIcon;
  /** Het bestand zelf draagt het beeld, niet alleen een verwijzing. */
  beeld?: boolean;
}

/**
 * De formaten, in de volgorde van het menu. Het .blad-bestand staat apart
 * onderaan: dat is geen weergave van het artikel maar het artikel zelf, met
 * beeld en pagina's, om later weer te openen.
 *
 * T = tekst zit in het bestand. Het beeld-icoon = de foto's zitten er ook in.
 * JSON en MDX hebben alleen de tekst; HTML, Word en PDF nemen het beeld mee.
 */
const WEERGAVEN: Optie[] = [
  { formaat: "json", label: "JSON", extensie: ".json", icoon: FileJson },
  { formaat: "html", label: "HTML", extensie: ".html", icoon: Globe, beeld: true },
  { formaat: "mdx", label: "MDX", extensie: ".mdx", icoon: FileCode },
  { formaat: "docx", label: "Word", extensie: ".docx", icoon: FileText, beeld: true },
  { formaat: "pdf", label: "PDF", extensie: ".pdf", icoon: Printer, beeld: true },
];
const PAKKET: Optie = {
  formaat: "blad",
  label: "Blad",
  extensie: ".blad",
  uitleg: "Lokaal bewaren, met beeld en pagina's; later weer te openen",
  icoon: Package,
  beeld: true,
};

const BEZIG: Record<ExportFormaat, string> = {
  docx: "Word maken…",
  pdf: "PDF klaarzetten…",
  html: "HTML maken…",
  mdx: "MDX maken…",
  json: "JSON maken…",
  blad: "Inpakken…",
};

/** Exporteren in één menu, en daarnaast Vrhl-Blad-Studio: dat is geen download maar versturen. */
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
          <ToolbarButton type="button" data-tour="export" disabled={!ready || !!exporting}>
            {exporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
            {exporting ? BEZIG[exporting] : "Exporteren"}
            {exporting ? null : <ChevronDown className="size-3 opacity-60" />}
          </ToolbarButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel>Lokaal bewaren als</DropdownMenuLabel>
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
        data-tour="studio"
        disabled={!!pushing || !settings?.sanity?.ready}
        title={
          settings?.sanity?.ready
            ? `Als concept naar ${STUDIO} (dataset ${settings.sanity.dataset})`
            : `${STUDIO} is niet gekoppeld: vul NEXT_PUBLIC_SANITY_PROJECT_ID, NEXT_PUBLIC_SANITY_DATASET en SANITY_API_TOKEN in`
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
          : STUDIO}
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
        {optie.uitleg ? <span className="text-xs text-muted-foreground">{optie.uitleg}</span> : null}
      </span>
      {optie.uitleg ? null : <Inhoud beeld={!!optie.beeld} />}
    </DropdownMenuItem>
  );
}

/** Wat het bestand meeneemt: altijd tekst, beeld alleen als het erin zit. */
function Inhoud({ beeld }: { beeld: boolean }) {
  return (
    <span className="ml-3 flex items-center gap-1 text-muted-foreground">
      <span title="Tekst">
        <Type className="size-3.5" aria-label="Tekst" />
      </span>
      {beeld ? (
        <span title="Beeld">
          <ImageIcon className="size-3.5" aria-label="Beeld" />
        </span>
      ) : null}
    </span>
  );
}
