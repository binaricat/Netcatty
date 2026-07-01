import { useLayoutEffect, useRef } from "react";
import type { TerminalTheme } from "../../domain/models";
import {
  applyTopTabsChromeThemeVars,
  clearTopTabsChromeThemeVars,
} from "../app/topTabsChromeTheme";
import { runThemeTransition } from "./themeTransition";
import { TERMINAL_THEMES } from "../../infrastructure/config/terminalThemes";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";
import { resolveReadableForegroundForHsl } from "../../domain/colorContrast";

function hexToHsl(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      default:
        h = ((r - g) / d + 4) / 6;
        break;
    }
  }
  return `${Math.round(h * 3600) / 10} ${Math.round(s * 1000) / 10}% ${Math.round(l * 1000) / 10}%`;
}

function adjustLightness(hsl: string, delta: number): string {
  const parts = hsl.split(/\s+/);
  const nextLightness = Math.max(0, Math.min(100, parseFloat(parts[2]) + delta));
  return `${parts[0]} ${parts[1]} ${Math.round(nextLightness * 10) / 10}%`;
}

function adjustSaturation(hsl: string, factor: number): string {
  const parts = hsl.split(/\s+/);
  const nextSaturation = Math.max(0, Math.min(100, parseFloat(parts[1]) * factor));
  return `${parts[0]} ${Math.round(nextSaturation * 10) / 10}% ${parts[2]}`;
}

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
  const bg = hexToHsl(theme.colors.background);
  const fg = hexToHsl(theme.colors.foreground);
  const cursor = hexToHsl(theme.colors.cursor);
  const isDark = theme.type === "dark";
  const card = adjustLightness(bg, isDark ? 4 : -3);
  const secondary = adjustLightness(bg, isDark ? 6 : -5);
  const muted = adjustLightness(bg, isDark ? 10 : -8);
  const mutedFg = adjustSaturation(adjustLightness(fg, isDark ? -20 : 20), 0.5);
  const border = adjustLightness(bg, isDark ? 12 : -10);
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

export function themeFingerprint(theme: TerminalTheme): string {
  return `${theme.id}\0${theme.type}\0${theme.colors.background}\0${theme.colors.foreground}\0${theme.colors.cursor}`;
}

function getAppliedChromeFingerprint(): string | null {
  if (typeof document === "undefined") return null;
  return document.documentElement.dataset.activeChromeTheme ?? null;
}

for (const theme of TERMINAL_THEMES) {
  cssCache.set(themeFingerprint(theme), buildChromeCss(theme));
}

function getChromeCss(theme: TerminalTheme): string {
  const fingerprint = themeFingerprint(theme);
  let css = cssCache.get(fingerprint);
  if (!css) {
    css = buildChromeCss(theme);
    cssCache.set(fingerprint, css);
  }
  return css;
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
  const targetClass = theme.type === "dark" ? "dark" : "light";
  if (typeof window !== "undefined") {
    netcattyBridge.get()?.setTheme?.(targetClass);
    netcattyBridge.get()?.setBackgroundColor?.(theme.colors.background);
  }
  applyTopTabsChromeThemeVars(theme);
}

export function syncActiveChromeTheme(
  activeTheme: TerminalTheme | null,
  applyAppTheme: () => void,
): void {
  const nextFingerprint = activeTheme ? themeFingerprint(activeTheme) : null;
  const appliedFingerprint = getAppliedChromeFingerprint();
  if (nextFingerprint === appliedFingerprint) {
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
  const applyAppThemeRef = useRef(applyAppTheme);
  applyAppThemeRef.current = applyAppTheme;

  useLayoutEffect(() => {
    syncActiveChromeTheme(activeTheme, applyAppTheme);
  }, [activeTheme, applyAppTheme]);

  useLayoutEffect(() => {
    return () => {
      removeActiveChromeTheme();
      clearTopTabsChromeThemeVars();
      applyAppThemeRef.current();
    };
  }, []);
}
