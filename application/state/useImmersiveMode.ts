/**
 * Immersive Mode — makes the entire UI chrome adapt colors to match the active terminal's theme.
 *
 * When enabled, CSS custom properties on `document.documentElement` are overridden with values
 * derived from the focused terminal's theme. When the active tab is not a terminal (vault / sftp)
 * or immersive mode is off, the original UI theme tokens are restored.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { TerminalTheme } from '../../domain/models';
import { UiThemeTokens } from '../../infrastructure/config/uiThemes';
import { STORAGE_KEY_IMMERSIVE_MODE } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';
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
  // Primary foreground: ensure contrast
  const primaryFg = isDark ? '0 0% 100%' : '0 0% 100%';
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
  activeTabId,
  activeTerminalTheme,
  restoreOriginalTheme,
}: {
  /** The currently active tab ID ('vault' | 'sftp' | session-id). */
  activeTabId: string;
  /** The resolved TerminalTheme for the focused terminal, or null if no terminal is focused. */
  activeTerminalTheme: TerminalTheme | null;
  /** Callback to restore the user's original UI theme (calls applyThemeTokens internally). */
  restoreOriginalTheme: () => void;
}) {
  const [isImmersive, setIsImmersive] = useState<boolean>(() => {
    const stored = localStorageAdapter.readString(STORAGE_KEY_IMMERSIVE_MODE);
    return stored === 'true';
  });

  // Track whether we have an active override so we can restore on toggle-off / tab switch
  const overrideActiveRef = useRef(false);

  const toggleImmersive = useCallback(() => {
    setIsImmersive(prev => {
      const next = !prev;
      localStorageAdapter.writeString(STORAGE_KEY_IMMERSIVE_MODE, String(next));
      return next;
    });
  }, []);

  const setImmersive = useCallback((value: boolean) => {
    setIsImmersive(value);
    localStorageAdapter.writeString(STORAGE_KEY_IMMERSIVE_MODE, String(value));
  }, []);

  // Listen for cross-window IPC changes (e.g. toggled from Settings window)
  useEffect(() => {
    const bridge = netcattyBridge.get();
    if (!bridge?.onSettingsChanged) return;
    const unsubscribe = bridge.onSettingsChanged((payload: { key: string; value: unknown }) => {
      if (payload.key === STORAGE_KEY_IMMERSIVE_MODE && typeof payload.value === 'boolean') {
        setIsImmersive(payload.value);
      }
    });
    return () => {
      try { unsubscribe?.(); } catch { /* ignore */ }
    };
  }, []);

  // Determine if the active tab is a terminal tab
  const isTerminalTab = activeTabId !== 'vault' && activeTabId !== 'sftp';

  useEffect(() => {
    if (isImmersive && isTerminalTab && activeTerminalTheme) {
      const tokens = deriveUiTokensFromTerminalTheme(activeTerminalTheme);
      applyImmersiveTokens(tokens, activeTerminalTheme.type === 'dark');
      overrideActiveRef.current = true;
    } else if (overrideActiveRef.current) {
      // Need to restore original theme
      overrideActiveRef.current = false;
      restoreOriginalTheme();
    }
  }, [isImmersive, isTerminalTab, activeTerminalTheme, restoreOriginalTheme]);

  return { isImmersive, toggleImmersive, setImmersive };
}
