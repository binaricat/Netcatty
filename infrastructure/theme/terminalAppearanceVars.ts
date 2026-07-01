import type { TerminalTheme } from '../../domain/models';
import {
  buildTerminalAppearanceCssVars,
  TERMINAL_APPEARANCE_VAR_KEYS,
} from './terminalAppearanceTokens';

export const TERMINAL_APPEARANCE_ROOT_ATTR = 'data-terminal-appearance-root';
export const TERMINAL_APPEARANCE_ROOT_SELECTOR = `[${TERMINAL_APPEARANCE_ROOT_ATTR}]`;

const setStylePropertyIfChanged = (element: HTMLElement, property: string, value: string) => {
  if (element.style.getPropertyValue(property) === value) return;
  element.style.setProperty(property, value);
};

const removeStylePropertyIfSet = (element: HTMLElement, property: string) => {
  if (!element.style.getPropertyValue(property)) return;
  element.style.removeProperty(property);
};

export function findTerminalAppearanceRoot(root?: ParentNode): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const scope = root ?? document;
  return scope.querySelector<HTMLElement>(TERMINAL_APPEARANCE_ROOT_SELECTOR);
}

const TERMINAL_CHROME_SURFACE_SELECTOR = [
  '[data-section="app-host-tree-layer"]',
  '[data-section="terminal-host-tree-sidebar"]',
  '[data-section="terminal-side-panel"]',
].join(', ');

const TERMINAL_LAYER_CHROME_SURFACE_SELECTOR = [
  '[data-section="terminal-host-tree-sidebar"]',
  '[data-section="terminal-side-panel"]',
].join(', ');

function collectTerminalChromeSurfaceElements(): HTMLElement[] {
  if (typeof document === 'undefined') return [];
  return Array.from(document.querySelectorAll<HTMLElement>(TERMINAL_CHROME_SURFACE_SELECTOR));
}

function collectTerminalLayerChromeSurfaceElements(): HTMLElement[] {
  if (typeof document === 'undefined') return [];
  return Array.from(document.querySelectorAll<HTMLElement>(TERMINAL_LAYER_CHROME_SURFACE_SELECTOR));
}

function applyTerminalAppearanceVarsToTargets(targets: HTMLElement[], theme: TerminalTheme): void {
  if (targets.length === 0) return;
  const vars = buildTerminalAppearanceCssVars(theme);
  for (const target of targets) {
    for (const key of TERMINAL_APPEARANCE_VAR_KEYS) {
      setStylePropertyIfChanged(target, key, vars[key]);
    }
    target.dataset.terminalAppearanceId = theme.id;
  }
}

export function injectTerminalChromeSurfaceVars(theme: TerminalTheme): void {
  applyTerminalAppearanceVarsToTargets(collectTerminalChromeSurfaceElements(), theme);
}

export function injectTerminalLayerChromeSurfaceVars(theme: TerminalTheme): void {
  applyTerminalAppearanceVarsToTargets(collectTerminalLayerChromeSurfaceElements(), theme);
}

function clearTerminalAppearanceVarsOnTargets(targets: HTMLElement[]): void {
  for (const target of targets) {
    for (const key of TERMINAL_APPEARANCE_VAR_KEYS) {
      removeStylePropertyIfSet(target, key);
    }
    delete target.dataset.terminalAppearanceId;
  }
}

export function clearTerminalChromeSurfaceVars(): void {
  if (typeof document === 'undefined') return;
  clearTerminalAppearanceVarsOnTargets(collectTerminalChromeSurfaceElements());
}

export function clearTerminalLayerChromeSurfaceVars(): void {
  if (typeof document === 'undefined') return;
  clearTerminalAppearanceVarsOnTargets(collectTerminalLayerChromeSurfaceElements());
}

export type InjectTerminalAppearanceVarsOptions = {
  root?: HTMLElement | null;
  includeChromeSurfaces?: boolean;
};

export function injectTerminalAppearanceVars(
  theme: TerminalTheme,
  options?: InjectTerminalAppearanceVarsOptions | HTMLElement | null,
): void {
  if (typeof document === 'undefined') return;
  const normalizedOptions: InjectTerminalAppearanceVarsOptions = options && typeof options === 'object' && 'includeChromeSurfaces' in options
    ? options
    : { root: options instanceof HTMLElement || options === null ? options : undefined };
  const includeChromeSurfaces = normalizedOptions.includeChromeSurfaces ?? true;
  const targets: HTMLElement[] = [];
  const appearanceRoot = normalizedOptions.root ?? findTerminalAppearanceRoot();
  if (appearanceRoot) targets.push(appearanceRoot);
  const tabsRoot = document.querySelector<HTMLElement>('[data-top-tabs-root]');
  if (tabsRoot && tabsRoot !== appearanceRoot) targets.push(tabsRoot);
  if (includeChromeSurfaces) {
    for (const chromeSurface of collectTerminalChromeSurfaceElements()) {
      if (!targets.includes(chromeSurface)) targets.push(chromeSurface);
    }
  }
  applyTerminalAppearanceVarsToTargets(targets, theme);
}

export function clearTerminalAppearanceVars(root?: HTMLElement | null): void {
  if (typeof document === 'undefined') return;
  const targets: HTMLElement[] = [];
  const appearanceRoot = root ?? findTerminalAppearanceRoot();
  if (appearanceRoot) targets.push(appearanceRoot);
  const tabsRoot = document.querySelector<HTMLElement>('[data-top-tabs-root]');
  if (tabsRoot && tabsRoot !== appearanceRoot) targets.push(tabsRoot);
  for (const hostTreeRoot of document.querySelectorAll<HTMLElement>(
    '[data-section="app-host-tree-layer"], [data-section="terminal-host-tree-sidebar"], [data-section="terminal-side-panel"]',
  )) {
    if (!targets.includes(hostTreeRoot)) targets.push(hostTreeRoot);
  }
  clearTerminalAppearanceVarsOnTargets(targets);
}

export function injectTerminalPaneAppearanceVars(sessionId: string, theme: TerminalTheme): void {
  if (typeof document === 'undefined') return;
  const pane = document.querySelector<HTMLElement>(`[data-session-id="${sessionId}"]`);
  if (!pane) return;
  const vars = buildTerminalAppearanceCssVars(theme);
  setStylePropertyIfChanged(pane, '--nc-term-bg', vars['--nc-term-bg']);
  setStylePropertyIfChanged(pane, '--nc-term-fg', vars['--nc-term-fg']);
  setStylePropertyIfChanged(pane, '--nc-term-border', vars['--nc-term-border']);
  setStylePropertyIfChanged(pane, '--nc-term-toolbar-btn', vars['--nc-term-toolbar-btn']);
  setStylePropertyIfChanged(pane, '--nc-term-toolbar-btn-hover', vars['--nc-term-toolbar-btn-hover']);
  setStylePropertyIfChanged(pane, '--nc-term-toolbar-btn-active', vars['--nc-term-toolbar-btn-active']);
  // Legacy aliases consumed by Terminal.tsx toolbar styles.
  setStylePropertyIfChanged(pane, '--terminal-preview-bg', vars['--nc-term-bg']);
  setStylePropertyIfChanged(pane, '--terminal-preview-fg', vars['--nc-term-fg']);
  setStylePropertyIfChanged(pane, '--terminal-preview-border', vars['--nc-term-border']);
  setStylePropertyIfChanged(pane, '--terminal-preview-toolbar-btn', vars['--nc-term-toolbar-btn']);
  setStylePropertyIfChanged(pane, '--terminal-preview-toolbar-btn-hover', vars['--nc-term-toolbar-btn-hover']);
  setStylePropertyIfChanged(pane, '--terminal-preview-toolbar-btn-active', vars['--nc-term-toolbar-btn-active']);
}

export function clearTerminalPaneAppearanceVars(sessionId: string): void {
  if (typeof document === 'undefined') return;
  const pane = document.querySelector<HTMLElement>(`[data-session-id="${sessionId}"]`);
  if (!pane) return;
  const keys = [
    '--nc-term-bg', '--nc-term-fg', '--nc-term-border',
    '--nc-term-toolbar-btn', '--nc-term-toolbar-btn-hover', '--nc-term-toolbar-btn-active',
    '--terminal-preview-bg', '--terminal-preview-fg', '--terminal-preview-border',
    '--terminal-preview-toolbar-btn', '--terminal-preview-toolbar-btn-hover', '--terminal-preview-toolbar-btn-active',
  ];
  for (const key of keys) {
    removeStylePropertyIfSet(pane, key);
  }
}
