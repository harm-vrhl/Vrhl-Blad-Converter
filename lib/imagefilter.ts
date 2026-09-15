import type { Block, ExtractedImage, ImageKind, ImageSize, ImageVerdict } from './types';

const NEVER_CONTENT: ImageKind[] = ['logo', 'ornament', 'rule'];

/**
 * Pictures the triage set aside as an advert or another piece's, that may still
 * stand inside a box of this article. The triage sees a tinted panel with a web
 * address and calls it an advert; run 1 decides whether that panel is part of the
 * article. When it puts the box in, the pictures printed inside it belong there
 * too, so run 1 gets them - to be placed inside a box and nowhere else.
 */
export function boxOnly(images: ExtractedImage[], verdicts: ImageVerdict[]): ExtractedImage[] {
  const setAside = new Set(verdicts.filter((v) => !v.keep && !NEVER_CONTENT.includes(v.kind)).map((v) => v.id));
  return images.filter((image) => setAside.has(image.id));
}

/** The verdicts, with every set-aside picture that run 1 placed inside a box turned back into a keep. */
export function rescueBoxed(verdicts: ImageVerdict[], pages: Array<{ blocks: Block[] }>): { verdicts: ImageVerdict[]; rescued: string[] } {
  const boxed = new Set(
    pages.flatMap((p) =>
      p.blocks
        .filter((b) => b.type === 'insert')
        .flatMap((b) => (b.children ?? []).filter((c) => c.type === 'image' && c.ref).map((c) => c.ref as string))
    )
  );
  const rescued: string[] = [];
  const next = verdicts.map((v) => {
    if (v.keep || !boxed.has(v.id)) return v;
    rescued.push(v.id);
    return { ...v, keep: true, reason: `staat in een kader van het artikel (eerst afgewezen: ${v.reason})` };
  });
  return { verdicts: next, rescued };
}

/**
 * How wide the image is printed, as a share of the page. The reader has four
 * widths for an image and this is a measurement, not a judgement, so it is taken
 * here rather than asked of a model: a cut-out beside the column is small, an
 * image over the text column is normal, half a page is large, a spread is xlarge.
 */
export function printedSize(image: ExtractedImage): ImageSize {
  if (image.areaPct < 6) return 'small';
  if (image.areaPct < 25) return 'normal';
  if (image.areaPct < 55) return 'large';
  return 'xlarge';
}

/**
 * The cheap half of judging an image. A hairline rule, a decorative initial or a
 * three-pixel spacer is not a judgement call, so it never needs to reach a model.
 */
export function obviouslyDecorative(image: ExtractedImage): string | null {
  // A shard of a sliced picture is never placed on its own: the whole is, or nothing.
  if (image.partOf === 'tekst') {
    return 'stuk van een opgeknipt beeld; samenvoegen zou een tekstkader meenemen, dus weggelaten';
  }
  if (image.partOf) return `stuk van een opgeknipt beeld, samengevoegd tot ${image.partOf}`;

  if (image.width < 20 || image.height < 20) {
    return `bitmap van ${image.width}x${image.height} pixels, te klein om inhoud te zijn`;
  }

  const { w, h } = image.placed;
  if (w < 8 || h < 8) return `staat als ${w}x${h}pt op de pagina, niet meer dan een lijn`;

  const aspect = w / h;
  if (aspect > 20 || aspect < 1 / 20) return 'streep of kaderlijn, geen beeld';

  if (image.areaPct < 0.15) return `beslaat ${image.areaPct}% van de pagina, ornament`;

  return null;
}
