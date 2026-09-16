"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getData, putData, type StoredJob } from "@/lib/client/db";
import { controleer, oordeel } from "@/lib/controle";
import type { ArticleDocument, ImageVerdict, OcrPage, PageResult } from "@/lib/types";

/**
 * Onder `run/`, zodat een nieuwe run zonder hervatten het afvinken wist: dan is
 * de tekst opnieuw geschreven, en wat was nagekeken is dat niet meer. Hervatten
 * laat het staan.
 */
const NAGEKEKEN = "run/nagekeken";

/**
 * De bevindingen van de Controle-tab en wat ervan is afgevinkt.
 *
 * Het rekenwerk staat in `lib/controle.ts`; dit laadt wat daarvoor nodig is uit de
 * opslag (de OCR, die niet in de state van de run zit) en onthoudt het afvinken.
 * Gerekend wordt op het artikel zoals het nu op het scherm staat, met de
 * correcties erin: wie een verzonnen woord in de Artikel-tab weghaalt, ziet de
 * melding verdwijnen.
 */
export function useControle({
  job,
  current,
  pageResults,
  verdicts,
}: {
  job: StoredJob | null;
  current: ArticleDocument | null;
  pageResults: PageResult[];
  verdicts: ImageVerdict[];
}) {
  const jobId = job?.id ?? null;
  const klaar = !!current;
  const [ocr, setOcr] = useState<OcrPage[] | null>(null);
  const [nagekeken, setNagekeken] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    setOcr(null);
    setNagekeken(new Set());
    if (!jobId || !klaar) return;
    // De OCR wordt tijdens de run weggeschreven; pas als het artikel klaar is, staat hij er.
    void Promise.all([getData<OcrPage[]>(jobId, "ocr.json"), getData<string[]>(jobId, NAGEKEKEN)]).then(
      ([gelezen, afgevinkt]) => {
        if (!live) return;
        setOcr(gelezen ?? []);
        setNagekeken(new Set(afgevinkt ?? []));
      },
    );
    return () => {
      live = false;
    };
  }, [jobId, klaar]);

  const bevindingen = useMemo(
    () =>
      current && ocr
        ? controleer({ document: current, pages: pageResults, ocr, images: job?.images ?? [], verdicts })
        : [],
    [current, pageResults, ocr, job, verdicts],
  );
  const stand = useMemo(() => oordeel(bevindingen, nagekeken), [bevindingen, nagekeken]);

  const toggle = useCallback(
    (id: string) => {
      setNagekeken((vorige) => {
        const volgende = new Set(vorige);
        if (volgende.has(id)) volgende.delete(id);
        else volgende.add(id);
        if (jobId) void putData(jobId, NAGEKEKEN, [...volgende]);
        return volgende;
      });
    },
    [jobId],
  );

  return {
    bevindingen,
    oordeel: stand,
    nagekeken,
    toggle,
    /** Null zolang er nog geladen wordt; leeg als de OCR van deze job niet bewaard is. */
    ocrBeschikbaar: ocr === null ? null : ocr.length > 0,
  };
}
