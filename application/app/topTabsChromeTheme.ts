import type { TerminalTheme } from '../../types';
import {
  adjustLightnessToken,
  adjustSaturationToken,
  hexToHslToken,
  resolveReadableForegroundForHsl,
} from '../../domain/colorContrast';

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
