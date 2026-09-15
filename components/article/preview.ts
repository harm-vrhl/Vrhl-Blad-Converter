import type { StyleFragment } from "@/lib/agents/styling";
import type { StoredJob } from "@/lib/client/db";
import { blankFrontmatter, compileArticle } from "@/lib/compile";
import { parsePage } from "@/lib/pagemarkup";
import { applyStyles } from "@/lib/patch";
import { placeFragments } from "@/lib/place";
import type { ArticleDocument, ExtractedImage, Frontmatter, PageResult, Patch } from "@/lib/types";

// The article as it stands right now, built by the same compileArticle the
// pipeline finishes with. That is the point: the live preview cannot drift
// from the result. The frontmatter appears the moment it is read, and a page
// that is still being written is parsed here from run 1's own output, with
// the same parser the run uses - so the column fills block by block, and
// the page's real result takes over the moment its two runs are done.
//
// The typography is laid on here too, with the same placer the run uses.
// Run 2 no longer waits for run 1, so its marks are usually in before the text
// has finished arriving; placing them here is what lets the reader watch a
// paragraph appear already set rather than watch it change afterwards.
export function livePreview({
  current,
  frontmatter,
  pageResults,
  results,
  text,
  patches,
  fragments,
  approved,
  boxed,
  job,
}: {
  current: ArticleDocument | null;
  frontmatter: Frontmatter | null;
  pageResults: PageResult[];
  results: Record<number, PageResult>;
  text: Record<number, string>;
  patches: Record<number, Patch[]>;
  fragments: Record<number, StyleFragment[]>;
  approved: ExtractedImage[];
  boxed: ExtractedImage[];
  job: StoredJob | null;
}): ArticleDocument | null {
  if (current) return current;

  const pages: PageResult[] = [...pageResults];
  for (const [key, raw] of Object.entries(text)) {
    const page = Number(key);
    if (results[page] || !raw.trim()) continue;
    const { blocks, continuity } = parsePage(page, raw, approved, boxed);
    // The run's placed patches once it has sent them, and until then run 2's
    // own fragments, placed against the text that has arrived so far.
    const marks = patches[page]?.length
      ? patches[page]
      : placeFragments(blocks, fragments[page] ?? []).patches;
    const applied = applyStyles(blocks, marks);
    pages.push({
      page,
      blocks,
      patches: marks,
      dropped: applied.dropped,
      content: applied.content,
      continuity,
      check: { unknown: [], overused: [], score: 1 },
      warnings: [],
    });
  }
  pages.sort((a, b) => a.page - b.page);

  if (!frontmatter && !pages.length) return null;
  return compileArticle(
    frontmatter ?? blankFrontmatter(),
    pages,
    { file: job?.filename ?? "", pages: pages.map((p) => p.page) },
    approved,
  ).document;
}
