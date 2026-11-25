import { pluginThemeRegistry } from '../../infrastructure/config/pluginThemeRegistry';
import { useAppearanceChromeStore } from './appearanceChromeStore';
import { usePluginThemeRevision } from './usePluginThemeRuntime';
import { getSettingsChromeSnapshot, useSettingsChromeStore } from './settingsChromeStore';
import { useLayoutEffect, useRef } from "react";
import type { TerminalTheme } from "../../domain/models";
import {
  applyTopTabsChromeThemeVars,
  clearTopTabsChromeThemeVars,
} from "../app/topTabsChromeTheme";
import { runThemeTransition } from "./themeTransition";
import { TERMINAL_THEMES } from "../../infrastructure/config/terminalThemes";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";
import {
  adjustLightnessToken,
  adjustSaturationToken,
  hexToHslToken,
  resolveReadableForegroundForHsl,
} from "../../domain/colorContrast";

const CSS_VARS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
] as const;

function buildChromeCss(theme: TerminalTheme): string {
  const bg = hexToHslToken(theme.colors.background);
  const fg = hexToHslToken(theme.colors.foreground);
  const cursor = hexToHslToken(theme.colors.cursor);
  const isDark = theme.type === "dark";
  const card = adjustLightnessToken(bg, isDark ? 4 : -3);
  const secondary = adjustLightnessToken(bg, isDark ? 6 : -5);
  const muted = adjustLightnessToken(bg, isDark ? 10 : -8);
  const mutedFg = adjustSaturationToken(adjustLightnessToken(fg, isDark ? -20 : 20), 0.5);
  const border = adjustLightnessToken(bg, isDark ? 12 : -10);
  const primaryFg = resolveReadableForegroundForHsl(cursor);

  const values = [
    bg, fg, card, fg,
    card, fg,
    cursor, primaryFg,
    secondary, fg,
    muted, mutedFg,
    cursor, primaryFg,
    "0 70% 50%", "0 0% 100%",
    border, border, cursor,
  ];

  const rules = CSS_VARS.map((name, index) => `--${name}: ${values[index]} !important`).join("; ");
  return [
    `:root { ${rules}; }`,
    `:root[data-active-chrome-theme] [data-agent-badge] { border-color: hsl(var(--primary) / 0.2) !important; background-color: hsl(var(--primary) / 0.1) !important; }`,
  ].join("\n");
}

const cssCache = new Map<string, string>();
export const CHROME_THEME_CSS_CACHE_MAX_ENTRIES = 256;

export function themeFingerprint(theme: TerminalTheme): string {
  return `${theme.id}\0${theme.type}\0${theme.colors.background}\0${theme.colors.foreground}\0${theme.colors.cursor}`;
}

function getAppliedChromeFingerprint(): string | null {
  if (typeof document === "undefined") return null;
  return document.documentElement.dataset.activeChromeTheme ?? null;
}

function retainChromeCss(fingerprint: string, css: string): string {
  cssCache.delete(fingerprint);
  cssCache.set(fingerprint, css);
  while (cssCache.size > CHROME_THEME_CSS_CACHE_MAX_ENTRIES) {
    const oldestFingerprint = cssCache.keys().next().value as string | undefined;
    if (oldestFingerprint === undefined) break;
    cssCache.delete(oldestFingerprint);
  }
  return css;
}

for (const theme of TERMINAL_THEMES) {
  retainChromeCss(themeFingerprint(theme), buildChromeCss(theme));
}

function getChromeCss(theme: TerminalTheme): string {
  const fingerprint = themeFingerprint(theme);
  let css = cssCache.get(fingerprint);
  if (!css) {
    css = buildChromeCss(theme);
  } else {
    cssCache.delete(fingerprint);
  }
  return retainChromeCss(fingerprint, css);
}

export function _cacheChromeThemeCssForTests(theme: TerminalTheme): void {
  getChromeCss(theme);
}

export function _getChromeThemeCssCacheStatsForTests(): { size: number; keys: string[] } {
  return { size: cssCache.size, keys: [...cssCache.keys()] };
}

const STYLE_ID = "netcatty-active-chrome-theme";
/** Double-rAF window used to let layout settle after a paint. */
export const INSTANT_THEME_SWITCH_SETTLE_FRAMES = 2;

function getAnimationView(root: HTMLElement) {
  return root.ownerDocument?.defaultView ?? globalThis.window;
}

/** Run after instant theme switch finishes suppressing CSS transitions. */
export function scheduleAfterInstantThemeSwitch(
  callback: () => void,
  root: HTMLElement = document.documentElement,
): () => void {
  const view = getAnimationView(root);
  const requestFrame = view?.requestAnimationFrame?.bind(view)
    ?? ((cb: FrameRequestCallback) => globalThis.setTimeout(() => cb(0), 0) as unknown as number);
  const cancelFrame = view?.cancelAnimationFrame?.bind(view)
    ?? ((id: number) => { globalThis.clearTimeout(id); });

  const frameIds: number[] = [];
  const scheduleFrames = (remaining: number) => {
    const frameId = requestFrame(() => {
      const index = frameIds.indexOf(frameId);
      if (index >= 0) frameIds.splice(index, 1);
      if (remaining <= 1) {
        callback();
        return;
      }
      scheduleFrames(remaining - 1);
    });
    frameIds.push(frameId);
  };

  scheduleFrames(INSTANT_THEME_SWITCH_SETTLE_FRAMES);
  return () => {
    for (const frameId of frameIds) cancelFrame(frameId);
  };
}

/**
 * Run one frame after instant theme switch settles so layout transitions can
 * start from the pre-animation state without `transition: none` on :root.
 */
export function scheduleChromeLayoutAnimation(
  callback: () => void,
  root: HTMLElement = document.documentElement,
): () => void {
  let layoutFrameId = 0;
  const cancelSettle = scheduleAfterInstantThemeSwitch(() => {
    const view = getAnimationView(root);
    const requestFrame = view?.requestAnimationFrame?.bind(view)
      ?? ((cb: FrameRequestCallback) => globalThis.setTimeout(() => cb(0), 0) as unknown as number);
    layoutFrameId = requestFrame(() => callback());
  }, root);
  return () => {
    cancelSettle();
    const view = getAnimationView(root);
    const cancelFrame = view?.cancelAnimationFrame?.bind(view)
      ?? ((id: number) => { globalThis.clearTimeout(id); });
    if (layoutFrameId) cancelFrame(layoutFrameId);
  };
}

function removeActiveChromeTheme() {
  document.getElementById(STYLE_ID)?.remove();
  delete document.documentElement.dataset.activeChromeTheme;
}

function applyActiveChromeTheme(theme: TerminalTheme) {
  runThemeTransition(() => {
    const root = document.documentElement;
    const targetClass = theme.type === "dark" ? "dark" : "light";
    root.classList.remove("light", "dark");
    root.classList.add(targetClass);

    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      document.head.appendChild(style);
    }
    style.textContent = getChromeCss(theme);
    root.dataset.activeChromeTheme = themeFingerprint(theme);
    refreshActiveChromeThemeSurfaces(theme);
  }, { mode: "instant" });
}

function refreshActiveChromeThemeSurfaces(theme: TerminalTheme) {
  if (typeof window !== "undefined") {
    // Preserve OS preference events instead of locking nativeTheme to the chrome type.
    const targetClass = theme.type === "dark" ? "dark" : "light";
    const themeSource = getSettingsChromeSnapshot().theme === "system" ? "system" : targetClass;
    netcattyBridge.get()?.setTheme?.(themeSource);
    netcattyBridge.get()?.setBackgroundColor?.(theme.colors.background);
  }
  applyTopTabsChromeThemeVars(theme);
}

export function syncActiveChromeTheme(
  activeTheme: TerminalTheme | null,
  applyAppTheme: () => void,
  { refreshSurfaces = false }: { refreshSurfaces?: boolean } = {},
): void {
  const nextFingerprint = activeTheme ? themeFingerprint(activeTheme) : null;
  const appliedFingerprint = getAppliedChromeFingerprint();
  if (nextFingerprint === appliedFingerprint && !(activeTheme && refreshSurfaces)) {
    return;
  }

  if (activeTheme) {
    applyActiveChromeTheme(activeTheme);
    return;
  }

  clearTopTabsChromeThemeVars();
  runThemeTransition(() => {
    removeActiveChromeTheme();
    applyAppTheme();
  }, { mode: "instant" });
}

export function useActiveChromeTheme({
  activeTheme,
  applyAppTheme,
}: {
  activeTheme: TerminalTheme | null;
  applyAppTheme: () => void;
}) {
  const pluginThemeRevision = usePluginThemeRevision();
  const { theme, resolvedTheme, lightUiThemeId, darkUiThemeId } = useSettingsChromeStore();
  const { accentMode, customAccent } = useAppearanceChromeStore();
  const effectiveTheme = pluginThemeRegistry.isActive(resolvedTheme) ? null : activeTheme;
  const applyAppThemeRef = useRef(applyAppTheme);
  applyAppThemeRef.current = applyAppTheme;
  const prevSurfaceTriggersRef = useRef({
    theme,
    resolvedTheme,
    lightUiThemeId,
    darkUiThemeId,
    accentMode,
    customAccent,
    pluginThemeRevision,
    applyAppTheme,
  });

  useLayoutEffect(() => {
    const prev = prevSurfaceTriggersRef.current;
    const refreshSurfaces =
      prev.theme !== theme ||
      prev.resolvedTheme !== resolvedTheme ||
      prev.lightUiThemeId !== lightUiThemeId ||
      prev.darkUiThemeId !== darkUiThemeId ||
      prev.accentMode !== accentMode ||
      prev.customAccent !== customAccent ||
      prev.pluginThemeRevision !== pluginThemeRevision ||
      prev.applyAppTheme !== applyAppTheme;
    prevSurfaceTriggersRef.current = {
      theme,
      resolvedTheme,
      lightUiThemeId,
      darkUiThemeId,
      accentMode,
      customAccent,
      pluginThemeRevision,
      applyAppTheme,
    };

    // Settings or plugin themes may have just applied the app theme over a fixed
    // terminal theme. Reassert its visual surfaces only when one of those
    // surface-refresh triggers changed; same-theme tab switches retain the
    // default fingerprint fast path.
    syncActiveChromeTheme(effectiveTheme, applyAppTheme, { refreshSurfaces });
  }, [
    effectiveTheme,
    applyAppTheme,
    pluginThemeRevision,
    theme,
    resolvedTheme,
    lightUiThemeId,
    darkUiThemeId,
    accentMode,
    customAccent,
  ]);

  useLayoutEffect(() => {
    return () => {
      removeActiveChromeTheme();
      clearTopTabsChromeThemeVars();
      applyAppThemeRef.current();
    };
  }, []);
}
