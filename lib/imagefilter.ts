import type { ExtractedImage } from './types';

/**
 * The cheap half of judging an image. A hairline rule, a decorative initial or a
 * three-pixel spacer is not a judgement call, so it never needs to reach a model.
 */
export function obviouslyDecorative(image: ExtractedImage): string | null {
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
