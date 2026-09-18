"use client";

import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { WisOpslag } from "@/components/article/WisOpslag";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { StoredJob } from "@/lib/client/db";
import { isPakketJob } from "@/lib/client/import";

/**
 * Wat er in deze browser eerder is omgezet. Het staat alleen hier, op deze
 * computer: het archief is Sanity. Daarom ook hoeveel ruimte het inneemt, en een
 * knop om op te ruimen.
 */
export function Earlier({
  jobs,
  storage,
  onOpen,
  onDelete,
}: {
  jobs: Array<StoredJob & { bytes: number }>;
  storage: { usage: number; quota: number } | null;
  onOpen: (id: string) => void;
  onDelete: (id: string) => Promise<void>;
}) {
  const [removing, setRemoving] = useState<string | null>(null);
  /** Het artikel waarvoor de vraag "zeker weten?" open staat. */
  const [confirming, setConfirming] = useState<StoredJob | null>(null);
  return (
    <section className="mt-10 w-full" aria-label="Eerder omgezet" data-tour="earlier">
      <header className="mb-2 flex items-center justify-between gap-4">
        <h3 className="text-sm font-medium">Eerder omgezet</h3>
        <div className="flex items-center gap-2">
          {storage ? (
            <span className="text-xs text-muted-foreground">
              {megabytes(storage.usage)} in deze browser
            </span>
          ) : null}
          <WisOpslag />
        </div>
      </header>
      <ul className="divide-y rounded-xl border bg-card">
        {jobs.map((j) => (
          <li key={j.id} className="flex items-center gap-3 px-3 py-2">
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => onOpen(j.id)}
            >
              <span className="block truncate text-sm">
                {j.document?.frontmatter.title ?? j.filename}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {[
                  new Date(j.createdAt).toLocaleDateString("nl-NL", { day: "numeric", month: "short" }),
                  j.pages.length ? `${j.pageCount} pagina's` : null,
                  isPakketJob(j) ? "geïmporteerd" : null,
                  STATE_LABEL[j.status] ?? j.status,
                  j.edited ? "gecorrigeerd" : null,
                  megabytes(j.bytes),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-destructive"
              disabled={removing === j.id}
              aria-label={`"${j.filename}" verwijderen`}
              title="Verwijderen"
              onClick={() => setConfirming(j)}
            >
              {removing === j.id ? <Loader2 className="animate-spin" /> : <Trash2 />}
            </Button>
          </li>
        ))}
      </ul>
      <Dialog open={confirming != null} onOpenChange={(open) => !open && setConfirming(null)}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Weet je zeker dat je dit wilt verwijderen?</DialogTitle>
            <DialogDescription>
              {confirming ? (
                <>
                  <span className="font-medium text-foreground">
                    {confirming.document?.frontmatter.title ?? confirming.filename}
                  </span>{" "}
                  staat daarna niet meer opgeslagen in deze browser. Dit kun je niet ongedaan maken.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Annuleren</Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={async () => {
                if (!confirming) return;
                const id = confirming.id;
                setConfirming(null);
                setRemoving(id);
                await onDelete(id);
                setRemoving(null);
              }}
            >
              Verwijderen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

const STATE_LABEL: Record<string, string> = {
  uploading: "niet volledig ingelezen",
  ready: "nog niet omgezet",
  running: "gestopt tijdens de run",
  done: "klaar",
  error: "mislukt",
};

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0).replace(".", ",")} MB`;
}

