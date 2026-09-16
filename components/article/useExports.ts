"use client";

import { useCallback, useMemo, useState } from "react";
import type { StoredJob } from "@/lib/client/db";
import { exportFile, pushToSanity, type ExportFormaat } from "@/lib/client/exports";
import { toPackage } from "@/lib/canonical";
import type { ArticleDocument } from "@/lib/types";
import { errorMessage } from "@/lib/util";

/** Het afgeronde artikel naar buiten: als download in een van de formaten, en naar Sanity. */
export function useExports({
  job,
  current,
  setNotice,
}: {
  job: StoredJob | null;
  current: ArticleDocument | null;
  setNotice: (notice: string | null) => void;
}) {
  /** Welk formaat er nu gemaakt wordt. HTML, Word en de ZIP lezen al het beeld uit de opslag. */
  const [exporting, setExporting] = useState<ExportFormaat | null>(null);
  /** Het duwen naar Sanity, dat eerst het beeld één voor één uploadt. */
  const [pushing, setPushing] = useState<{ done: number; total: number } | null>(null);

  /**
   * Het artikel als download: JSON, HTML, MDX, Word of het pakket als ZIP.
   *
   * Wat in de Artikel-tab is rechtgezet gaat mee: het artikel zoals het nu op
   * het scherm staat, niet zoals de run het achterliet. Het maken gebeurt in de
   * browser, want daar staat het beeld.
   */
  const exportAs = useCallback(
    async (formaat: ExportFormaat) => {
      if (!job || !current) return;
      setExporting(formaat);
      setNotice(null);
      try {
        const { blob, name } = await exportFile(job, current, formaat);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        // Pas later vrijgeven: sommige browsers beginnen de download pas na deze tik.
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      } catch (err) {
        setNotice(`De export kon niet worden gemaakt: ${errorMessage(err)}`);
      } finally {
        setExporting(null);
      }
    },
    [job, current],
  );

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

  return { exporting, pushing, exportAs, pushSanity, pakket, pakketJson };
}
