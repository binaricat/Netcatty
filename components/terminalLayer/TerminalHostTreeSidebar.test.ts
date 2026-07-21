import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Host } from '../../types';

const sidebarSource = readFileSync(new URL('./TerminalHostTreeSidebar.tsx', import.meta.url), 'utf8');

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});

const {
  applyTerminalHostTreeHostRename,
  shouldShowTerminalHostHoverCard,
  getTerminalHostTreeHiddenSurfaceShellWidth,
  getTerminalHostTreeInitialLayoutWidth,
  getTerminalHostTreeLayoutTargetWidth,
  getTerminalHostTreeMeasuredLayoutWidth,
  getTerminalHostTreeSidebarPanelStyle,
  getTerminalHostTreeSidebarShellStyle,
  isTerminalHostTreeSidebarVisible,
} = await import('./TerminalHostTreeSidebar.tsx');
const { TERMINAL_HOST_TREE_WIDTH_TRANSITION } = await import('../../application/state/terminalHostTreeAnimation.ts');

const host: Host = {
  id: 'host-1',
  label: 'Ubuntu',
  hostname: '10.2.0.124',
  username: 'root',
  port: 22,
  protocol: 'ssh',
  tags: [],
  os: 'linux',
  createdAt: 1,
};

test('host tree sidebar is visually hidden when disabled even if it remains open', () => {
  assert.equal(isTerminalHostTreeSidebarVisible(true, false), false);
});

test('host tree sidebar visibility still follows open state when enabled', () => {
  assert.equal(isTerminalHostTreeSidebarVisible(true, true), true);
  assert.equal(isTerminalHostTreeSidebarVisible(false, true), false);
});

test('host tree sidebar stays collapsed behind root pages', () => {
  assert.equal(isTerminalHostTreeSidebarVisible(true, true, false), false);
});

test('host tree layout target follows visible surface state', () => {
  assert.equal(getTerminalHostTreeLayoutTargetWidth(true, 240), 240);
  assert.equal(getTerminalHostTreeLayoutTargetWidth(false, 240), 0);
});

test('host tree hidden surface shell keeps the open width for return navigation', () => {
  assert.equal(getTerminalHostTreeHiddenSurfaceShellWidth(true, true, 240), 240);
  assert.equal(getTerminalHostTreeHiddenSurfaceShellWidth(false, true, 240), 0);
  assert.equal(getTerminalHostTreeHiddenSurfaceShellWidth(true, false, 240), 0);
});

test('host tree layout starts collapsed so first mount can animate open', () => {
  assert.equal(getTerminalHostTreeInitialLayoutWidth(), 0);
});

test('host tree layout sync can sample the current shell width before targeting', () => {
  assert.equal(getTerminalHostTreeMeasuredLayoutWidth({
    getBoundingClientRect: () => ({ width: 84 }),
  } as unknown as HTMLElement, 240), 84);
  assert.equal(getTerminalHostTreeMeasuredLayoutWidth({
    getBoundingClientRect: () => ({ width: -12 }),
  } as unknown as HTMLElement, 240), 0);
  assert.equal(getTerminalHostTreeMeasuredLayoutWidth(null, 240), 240);
});

test('host tree layout width follows the animated shell via ResizeObserver', () => {
  const source = readFileSync(new URL('./TerminalHostTreeSidebar.tsx', import.meta.url), 'utf8');

  assert.match(source, /new ResizeObserver/);
  assert.match(source, /syncLayoutWidthFromShell/);
  assert.doesNotMatch(source, /performance\.now\(\)/);
});

test('host tree keeps shell width while hidden behind root pages', () => {
  const source = readFileSync(new URL('./TerminalHostTreeSidebar.tsx', import.meta.url), 'utf8');

  assert.match(source, /isResizing \|\| !surfaceVisible/);
  assert.match(source, /const hiddenSurfaceShellWidth = getTerminalHostTreeHiddenSurfaceShellWidth/);
  assert.match(source, /if \(!surfaceVisible\) \{\s*setShellWidth\(hiddenSurfaceShellWidth\);\s*terminalHostTreeStore\.setLayoutWidth\(0\);/);
  assert.doesNotMatch(source, /if \(!surfaceVisible\) \{\s*setShellWidth\(0\);/);
});

test('host tree sidebar memo tracks surface visibility and theme changes', () => {
  const source = readFileSync(new URL('./TerminalHostTreeSidebar.tsx', import.meta.url), 'utf8');

  assert.match(source, /prev\.surfaceVisible === next\.surfaceVisible/);
  assert.match(source, /themeFingerprint\(prev\.resolvedPreviewTheme\) === themeFingerprint\(next\.resolvedPreviewTheme\)/);
});

test('host tree sidebar wires app-level host creation and editing actions', () => {
  assert.match(sidebarSource, /onNewHost\?: \(defaultGroup\?: string\) => void/);
  assert.match(sidebarSource, /onEditHost\?: \(host: Host\) => void/);
  assert.match(sidebarSource, /onEditHost=\{onEditHost\}/);
  assert.match(sidebarSource, /onNewHost=\{\(groupPath\) => onNewHost\?\.\(groupPath\)\}/);
});

test('host tree sidebar exposes new host only from unused root space', () => {
  assert.match(sidebarSource, /data-section="terminal-host-tree-root-context"/);
  assert.match(sidebarSource, /closest\('\[data-row-type\]'\)/);
  assert.match(sidebarSource, /<ContextMenuItem onClick=\{\(\) => onNewHost\?\.\(\)\}>/);
});

test('host tree sidebar clips the panel instead of fading it out while closing', () => {
  const theme = {
    termBg: '#000000',
    termFg: '#ffffff',
    mutedFg: '#999999',
    separator: '#333333',
    rowHoverBg: '#111111',
    rowActiveBg: '#222222',
    rowDropBg: '#444444',
    folderFg: '#cccccc',
  };

  assert.deepEqual(getTerminalHostTreeSidebarShellStyle(false, 0, TERMINAL_HOST_TREE_WIDTH_TRANSITION), {
    width: 0,
    transition: TERMINAL_HOST_TREE_WIDTH_TRANSITION,
    pointerEvents: 'none',
  });
  assert.equal(getTerminalHostTreeSidebarPanelStyle({
    isVisible: false,
    displayWidth: 240,
    panelTransition: 'border-color 220ms ease-out',
    theme,
  }).width, 240);
  assert.equal(getTerminalHostTreeSidebarPanelStyle({
    isVisible: false,
    displayWidth: 240,
    panelTransition: 'border-color 220ms ease-out',
    theme,
  }).opacity, 1);
});

test('host tree sidebar colors can be overridden by immediate preview styles', () => {
  const theme = {
    termBg: 'var(--terminal-host-tree-bg, #000000)',
    termFg: 'var(--terminal-host-tree-fg, #ffffff)',
    mutedFg: 'var(--terminal-host-tree-muted, #999999)',
    separator: 'var(--terminal-host-tree-separator, #333333)',
    rowHoverBg: 'var(--terminal-host-tree-hover-bg, #111111)',
    rowActiveBg: 'var(--terminal-host-tree-active-bg, #222222)',
    rowDropBg: 'var(--terminal-host-tree-drop-bg, #444444)',
    folderFg: 'var(--terminal-host-tree-folder-fg, #cccccc)',
  };

  const style = getTerminalHostTreeSidebarPanelStyle({
    isVisible: true,
    displayWidth: 240,
    panelTransition: 'border-color 220ms ease-out',
    theme,
  });

  assert.equal(style.backgroundColor, theme.termBg);
  assert.equal(style.color, theme.termFg);
  assert.equal(style.borderRight, `1px solid ${theme.separator}`);
});

test('host tree host inline rename trims and updates the matching host label', () => {
  const result = applyTerminalHostTreeHostRename([host], 'host-1', '  web-01  ');

  assert.equal(result.changed, true);
  assert.equal(result.hosts[0].label, 'web-01');
});

test('host tree host inline rename rejects empty names without changing hosts', () => {
  const hosts = [host];
  const result = applyTerminalHostTreeHostRename(hosts, 'host-1', '   ');

  assert.equal(result.changed, false);
  assert.equal(result.reason, 'required');
  assert.equal(result.hosts, hosts);
});

test('host tree hover card is hidden while the same host is inline editing', () => {
  assert.equal(shouldShowTerminalHostHoverCard('host-1', null), true);
  assert.equal(shouldShowTerminalHostHoverCard('host-1', 'host-2'), true);
  assert.equal(shouldShowTerminalHostHoverCard('host-1', 'host-1'), false);
});

test('host tree hover card renders markdown notes and keeps host details out of the header subtitle', () => {
  const source = readFileSync(new URL('./TerminalHostTreeSidebar.tsx', import.meta.url), 'utf8');

  assert.match(source, /<LazyMessageResponse/);
  assert.match(source, /size="sm"/);
  assert.match(source, /items-center gap-2/);
  assert.match(source, /flex min-h-6 min-w-0 items-center/);
  assert.match(source, /truncate text-\[15px\] font-semibold leading-5/);
  assert.match(source, /details\.host/);
  assert.doesNotMatch(source, /text-muted-foreground">\{host\.hostname\}/);
  assert.match(source, /host-tree-notes-scroll/);
  assert.match(source, /overflow-y-auto/);
  assert.doesNotMatch(source, /details\.lastConnected/);
});

test('host tree row icons, labels, and protocol badges share centered line boxes', () => {
  const source = readFileSync(new URL('./TerminalHostTreeSidebar.tsx', import.meta.url), 'utf8');

  assert.match(source, /flex h-5 shrink-0 items-center justify-center">\s*<DistroAvatar/);
  assert.match(source, /flex min-w-0 flex-1 items-center truncate leading-5/);
  assert.match(source, /flex shrink-0 items-center text-\[10px\] leading-4 uppercase/);
  assert.match(source, /flex h-5 w-4 shrink-0 items-center/);
  assert.match(source, /flex h-5 shrink-0 items-center">\s*\{isExpanded/);
  assert.match(source, /flex min-w-0 flex-1 items-center truncate leading-5">\{node\.name\}/);
});
