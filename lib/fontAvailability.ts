/**
 * Decides whether a CSS font-family is actually rendered (system-installed
 * or loaded via @font-face) on the current machine. Used to filter the
 * terminal font dropdowns.
 *
 * Why not document.fonts.check(): in Chromium it returns true for any
 * syntactically-valid family name regardless of whether that font is
 * actually installed (a deliberate fingerprinting-mitigation choice), so
 * it produces massive false positives. We rely instead on:
 *
 *   1. KNOWN_BUNDLED_FAMILIES — fonts we ship via @font-face / @fontsource.
 *      Always true.
 *   2. setSystemFamilies() — an authoritative Set populated by fontStore
 *      after Local Font Access API returns. Membership lookup. When
 *      populated, this is the only signal needed for system fonts.
 *   3. Canvas width fallback — used only before setSystemFamilies() runs
 *      or when the Font Access API is unavailable / denied. A font counts
 *      as installed only when its rendered width differs from ALL three
 *      generic fallbacks (serif, sans-serif, monospace).
 */

import { splitFontFamilyList } from '../infrastructure/config/cjkFonts';

const KNOWN_BUNDLED_FAMILIES = new Set<string>([
  'JetBrains Mono',     // @fontsource/jetbrains-mono (400, 500, 600)
  'Sarasa Mono SC',     // public/fonts/SarasaMonoSC-Regular.woff2 (OFL)
]);

let systemFamilies: Set<string> | null = null;
let availabilityVersion = 0;
const listeners = new Set<() => void>();

/**
 * "Fira Code", monospace → Fira Code   |   Menlo, monospace → Menlo.
 * Quote-aware so a single family name containing commas (CSS permits
 * `"Foo, Inc. Mono"`) survives intact instead of being truncated.
 */
export function extractPrimaryFamily(familyCssString: string): string {
  const first = splitFontFamilyList(familyCssString)[0] ?? '';
  return first.replace(/^["']|["']$/g, '');
}

/**
 * Called by fontStore once Local Font Access API has returned the full
 * list of installed family names (lower-cased). After this runs,
 * isFontInstalled answers from this authoritative set rather than from
 * canvas measurement.
 *
 * Notifies subscribers so React components memoizing on availability
 * can recompute (e.g. dropdown filters that called isFontInstalled
 * before authoritative data arrived).
 */
export function setSystemFamilies(families: Set<string> | null): void {
  systemFamilies = families;
  availabilityVersion += 1;
  for (const listener of listeners) listener();
}

/** True when authoritative system data is available; canvas fallback skipped. */
export function hasAuthoritativeData(): boolean {
  return systemFamilies !== null;
}

/**
 * Subscribe to changes in font availability. Returns an unsubscribe fn.
 * Used together with getFontAvailabilityVersion() and
 * useSyncExternalStore in React components that filter on
 * isFontInstalled() — so their useMemo dependencies invalidate when
 * the authoritative install set is populated or cleared.
 */
export function subscribeFontAvailability(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

/** Monotonically increasing version, bumped on every setSystemFamilies. */
export function getFontAvailabilityVersion(): number {
  return availabilityVersion;
}

const cache = new Map<string, boolean>();

interface DetectionContext {
  measureText: (font: string, text: string) => number;
}

const TEST_STRING = 'mmmmmmmmmmlli';
const FALLBACK_FAMILIES = ['serif', 'sans-serif', 'monospace'] as const;

function buildBrowserContext(): DetectionContext | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  return {
    measureText: (font, text) => {
      ctx.font = font;
      return ctx.measureText(text).width;
    },
  };
}

/**
 * Pure detection logic — exported for testing without a DOM.
 *
 * Returns true if rendering the probe string against ANY of the three
 * generic fallbacks (serif, sans-serif, monospace) with the target font
 * listed first produces a different width than the bare generic. We use
 * "some" rather than "every" because some platform defaults make a
 * generic family literally identical to a real installed font — for
 * example on macOS the `monospace` generic resolves to Menlo, so
 * measure("'Menlo', monospace") === measure("monospace"). Requiring all
 * three to differ would then falsely report Menlo as missing. A truly
 * uninstalled font falls through to each generic in turn and matches
 * all three, so "some" still correctly returns false for those.
 */
export function detectInstalledWithContext(
  family: string,
  ctx: DetectionContext,
): boolean {
  if (KNOWN_BUNDLED_FAMILIES.has(family)) return true;
  return FALLBACK_FAMILIES.some((fb) => {
    const baseWidth = ctx.measureText(`72px ${fb}`, TEST_STRING);
    const targetWidth = ctx.measureText(`72px "${family}", ${fb}`, TEST_STRING);
    return baseWidth !== targetWidth;
  });
}

export function isFontInstalled(family: string): boolean {
  if (KNOWN_BUNDLED_FAMILIES.has(family)) return true;

  // Authoritative path: Local Font Access API enumeration.
  if (systemFamilies) {
    return systemFamilies.has(family.toLowerCase());
  }

  // Fallback path: canvas measurement, cached per family. Only used
  // before setSystemFamilies has run, or when the API is denied.
  const cached = cache.get(family);
  if (cached !== undefined) return cached;

  const ctx = buildBrowserContext();
  // No DOM (SSR / tests) and no authoritative data → treat as available
  // so we don't aggressively hide everything.
  if (!ctx) {
    cache.set(family, true);
    return true;
  }

  const result = detectInstalledWithContext(family, ctx);
  cache.set(family, result);
  return result;
}

export function clearFontAvailabilityCache(): void {
  cache.clear();
  systemFamilies = null;
  availabilityVersion += 1;
  for (const listener of listeners) listener();
}
