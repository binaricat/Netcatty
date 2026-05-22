/**
 * Watches for devicePixelRatio changes (e.g. moving the window between monitors
 * with different DPI, or changing the OS display scaling on Windows) and invokes
 * a callback so the renderer can be repaired.
 *
 * The WebGL renderer caches rasterized glyphs in a texture atlas keyed to the
 * device pixel ratio at creation time. When the ratio changes the cached glyphs
 * are drawn at the wrong scale, producing the persistent "garbled / 花屏"
 * corruption reported in issue #1049 that only goes away when a brand-new
 * terminal is opened. xterm.js recommends calling `clearTextureAtlas()` on DPR
 * change so glyphs re-rasterize at the new scale.
 *
 * `matchMedia('(resolution: Ndppx)')` only matches a single ratio, so after each
 * change we must re-register the listener against the new ratio.
 */
export interface MediaQueryListLike {
  addEventListener?: (type: "change", listener: () => void) => void;
  removeEventListener?: (type: "change", listener: () => void) => void;
  // Legacy API (older Safari / Electron) where addEventListener is unavailable.
  addListener?: (listener: () => void) => void;
  removeListener?: (listener: () => void) => void;
}

export interface WatchDevicePixelRatioOptions {
  getDevicePixelRatio: () => number;
  matchMedia: (query: string) => MediaQueryListLike;
  onChange: () => void;
}

/**
 * Start watching for devicePixelRatio changes. Returns a cleanup function that
 * removes the active listener.
 */
export function watchDevicePixelRatio(
  options: WatchDevicePixelRatioOptions,
): () => void {
  const { getDevicePixelRatio, matchMedia, onChange } = options;
  let current: { mql: MediaQueryListLike; listener: () => void } | null = null;

  const detach = () => {
    if (!current) return;
    const { mql, listener } = current;
    if (mql.removeEventListener) {
      mql.removeEventListener("change", listener);
    } else if (mql.removeListener) {
      mql.removeListener(listener);
    }
    current = null;
  };

  const attach = () => {
    const dpr = getDevicePixelRatio();
    const mql = matchMedia(`(resolution: ${dpr}dppx)`);
    const listener = () => {
      // A media query only matches the ratio it was created with, so detach the
      // stale listener and re-register against the new ratio before notifying.
      detach();
      attach();
      onChange();
    };
    if (mql.addEventListener) {
      mql.addEventListener("change", listener);
    } else if (mql.addListener) {
      mql.addListener(listener);
    }
    current = { mql, listener };
  };

  attach();

  return detach;
}
