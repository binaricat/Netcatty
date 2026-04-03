/**
 * Immersive Mode — makes the entire UI chrome adapt colors to match the active terminal's theme.
 *
 * Performance strategy:
 * - All built-in themes' CSS strings are pre-computed at module load (zero cost at switch time)
 * - Custom/unknown themes are computed lazily and cached
 * - A single `<style>` tag with `!important` overrides inline CSS variables atomically
 * - `useLayoutEffect` ensures the update happens before browser paint (no flash)
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { TerminalTheme } from '../../domain/models';
import { TERMINAL_THEMES } from '../../infrastructure/config/terminalThemes';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

// ---------------------------------------------------------------------------
// Hex → HSL conversion (returns "H S% L%" without the hsl() wrapper)
// ---------------------------------------------------------------------------

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
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }
  return `${Math.round(h * 3600) / 10} ${Math.round(s * 1000) / 10}% ${Math.round(l * 1000) / 10}%`;
}

function adjustLightness(hsl: string, delta: number): string {
  const parts = hsl.split(/\s+/);
  const newL = Math.max(0, Math.min(100, parseFloat(parts[2]) + delta));
  return `${parts[0]} ${parts[1]} ${Math.round(newL * 10) / 10}%`;
}

function adjustSaturation(hsl: string, factor: number): string {
  const parts = hsl.split(/\s+/);
  const newS = Math.max(0, Math.min(100, parseFloat(parts[1]) * factor));
  return `${parts[0]} ${Math.round(newS * 10) / 10}% ${parts[2]}`;
}

// ---------------------------------------------------------------------------
// Build the CSS rule string from a TerminalTheme
// ---------------------------------------------------------------------------

const CSS_VARS = [
  'background', 'foreground', 'card', 'card-foreground',
  'popover', 'popover-foreground', 'primary', 'primary-foreground',
  'secondary', 'secondary-foreground', 'muted', 'muted-foreground',
  'accent', 'accent-foreground', 'destructive', 'destructive-foreground',
  'border', 'input', 'ring',
] as const;

function buildImmersiveCss(theme: TerminalTheme): string {
  const bg = hexToHsl(theme.colors.background);
  const fg = hexToHsl(theme.colors.foreground);
  const cursor = hexToHsl(theme.colors.cursor);
  const isDark = theme.type === 'dark';

  const card = adjustLightness(bg, isDark ? 4 : -3);
  const secondary = adjustLightness(bg, isDark ? 6 : -5);
  const muted = adjustLightness(bg, isDark ? 10 : -8);
  const mutedFg = adjustSaturation(adjustLightness(fg, isDark ? -20 : 20), 0.5);
  const border = adjustLightness(bg, isDark ? 12 : -10);
  const cursorL = parseFloat(cursor.split(' ')[2] ?? '50');
  const primaryFg = cursorL > 55 ? '0 0% 0%' : '0 0% 100%';

  const values = [
    bg, fg, card, fg,         // background, foreground, card, card-foreground
    card, fg,                 // popover, popover-foreground
    cursor, primaryFg,        // primary, primary-foreground
    secondary, fg,            // secondary, secondary-foreground
    muted, mutedFg,           // muted, muted-foreground
    cursor, primaryFg,        // accent, accent-foreground
    '0 70% 50%', '0 0% 100%', // destructive, destructive-foreground
    border, border, cursor,   // border, input, ring
  ];

  const rules = CSS_VARS.map((name, i) => `--${name}: ${values[i]} !important`).join('; ');
  return `:root { ${rules}; }`;
}

// ---------------------------------------------------------------------------
// Pre-compute CSS for all built-in themes at module load — O(1) lookup at switch time
// ---------------------------------------------------------------------------

const cssCache = new Map<string, string>();

// Fingerprint: id + type + 3 key colors (detects in-place edits including dark↔light)
function themeFingerprint(t: TerminalTheme): string {
  return `${t.id}\0${t.type}\0${t.colors.background}\0${t.colors.foreground}\0${t.colors.cursor}`;
}

// Pre-compute built-in themes
for (const theme of TERMINAL_THEMES) {
  cssCache.set(themeFingerprint(theme), buildImmersiveCss(theme));
}

/** Get (or lazily compute & cache) the immersive CSS for a theme. */
function getImmersiveCss(theme: TerminalTheme): string {
  const fp = themeFingerprint(theme);
  let css = cssCache.get(fp);
  if (!css) {
    css = buildImmersiveCss(theme);
    cssCache.set(fp, css);
  }
  return css;
}

// ---------------------------------------------------------------------------
// Style tag management
// ---------------------------------------------------------------------------

const STYLE_ID = 'netcatty-immersive-override';

function applyImmersiveStyle(css: string, isDark: boolean, bg: string) {
  const root = document.documentElement;
  const targetClass = isDark ? 'dark' : 'light';
  if (!root.classList.contains(targetClass)) {
    root.classList.remove('light', 'dark');
    root.classList.add(targetClass);
  }
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = css;
  // Sync native Electron window chrome
  netcattyBridge.get()?.setTheme?.(isDark ? 'dark' : 'light');
  netcattyBridge.get()?.setBackgroundColor?.(bg);
}

function removeImmersiveStyle() {
  document.getElementById(STYLE_ID)?.remove();
  delete document.documentElement.dataset.immersiveTheme;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useImmersiveMode({
  activeTabId,
  activeTerminalTheme,
  restoreOriginalTheme,
}: {
  activeTabId: string;
  activeTerminalTheme: TerminalTheme | null;
  restoreOriginalTheme: () => void;
}) {
  const overrideActiveRef = useRef(false);
  const appliedFpRef = useRef<string | null>(null);
  const restoreRef = useRef(restoreOriginalTheme);
  restoreRef.current = restoreOriginalTheme;

  const isTerminalTab = activeTabId !== 'vault' && activeTabId !== 'sftp' && !activeTabId.startsWith('log-');

  // APPLY: useLayoutEffect — runs before paint, O(1) Map lookup, single DOM write
  useLayoutEffect(() => {
    if (isTerminalTab && activeTerminalTheme) {
      const fp = themeFingerprint(activeTerminalTheme);
      if (appliedFpRef.current === fp) return;
      overrideActiveRef.current = true;
      appliedFpRef.current = fp;
      applyImmersiveStyle(getImmersiveCss(activeTerminalTheme), activeTerminalTheme.type === 'dark', activeTerminalTheme.colors.background);
      document.documentElement.dataset.immersiveTheme = fp;
    }
  }, [isTerminalTab, activeTerminalTheme]);

  // RESTORE: useEffect — runs after paint, with fade overlay
  useEffect(() => {
    if (isTerminalTab && activeTerminalTheme) return;
    if (!overrideActiveRef.current) return;
    overrideActiveRef.current = false;
    appliedFpRef.current = null;
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--background').trim();
    const overlay = document.createElement('div');
    overlay.className = 'immersive-fade-overlay';
    overlay.style.backgroundColor = `hsl(${bg})`;
    document.body.appendChild(overlay);
    removeImmersiveStyle();
    restoreOriginalTheme();
    requestAnimationFrame(() => {
      overlay.classList.add('fade-out');
      overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
    });
    const fallback = setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, 400);
    return () => { clearTimeout(fallback); if (overlay.parentNode) overlay.remove(); };
  }, [isTerminalTab, activeTerminalTheme, restoreOriginalTheme]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      removeImmersiveStyle();
      appliedFpRef.current = null;
      if (overrideActiveRef.current) {
        overrideActiveRef.current = false;
        restoreRef.current();
      }
    };
  }, []);
}
