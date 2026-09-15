"use client";

import { useCallback, useMemo, useState } from "react";
import type { StoredJob } from "@/lib/client/db";
import { packageZip, pushToSanity } from "@/lib/client/exports";
import { toPackage } from "@/lib/canonical";
import type { ArticleDocument } from "@/lib/types";
import { errorMessage } from "@/lib/util";

/** Het afgeronde artikel naar buiten: als pakket, als ZIP en naar Sanity. */
export function useExports({
  job,
  current,
  setNotice,
}: {
  job: StoredJob | null;
  current: ArticleDocument | null;
  setNotice: (notice: string | null) => void;
}) {
  /** Het inpakken van het canonieke pakket leest al het beeld uit de opslag. */
  const [packing, setPacking] = useState(false);
  /** Het duwen naar Sanity, dat eerst het beeld één voor één uploadt. */
  const [pushing, setPushing] = useState<{ done: number; total: number } | null>(null);

  /**
   * Het artikel als Vrhl Content Package: pakket.json plus het beeld, in een ZIP.
   *
   * Wat in de Artikel-tab is rechtgezet gaat mee: het artikel zoals het nu op
   * het scherm staat, niet zoals de run het achterliet. Het inpakken gebeurt in
   * de browser, want daar staat het beeld.
   */
  const downloadPackage = useCallback(async () => {
    if (!job || !current) return;
    setPacking(true);
    setNotice(null);
    try {
      const { blob, name } = await packageZip(job, current);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setNotice(
        `Het pakket kon niet worden gemaakt: ${errorMessage(err)}`,
      );
    } finally {
      setPacking(false);
    }
  }, [job, current]);

  /**
   * Het artikel naar Sanity, als concept.
   *
   * Wat hier weggaat is het pakket, niet het artikelobject: de importer leest
   * hetzelfde formaat dat ook naar MDX of Word gaat, met de correcties erin. De
   * browser stuurt het beeld één voor één; het schrijven zelf gebeurt op de
   * server, want het token hoort de browser nooit te zien.
   */
  const pushSanity = useCallback(async () => {
    if (!job || !current) return;
    setPushing({ done: 0, total: 0 });
    setNotice(null);
    try {
      const body = await pushToSanity(job, current, (done, total) => setPushing({ done, total }));

      const deel = [
        `${body.documents.length} document(en) als concept weggeschreven`,
        body.uploaded ? `${body.uploaded} afbeelding(en) geupload` : null,
        body.created.length ? `nieuw aangemaakt: ${body.created.join(", ")}` : null,
      ].filter(Boolean);
      setNotice(
        `Naar Sanity: ${deel.join(" · ")}.${
          body.warnings.length ? ` Let op: ${body.warnings.join(" · ")}` : ""
        }`,
      );
    } catch (err) {
      setNotice(
        `Het duwen naar Sanity is niet gelukt: ${errorMessage(err)}`,
      );
    } finally {
      setPushing(null);
    }
  }, [job, current]);

  /**
   * Het canonieke pakket, zoals het naar Sanity en in de ZIP gaat.
   *
   * De JSON-tab laat precies dit zien, en de MDX-export wordt hier uit
   * geschreven, net zoals elke andere vertaalslag dat zou doen.
   */
  const pakket = useMemo(
    () => (current ? toPackage(current, { images: job?.images ?? [] }) : null),
    [current, job],
  );
  const pakketJson = useMemo(
    () => (pakket ? JSON.stringify(pakket, null, 2) : ""),
    [pakket],
  );

  return { packing, pushing, downloadPackage, pushSanity, pakket, pakketJson };
}
