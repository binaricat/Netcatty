/**
 * Immersive Mode — makes the entire UI chrome adapt colors to match the active terminal's theme.
 *
 * When enabled, CSS custom properties on `document.documentElement` are overridden with values
 * derived from the focused terminal's theme. When the active tab is not a terminal (vault / sftp)
 * or immersive mode is off, the original UI theme tokens are restored.
 */
import { useEffect, useRef } from 'react';
import { TerminalTheme } from '../../domain/models';
import { UiThemeTokens } from '../../infrastructure/config/uiThemes';

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
      case r:
        h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        break;
      case g:
        h = ((b - r) / d + 2) / 6;
        break;
      case b:
        h = ((r - g) / d + 4) / 6;
        break;
    }
  }
  return `${Math.round(h * 3600) / 10} ${Math.round(s * 1000) / 10}% ${Math.round(l * 1000) / 10}%`;
}

/** Adjust lightness of an HSL token string by a delta (clamped 0..100). */
function adjustLightness(hsl: string, delta: number): string {
  const parts = hsl.split(/\s+/);
  const h = parts[0];
  const s = parts[1];
  const lVal = parseFloat(parts[2]);
  const newL = Math.max(0, Math.min(100, lVal + delta));
  return `${h} ${s} ${Math.round(newL * 10) / 10}%`;
}

/** Adjust saturation of an HSL token string by a factor (clamped 0..100). */
function adjustSaturation(hsl: string, factor: number): string {
  const parts = hsl.split(/\s+/);
  const h = parts[0];
  const sVal = parseFloat(parts[1]);
  const l = parts[2];
  const newS = Math.max(0, Math.min(100, sVal * factor));
  return `${h} ${Math.round(newS * 10) / 10}% ${l}`;
}

// ---------------------------------------------------------------------------
// Derive UI theme tokens from a TerminalTheme
// ---------------------------------------------------------------------------

export function deriveUiTokensFromTerminalTheme(theme: TerminalTheme): UiThemeTokens {
  const bg = hexToHsl(theme.colors.background);
  const fg = hexToHsl(theme.colors.foreground);
  const cursor = hexToHsl(theme.colors.cursor);
  const isDark = theme.type === 'dark';

  // Card: slightly lighter (dark) or slightly darker (light) than background
  const card = adjustLightness(bg, isDark ? 4 : -3);
  // Secondary: slight shift from bg
  const secondary = adjustLightness(bg, isDark ? 6 : -5);
  // Muted: between bg and fg
  const muted = adjustLightness(bg, isDark ? 10 : -8);
  const mutedForeground = adjustLightness(fg, isDark ? -20 : 20);
  // Border: subtle variant
  const border = adjustLightness(bg, isDark ? 12 : -10);
  // Primary: use cursor color (usually the accent)
  const primary = cursor;
  // Primary foreground: pick black or white based on cursor luminance for contrast
  const cursorL = parseFloat(cursor.split(' ')[2] ?? '50');
  const primaryFg = cursorL > 55 ? '0 0% 0%' : '0 0% 100%';
  // Destructive: standard red
  const destructive = '0 70% 50%';
  const destructiveFg = '0 0% 100%';

  return {
    background: bg,
    foreground: fg,
    card,
    cardForeground: fg,
    popover: card,
    popoverForeground: fg,
    primary,
    primaryForeground: primaryFg,
    secondary,
    secondaryForeground: fg,
    muted,
    mutedForeground: adjustSaturation(mutedForeground, 0.5),
    accent: primary,
    accentForeground: primaryFg,
    destructive,
    destructiveForeground: destructiveFg,
    border,
    input: border,
    ring: primary,
  };
}

// ---------------------------------------------------------------------------
// Apply / restore CSS variable overrides
// ---------------------------------------------------------------------------

const CSS_VAR_KEYS: Array<[keyof UiThemeTokens, string]> = [
  ['background', '--background'],
  ['foreground', '--foreground'],
  ['card', '--card'],
  ['cardForeground', '--card-foreground'],
  ['popover', '--popover'],
  ['popoverForeground', '--popover-foreground'],
  ['primary', '--primary'],
  ['primaryForeground', '--primary-foreground'],
  ['secondary', '--secondary'],
  ['secondaryForeground', '--secondary-foreground'],
  ['muted', '--muted'],
  ['mutedForeground', '--muted-foreground'],
  ['accent', '--accent'],
  ['accentForeground', '--accent-foreground'],
  ['destructive', '--destructive'],
  ['destructiveForeground', '--destructive-foreground'],
  ['border', '--border'],
  ['input', '--input'],
  ['ring', '--ring'],
];

function applyImmersiveTokens(tokens: UiThemeTokens, isDark: boolean) {
  const root = document.documentElement;
  // Update dark/light class to match terminal theme type
  root.classList.remove('light', 'dark');
  root.classList.add(isDark ? 'dark' : 'light');
  for (const [key, cssVar] of CSS_VAR_KEYS) {
    root.style.setProperty(cssVar, tokens[key]);
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useImmersiveMode({
  isImmersive,
  activeTabId,
  activeTerminalTheme,
  restoreOriginalTheme,
}: {
  /** Whether immersive mode is enabled (from useSettingsState). */
  isImmersive: boolean;
  /** The currently active tab ID ('vault' | 'sftp' | session-id). */
  activeTabId: string;
  /** The resolved TerminalTheme for the focused terminal, or null if no terminal is focused. */
  activeTerminalTheme: TerminalTheme | null;
  /** Callback to restore the user's original UI theme (calls applyThemeTokens internally). */
  restoreOriginalTheme: () => void;
}) {
  // Track whether we have an active override so we can restore on toggle-off / tab switch
  const overrideActiveRef = useRef(false);

  // Determine if the active tab is a terminal tab (exclude vault, sftp, and log views)
  const isTerminalTab = activeTabId !== 'vault' && activeTabId !== 'sftp' && !activeTabId.startsWith('log-');

  useEffect(() => {
    if (isImmersive && isTerminalTab && activeTerminalTheme) {
      const tokens = deriveUiTokensFromTerminalTheme(activeTerminalTheme);
      applyImmersiveTokens(tokens, activeTerminalTheme.type === 'dark');
      overrideActiveRef.current = true;
    } else if (overrideActiveRef.current) {
      overrideActiveRef.current = false;
      // Create a full-screen overlay with the current immersive background,
      // then restore the theme underneath and fade the overlay out.
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--background').trim();
      const overlay = document.createElement('div');
      overlay.className = 'immersive-fade-overlay';
      overlay.style.backgroundColor = `hsl(${bg})`;
      document.body.appendChild(overlay);
      restoreOriginalTheme();
      // Trigger fade-out on next frame
      requestAnimationFrame(() => {
        overlay.classList.add('fade-out');
        overlay.addEventListener('transitionend', () => overlay.remove(), { once: true });
      });
      // Safety fallback: always clean up overlay
      const fallback = setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, 400);
      return () => { clearTimeout(fallback); if (overlay.parentNode) overlay.remove(); };
    }
  }, [isImmersive, isTerminalTab, activeTerminalTheme, restoreOriginalTheme]);
}
