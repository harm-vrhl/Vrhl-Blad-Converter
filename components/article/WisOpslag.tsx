"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
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
import { clearAll, estimate, listJobs, listMagazines } from "@/lib/client/db";
import { errorMessage } from "@/lib/util";

/**
 * Knop om alles in deze browser te wissen. Vraagt eerst of het zeker is, en
 * herlaadt daarna het scherm zodat er niets in het geheugen achterblijft.
 */
export function WisOpslag({
  auto = false,
}: {
  /**
   * Zelf kijken of er jobs of magazines staan, en hoeveel ruimte het inneemt.
   * Voor startschermen die de artikellijst niet hebben.
   */
  auto?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(!auto);
  const [bytes, setBytes] = useState<number | null>(null);

  useEffect(() => {
    if (!auto) return;
    void (async () => {
      try {
        const [jobs, magazines, space] = await Promise.all([listJobs(), listMagazines(), estimate()]);
        setVisible(jobs.length + magazines.length > 0);
        setBytes(space?.usage ?? null);
      } catch {
        setVisible(false);
      }
    })();
  }, [auto]);

  if (!visible) return null;

  return (
    <>
      {auto ? (
        <div className="mt-8 flex items-center justify-center gap-3">
          {bytes != null ? (
            <span className="text-xs text-muted-foreground">{megabytes(bytes)} in deze browser</span>
          ) : null}
          <Knop busy={busy} onClick={() => setConfirming(true)} />
        </div>
      ) : (
        <Knop busy={busy} onClick={() => setConfirming(true)} />
      )}
      <Dialog open={confirming} onOpenChange={(open) => !open && !busy && setConfirming(false)}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Weet je zeker dat je alles wilt verwijderen?</DialogTitle>
            <DialogDescription>
              Alle artikelen, magazines, foto&apos;s en tussenresultaten verdwijnen uit deze
              browser. Dit kun je niet ongedaan maken.
              {error ? (
                <>
                  {" "}
                  <span className="text-destructive">{error}</span>
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={busy}>
                Annuleren
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await clearAll();
                  window.location.reload();
                } catch (err) {
                  setBusy(false);
                  setError(errorMessage(err));
                }
              }}
            >
              {busy ? <Loader2 className="animate-spin" /> : null}
              Alles verwijderen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Knop({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="text-muted-foreground hover:text-destructive"
      disabled={busy}
      onClick={onClick}
    >
      {busy ? <Loader2 className="animate-spin" /> : null}
      Alles wissen
    </Button>
  );
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0).replace(".", ",")} MB`;
}
