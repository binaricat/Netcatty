import type { TerminalTheme } from '../../types';
import { resolveReadableForegroundForHsl } from '../../domain/colorContrast';

function hexToHslToken(hex: string): string {
  const normalized = hex.startsWith('#') ? hex : `#${hex}`;
  const r = parseInt(normalized.slice(1, 3), 16) / 255;
  const g = parseInt(normalized.slice(3, 5), 16) / 255;
  const b = parseInt(normalized.slice(5, 7), 16) / 255;
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

function adjustLightnessToken(hsl: string, delta: number): string {
  const parts = hsl.split(/\s+/);
  const newL = Math.max(0, Math.min(100, parseFloat(parts[2]) + delta));
  return `${parts[0]} ${parts[1]} ${Math.round(newL * 10) / 10}%`;
}

function adjustSaturationToken(hsl: string, factor: number): string {
  const parts = hsl.split(/\s+/);
  const newS = Math.max(0, Math.min(100, parseFloat(parts[1]) * factor));
  return `${parts[0]} ${Math.round(newS * 10) / 10}% ${parts[2]}`;
}

const setStylePropertyIfChanged = (element: HTMLElement, property: string, value: string) => {
  if (element.style.getPropertyValue(property) === value) return;
  element.style.setProperty(property, value);
};

const removeStylePropertyIfSet = (element: HTMLElement, property: string) => {
  if (!element.style.getPropertyValue(property)) return;
  element.style.removeProperty(property);
};

const TOP_TABS_THEME_PROPERTIES = [
  '--top-tabs-bg',
  '--top-tabs-fg',
  '--top-tabs-muted',
  '--top-tabs-active-bg',
  '--top-tabs-accent',
  '--background',
  '--foreground',
  '--accent',
  '--accent-foreground',
  '--primary',
  '--primary-foreground',
  '--secondary',
  '--border',
  '--muted-foreground',
] as const;

let topTabsChromeThemeVarsApplied = false;

export function clearTopTabsChromeThemeVars(): void {
  if (typeof document === 'undefined') return;
  if (!topTabsChromeThemeVarsApplied) return;
  const tabsRoot = document.querySelector<HTMLElement>('[data-top-tabs-root]');
  if (!tabsRoot) return;
  for (const property of TOP_TABS_THEME_PROPERTIES) {
    removeStylePropertyIfSet(tabsRoot, property);
  }
  topTabsChromeThemeVarsApplied = false;
}

export function applyTopTabsChromeThemeVars(theme: TerminalTheme): void {
  if (typeof document === 'undefined') return;
  const tabsRoot = document.querySelector<HTMLElement>('[data-top-tabs-root]');
  if (!tabsRoot) return;

  const bg = hexToHslToken(theme.colors.background);
  const fg = hexToHslToken(theme.colors.foreground);
  const accent = hexToHslToken(theme.colors.cursor);
  const accentForeground = resolveReadableForegroundForHsl(accent);
  const isDark = theme.type === 'dark';
  const secondary = adjustLightnessToken(bg, isDark ? 6 : -5);
  const border = adjustLightnessToken(bg, isDark ? 12 : -10);
  const mutedFg = adjustSaturationToken(adjustLightnessToken(fg, isDark ? -20 : 20), 0.5);

  setStylePropertyIfChanged(tabsRoot, '--background', bg);
  setStylePropertyIfChanged(tabsRoot, '--foreground', fg);
  setStylePropertyIfChanged(tabsRoot, '--accent', accent);
  setStylePropertyIfChanged(tabsRoot, '--accent-foreground', accentForeground);
  setStylePropertyIfChanged(tabsRoot, '--primary', accent);
  setStylePropertyIfChanged(tabsRoot, '--primary-foreground', accentForeground);
  setStylePropertyIfChanged(tabsRoot, '--secondary', secondary);
  setStylePropertyIfChanged(tabsRoot, '--border', border);
  setStylePropertyIfChanged(tabsRoot, '--muted-foreground', mutedFg);
  setStylePropertyIfChanged(tabsRoot, '--top-tabs-bg', 'hsl(var(--secondary))');
  setStylePropertyIfChanged(tabsRoot, '--top-tabs-fg', 'hsl(var(--foreground))');
  setStylePropertyIfChanged(tabsRoot, '--top-tabs-muted', 'hsl(var(--muted-foreground))');
  setStylePropertyIfChanged(tabsRoot, '--top-tabs-active-bg', 'hsl(var(--background))');
  setStylePropertyIfChanged(tabsRoot, '--top-tabs-accent', 'hsl(var(--accent))');
  topTabsChromeThemeVarsApplied = true;
}

export function hasActiveChromeThemeDataset(): boolean {
  if (typeof document === 'undefined') return false;
  return Boolean(document.documentElement.dataset.activeChromeTheme);
}
