import { extractPrimaryFamily } from './fontAvailability';

/** Weights actually shipped via @fontsource in index.tsx. */
export const BUNDLED_FONT_WEIGHTS: Readonly<Record<string, readonly number[]>> = {
  'JetBrains Mono': [400, 500, 600],
};

export type FontWeightMeasureContext = {
  measureText: (font: string, text: string) => TextMetrics;
  /**
   * Optional stroke-ink probe: total alpha coverage of `text` rendered with
   * `font` on an offscreen canvas. Unlike geometric TextMetrics, ink coverage
   * distinguishes real heavier weights even in metric-aligned monospace
   * (variable) fonts where width/ascent/descent stay identical across `wght`.
   */
  measureTextInk?: (font: string, text: string) => number;
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
 *
 * Compares geometric TextMetrics first, then, for metric-aligned monospace
 * variable fonts where every geometric delta is ~0 (#3335), actual stroke
 * ink coverage via `measureTextInk`.
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
  if (Math.abs(boldDescent - normalDescent) > 0.01) return true;

  // Metric-aligned monospace fonts (especially variable fonts such as
  // Roboto Mono VF) keep advance width, cap height and baseline contact
  // constant across the wght axis by design, so the geometric probes above
  // all read ~0 even though the bold instance carries ~25% more ink.
  // Fall back to comparing actual stroke coverage, which is what font
  // weight really is (#3335).
  if (!ctx.measureTextInk) return false;
  const normalInk = ctx.measureTextInk(normalFont, BOLD_PROBE);
  const boldInk = ctx.measureTextInk(boldFont, BOLD_PROBE);
  if (normalInk <= 0) return boldInk > 0;
  return boldInk / normalInk >= 1 + BOLD_INK_RATIO_THRESHOLD;
}

/**
 * Relative ink increase required to accept a bold weight once the geometric
 * probes are inconclusive. Real heavier weights add far more than this
 * (Roboto Mono 400 to 700 is about +25%); identical rendering differs by ~0%.
 */
const BOLD_INK_RATIO_THRESHOLD = 0.03;

let inkCanvas: HTMLCanvasElement | null = null;
let inkCtx: CanvasRenderingContext2D | null = null;

/**
 * Sum of the alpha channel for `text` rasterized with `font`: a direct
 * measure of stroke ink, so a heavier weight always reads higher even when
 * every geometric metric is identical across the wght axis (#3335).
 */
function measureInkCoverage(ctx: CanvasRenderingContext2D, font: string, text: string): number {
  const sizeMatch = font.match(/(\d+(?:\.\d+)?)px/);
  const px = sizeMatch ? parseFloat(sizeMatch[1]) : 16;
  // Measure with the target font so ascent/descent/width reflect the actual
  // glyphs (the context's default font would undersize the canvas and clip).
  ctx.font = font;
  const metrics = ctx.measureText(text);
  const ascent = Math.ceil(metrics.actualBoundingBoxAscent || px * 0.8) + 2;
  const descent = Math.ceil(metrics.actualBoundingBoxDescent || px * 0.2) + 2;
  const width = Math.ceil(Math.abs(metrics.width)) + 4;
  if (width <= 4 || ascent + descent <= 4) return 0;

  if (!inkCanvas) {
    inkCanvas = document.createElement('canvas');
    inkCtx = inkCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (!inkCtx) return 0;
  inkCanvas.width = width;
  inkCanvas.height = ascent + descent;

  inkCtx.clearRect(0, 0, width, ascent + descent);
  inkCtx.font = font;
  inkCtx.fillStyle = '#fff';
  inkCtx.textBaseline = 'alphabetic';
  inkCtx.fillText(text, 2, ascent);
  const data = inkCtx.getImageData(0, 0, width, ascent + descent).data;
  let ink = 0;
  for (let i = 3; i < data.length; i += 4) ink += data[i];
  return ink;
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
    measureTextInk: (font, text) => {
      if (!inkCtx) {
        inkCanvas = document.createElement('canvas');
        inkCtx = inkCanvas.getContext('2d', { willReadFrequently: true });
      }
      return inkCtx ? measureInkCoverage(inkCtx, font, text) : 0;
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
