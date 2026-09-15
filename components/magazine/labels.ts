import type { MagazineMap, MapArticle } from "@/lib/magazine/types";

export interface StatusLine {
  run: string;
  page?: number;
  state: "start" | "ok" | "fail";
  detail?: string;
}

export const KIND_LABEL: Record<string, string> = {
  omslag: "omslag",
  inhoudsopgave: "inhoudsopgave",
  artikel: "artikel",
  advertentie: "advertentie",
  colofon: "colofon",
  overig: "overig",
};

export function stateOf(line?: StatusLine): "wacht" | "bezig" | "klaar" | "fout" {
  if (!line) return "wacht";
  return line.state === "fail" ? "fout" : line.state === "ok" ? "klaar" : "bezig";
}

/** "12-15, 18" out of printed numbers where they are known, else out of PDF pages. */
export function pageRange(article: MapArticle, printed: boolean): string {
  const useFolios = printed && article.folios.every((f) => f && /^\d+$/.test(f));
  const numbers = useFolios ? article.folios.map(Number) : article.pages;
  const parts: string[] = [];
  let start = numbers[0];
  let prev = numbers[0];
  for (const n of [...numbers.slice(1), NaN]) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}-${prev}`);
    start = n;
    prev = n;
  }
  return (useFolios ? "" : "pdf") + parts.join(",");
}

export function pageLabel(article: MapArticle): string {
  const count = `${article.pages.length} pag.`;
  const opening = article.opening.length > 1 ? " · opent op een spread" : "";
  const printed = pageRange(article, true);
  const where = printed.startsWith("pdf")
    ? `PDF ${printed.replace(/^pdf/, "").replace(/,/g, ", ")}`
    : `p. ${printed.replace(/,/g, ", ")}`;
  return `${where} · ${count}${opening}`;
}

export function money(amount: number, currency: string): string {
  return `${currency} ${amount.toFixed(amount < 1 ? 3 : 2).replace(".", ",")}`;
}

export function summarizeSkipped(map: MagazineMap): string {
  const byKind = new Map<string, number[]>();
  for (const s of map.skipped) byKind.set(s.kind, [...(byKind.get(s.kind) ?? []), s.pdf]);
  return [...byKind]
    .map(([kind, pages]) => `${KIND_LABEL[kind] ?? kind} (PDF ${pages.join(", ")})`)
    .join(" · ");
}
