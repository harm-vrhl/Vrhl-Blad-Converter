"use client";

import { FileCode, FileJson, Loader2, Package, UploadCloud } from "lucide-react";
import type { Settings } from "@/components/article/useSettings";
import { QuietToolbar, ToolbarButton, ToolbarRule } from "@/components/QuietToolbar";
import type { Pakket } from "@/lib/canonical";
import { toMdx } from "@/lib/mdx";

// Geen Tooltip op de Sanity-knop, met opzet: zie AppHeader.

/** De exportknoppen boven het artikel: JSON, MDX, het pakket en Sanity. */
export function ExportToolbar({
  pakket,
  pakketJson,
  packing,
  downloadPackage,
  pushing,
  pushSanity,
  settings,
}: {
  pakket: Pakket | null;
  pakketJson: string;
  packing: boolean;
  downloadPackage: () => Promise<void>;
  pushing: { done: number; total: number } | null;
  pushSanity: () => Promise<void>;
  settings: Settings | null;
}) {
  return (
    <QuietToolbar aria-label="Exporteren">
      <ToolbarButton
        type="button"
        onClick={() => download("pakket.json", pakketJson)}
      >
        <FileJson className="size-3.5" />
        JSON
      </ToolbarButton>
      <ToolbarButton
        type="button"
        onClick={() => pakket && download("artikel.mdx", toMdx(pakket))}
      >
        <FileCode className="size-3.5" />
        MDX
      </ToolbarButton>
      <ToolbarButton
        type="button"
        disabled={packing}
        onClick={() => void downloadPackage()}
      >
        {packing ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Package className="size-3.5" />
        )}
        {packing ? "Inpakken…" : "Pakket"}
      </ToolbarButton>
      <ToolbarRule />
      <ToolbarButton
        type="button"
        disabled={!!pushing || !settings?.sanity?.ready}
        title={
          settings?.sanity?.ready
            ? `Als concept naar ${settings.sanity.projectId} · ${settings.sanity.dataset}`
            : "Vul NEXT_PUBLIC_SANITY_PROJECT_ID, NEXT_PUBLIC_SANITY_DATASET en SANITY_API_TOKEN in .env.local"
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

function download(filename: string, content: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/plain;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
