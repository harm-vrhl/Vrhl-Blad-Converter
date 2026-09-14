import type { ExtractedImage, ImageSize } from './types';

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
