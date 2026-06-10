import { extractPrimaryFamily } from './fontAvailability';

/** Weights actually shipped via @fontsource in index.tsx. */
export const BUNDLED_FONT_WEIGHTS: Readonly<Record<string, readonly number[]>> = {
  'JetBrains Mono': [400, 500, 600],
};

export type FontWeightMeasureContext = {
  measureText: (font: string, text: string) => TextMetrics;
};

const BOLD_PROBE = 'WMwm0123456789';

export function pickNearestBundledWeight(
  available: readonly number[],
  desired: number,
  normal: number,
): number {
  if (available.includes(desired)) return desired;
  const heavier = available.filter((weight) => weight > normal);
  if (heavier.length === 0) return normal;
  return heavier.reduce((best, weight) =>
    Math.abs(weight - desired) < Math.abs(best - desired) ? weight : best,
  );
}

/**
 * True when rendering `boldWeight` produces measurably different glyphs than
 * `normalWeight` for `family`. Unlike document.fonts.check(), this does not
 * false-positive on syntactically valid but unavailable families/weights in
 * Chromium (see fontAvailability.ts).
 */
export function isBoldWeightDistinctWithContext(
  family: string,
  normalWeight: number,
  boldWeight: number,
  fontSize: number,
  ctx: FontWeightMeasureContext,
): boolean {
  if (boldWeight <= normalWeight) return false;

  const quoted = /\s/.test(family) ? `"${family}"` : family;
  const normalFont = `${normalWeight} ${fontSize}px ${quoted}, monospace`;
  const boldFont = `${boldWeight} ${fontSize}px ${quoted}, monospace`;

  const normalMetrics = ctx.measureText(normalFont, BOLD_PROBE);
  const boldMetrics = ctx.measureText(boldFont, BOLD_PROBE);

  if (Math.abs(boldMetrics.width - normalMetrics.width) > 0.01) return true;

  const normalAscent = normalMetrics.actualBoundingBoxAscent ?? 0;
  const boldAscent = boldMetrics.actualBoundingBoxAscent ?? 0;
  if (Math.abs(boldAscent - normalAscent) > 0.01) return true;

  const normalDescent = normalMetrics.actualBoundingBoxDescent ?? 0;
  const boldDescent = boldMetrics.actualBoundingBoxDescent ?? 0;
  return Math.abs(boldDescent - normalDescent) > 0.01;
}

function buildBrowserMeasureContext(): FontWeightMeasureContext | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  return {
    measureText: (font, text) => {
      ctx.font = font;
      return ctx.measureText(text);
    },
  };
}

/**
 * Resolve the boldest weight xterm can safely rasterize for the primary font.
 * Falls back to `normalWeight` when the requested bold face is unavailable.
 */
export function resolveFontWeightBold(args: {
  fontFamilyCss: string;
  normalWeight: number;
  desiredBoldWeight: number;
  fontSize: number;
}): number {
  const { fontFamilyCss, normalWeight, desiredBoldWeight, fontSize } = args;
  if (desiredBoldWeight <= normalWeight) return normalWeight;

  const primary = extractPrimaryFamily(fontFamilyCss);
  const bundled = BUNDLED_FONT_WEIGHTS[primary];
  if (bundled) {
    return pickNearestBundledWeight(bundled, desiredBoldWeight, normalWeight);
  }

  const ctx = buildBrowserMeasureContext();
  if (!ctx) return desiredBoldWeight;

  return isBoldWeightDistinctWithContext(
    primary,
    normalWeight,
    desiredBoldWeight,
    fontSize,
    ctx,
  )
    ? desiredBoldWeight
    : normalWeight;
}
