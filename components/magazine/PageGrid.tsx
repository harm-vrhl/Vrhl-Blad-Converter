"use client";

import { KIND_LABEL } from "@/components/magazine/labels";
import type { Magazine, PageScan } from "@/lib/magazine/types";

/** De pagina's als raster, zolang er nog geen artikelen zijn: wat de scan erin zag. */
export function PageGrid({
  pageCount,
  scans,
  thumbs,
  magazine,
  thumbOf,
}: {
  pageCount: number;
  scans: Record<number, PageScan>;
  thumbs: string[];
  magazine: Magazine | null;
  thumbOf: (pdf: number) => string | undefined;
}) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-4">
      {Array.from({ length: pageCount }, (_, i) => {
        const scan = scans[i + 1];
        const src = thumbs[i] ?? (magazine?.pages.length ? thumbOf(i + 1) : undefined);
        return (
          <div key={i}>
            {src ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={src} alt="" className="w-full rounded-lg bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.06)]" />
            ) : (
              <div className="aspect-[1/1.414] w-full rounded-lg bg-muted/60" />
            )}
            <span className="mt-1.5 block truncate text-xs text-muted-foreground">
              PDF {i + 1}
              {scan ? ` · ${scan.error ? "mislukt" : KIND_LABEL[scan.kind]}${scan.folio ? ` · p. ${scan.folio}` : ""}` : ""}
            </span>
            {scan?.pieces.filter((p) => p.starts).map((p, j) => (
              <span key={j} className="block truncate text-xs text-foreground">
                {p.title ?? "(zonder kop)"}
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}
