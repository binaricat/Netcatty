import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

import {
  normalizeTerminalSidePanelTabOrder,
  reorderTerminalSidePanelTab,
  fitTerminalSidePanelTabs,
  TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER,
} from '../../application/state/terminalSidePanelTabs.ts';
import {
  getTerminalSidePanelShellWidth,
  listenForSidePanelPaneFocus,
  resolveMagnifiedSidePanelHosts,
} from './TerminalLayerSidePanelSection.tsx';
import {
  getFocusedPortalDescendant,
  movePersistentPortalNode,
  resolveSidePanelPortalTarget,
} from './terminalLayerSidePanelSlots.tsx';

test('AI side panel shell can be force-hidden for layout isolation', () => {
  assert.equal(getTerminalSidePanelShellWidth({
    activeSidePanelTab: 'ai',
    forceHideAiShell: true,
    isSidePanelOpenForCurrentTab: true,
    resizePreviewWidth: null,
    sidePanelWidth: 420,
  }), 0);
});

test('non-AI side panels keep their open width', () => {
  assert.equal(getTerminalSidePanelShellWidth({
    activeSidePanelTab: 'sftp',
    forceHideAiShell: true,
    isSidePanelOpenForCurrentTab: true,
    resizePreviewWidth: null,
    sidePanelWidth: 420,
  }), 420);
});

test('resize preview width is still honored for visible side panels', () => {
  assert.equal(getTerminalSidePanelShellWidth({
    activeSidePanelTab: 'theme',
    forceHideAiShell: true,
    isSidePanelOpenForCurrentTab: true,
    resizePreviewWidth: 512,
    sidePanelWidth: 420,
  }), 512);
});

test('closed side panel shell has no width', () => {
  assert.equal(getTerminalSidePanelShellWidth({
    activeSidePanelTab: null,
    forceHideAiShell: true,
    isSidePanelOpenForCurrentTab: false,
    resizePreviewWidth: null,
    sidePanelWidth: 420,
  }), 0);
});

test('pointer and keyboard focus from portaled tool content focus the owning pane', () => {
  const host = new EventTarget();
  let focusCount = 0;
  const stopListening = listenForSidePanelPaneFocus(host, () => {
    focusCount += 1;
  });

  host.dispatchEvent(new Event('pointerdown'));
  assert.equal(focusCount, 1);
  host.dispatchEvent(new Event('focusin'));
  assert.equal(focusCount, 2);

  stopListening();
  host.dispatchEvent(new Event('pointerdown'));
  host.dispatchEvent(new Event('focusin'));
  assert.equal(focusCount, 2);
});

test('side panel tab order falls back to the default order', () => {
  assert.deepEqual(normalizeTerminalSidePanelTabOrder(null), TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER);
  // Partial / dirty lists keep known ids in order and append the rest of the defaults.
  assert.deepEqual(normalizeTerminalSidePanelTabOrder(['scripts', 'bad-tab']), [
    'scripts',
    'sftp',
    'history',
    'theme',
    'system',
    'notes',
    'ai',
  ]);
});

test('side panel tab order accepts a stored permutation', () => {
  const stored = ['scripts', 'sftp', 'history', 'theme', 'system', 'notes', 'ai'];

  assert.deepEqual(normalizeTerminalSidePanelTabOrder(stored), stored);
});

test('side panel tab order moves the dragged tab before the target tab', () => {
  assert.deepEqual(
    reorderTerminalSidePanelTab(
      TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER,
      'notes',
      'scripts',
    ),
    ['sftp', 'notes', 'scripts', 'history', 'theme', 'system', 'ai'],
  );
});

test('side panel tab order can move the dragged tab after the target tab', () => {
  assert.deepEqual(
    reorderTerminalSidePanelTab(
      TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER,
      'scripts',
      'ai',
      'after',
    ),
    ['sftp', 'history', 'theme', 'system', 'notes', 'ai', 'scripts'],
  );
});

test('narrow side panels keep the active tool visible and move extra tools into overflow', () => {
  const fitted = fitTerminalSidePanelTabs({
    shown: [...TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER],
    collapsed: [],
    active: 'ai',
    maxShown: 2,
  });

  assert.deepEqual(fitted.shown, ['sftp', 'ai']);
  assert.deepEqual(fitted.collapsed, ['scripts', 'history', 'theme', 'system', 'notes']);
});

test('notes side panel forwards repeated open-note requests', () => {
  const layerSource = readFileSync(new URL('../TerminalLayer.tsx', import.meta.url), 'utf8');
  const slotsSource = readFileSync(new URL('./terminalLayerSidePanelSlots.tsx', import.meta.url), 'utf8');

  assert.match(layerSource, /notesOpenRequestIdRef\.current \+= 1/);
  assert.match(layerSource, /next\.set\(tabId, \{ noteId, requestId \}\)/);
  assert.match(slotsSource, /openNoteRequestId=\{openNoteRequest\?\.requestId \?\? null\}/);
});

test('system monitoring only pauses for hidden remote tabs when hibernation is enabled', () => {
  const source = readFileSync(new URL('./terminalLayerSidePanelSlots.tsx', import.meta.url), 'utf8');

  // resolveSystemSidebarSession feeds systemSession (via live overlay when active).
  assert.match(source, /resolveSystemSidebarSession\(/);
  assert.match(source, /const systemSession = /);
  assert.match(source, /shouldKeepTerminalBackgroundWorkActive\([\s\S]*systemHost\?\.protocol,[\s\S]*isTabActive/);
  assert.doesNotMatch(source, /useSidePanelLiveSnapshotForTab\(tabId, keepSystemWorkActive\)/);
  assert.match(source, /isVisible=\{keepSystemWorkActive\}/);
});

test('side panel tab bar and borders use inline resolved terminal theme colors', () => {
  const sectionSource = readFileSync(new URL('./TerminalLayerSidePanelSection.tsx', import.meta.url), 'utf8');

  assert.match(sectionSource, /buildSidePanelChromeThemeFromTerminalTheme/);
  assert.match(sectionSource, /backgroundColor: sidePanelTheme\.termBg/);
  assert.match(sectionSource, /borderBottom: `1px solid \$\{sidePanelTheme\.separator\}`/);
  assert.match(sectionSource, /borderLeft: `1px solid \$\{sidePanelTheme\.separator\}`/);
  assert.doesNotMatch(sectionSource, /terminalAppearanceSidePanelStyle/);
  assert.doesNotMatch(sectionSource, /var\(--terminal-sidepanel-border\)/);
});

test('side panel content scopes app color utilities to the resolved terminal theme', () => {
  const sectionSource = readFileSync(new URL('./TerminalLayerSidePanelSection.tsx', import.meta.url), 'utf8');

  assert.match(sectionSource, /buildTerminalSidePanelCssVars/);
  assert.match(sectionSource, /\.\.\.sidePanelCssVars/);
});

test('side panel sets color-scheme from the terminal theme so native inputs match light panels', () => {
  const sectionSource = readFileSync(new URL('./TerminalLayerSidePanelSection.tsx', import.meta.url), 'utf8');

  // When a light terminal theme remaps --background under a dark app chrome,
  // form controls (Codex/AI composer textarea) still follow color-scheme.
  assert.match(
    sectionSource,
    /colorScheme:\s*resolvedSidePanelTerminalTheme\.type/,
  );
});

test('a visible tool without a ready pane host stays in the hidden parking host', () => {
  const parkingHost = { id: 'parking' };
  const paneHost = { id: 'pane' };

  assert.equal(resolveSidePanelPortalTarget(true, paneHost, parkingHost), paneHost);
  assert.equal(resolveSidePanelPortalTarget(true, null, parkingHost), parkingHost);
  assert.equal(resolveSidePanelPortalTarget(false, paneHost, parkingHost), parkingHost);
  assert.equal(resolveSidePanelPortalTarget(true, null, null), null);
});

test('magnifying a side pane moves only its stable portal host into the overlay', () => {
  const scriptsHost = { id: 'scripts-host' };
  const sftpHost = { id: 'sftp-host' };
  const overlayHost = { id: 'overlay-host' };
  const paneHosts = new Map([
    ['scripts', scriptsHost],
    ['sftp', sftpHost],
  ]);

  const resolved = resolveMagnifiedSidePanelHosts(
    paneHosts,
    { id: 'pane-scripts', type: 'pane', tool: 'scripts' },
    overlayHost,
  );

  assert.equal(resolved.get('scripts'), overlayHost);
  assert.equal(resolved.get('sftp'), sftpHost);
  assert.equal(paneHosts.get('scripts'), scriptsHost);
});

test('moving a stable portal host restores focus to its active input', () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="first"></div><div id="second"></div></body></html>');
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  try {
    const first = dom.window.document.getElementById('first') as HTMLElement;
    const second = dom.window.document.getElementById('second') as HTMLElement;
    const mountNode = dom.window.document.createElement('div');
    const input = dom.window.document.createElement('input');
    mountNode.appendChild(input);
    first.appendChild(mountNode);
    input.focus();

    const focusToRestore = getFocusedPortalDescendant(mountNode, dom.window.document.activeElement);
    mountNode.remove();
    assert.notEqual(dom.window.document.activeElement, input);

    movePersistentPortalNode(mountNode, second, focusToRestore);
    assert.equal(dom.window.document.activeElement, input);
  } finally {
    globalThis.document = previousDocument;
    globalThis.HTMLElement = previousHTMLElement;
    dom.window.close();
  }
});

test('the covered side-panel shell cannot receive keyboard focus', () => {
  const source = readFileSync(new URL('./TerminalLayerSidePanelSection.tsx', import.meta.url), 'utf8');

  assert.match(source, /const activeMagnifiedPane =/);
  assert.match(source, /inert=\{activeMagnifiedPane \? true : undefined\}/);
});

test('split pane hosts strictly clip each tool and do not use the side panel root as a portal fallback', () => {
  const sectionSource = readFileSync(new URL('./TerminalLayerSidePanelSection.tsx', import.meta.url), 'utf8');
  const slotsSource = readFileSync(new URL('./terminalLayerSidePanelSlots.tsx', import.meta.url), 'utf8');

  assert.match(sectionSource, /terminal-side-panel-pane-content/);
  assert.match(sectionSource, /overflow-hidden \[contain:strict\]/);
  assert.match(sectionSource, /terminal-side-panel-parking/);
  assert.match(slotsSource, /paneHosts\.get\(tool\)/);
  assert.match(slotsSource, /document\.createElement\('div'\)/);
  assert.match(slotsSource, /target\.appendChild\(mountNode\)/);
  assert.match(slotsSource, /focusRestoreRef\.current/);
  assert.match(slotsSource, /movePersistentPortalNode\(mountNode, target, focusedDescendant\)/);
  assert.match(slotsSource, /createPortal\(children, mountNode, portalKey\)/);
  assert.doesNotMatch(slotsSource, /document\.querySelector\([^)]*terminal-side-panel/);
});

test('the shared toolbar owns split controls while panes only render minimal chrome', () => {
  const sectionSource = readFileSync(new URL('./TerminalLayerSidePanelSection.tsx', import.meta.url), 'utf8');

  assert.match(sectionSource, /<SidePanelSplitMenu[\s\S]*direction="horizontal"/);
  assert.match(sectionSource, /<SidePanelSplitMenu[\s\S]*direction="vertical"/);
  assert.match(sectionSource, /data-section="terminal-side-panel-pane"/);
  assert.match(sectionSource, /paneCount > 1/);
});

test('split icons depict the same pane arrangement as their actions', () => {
  const sectionSource = readFileSync(new URL('./TerminalLayerSidePanelSection.tsx', import.meta.url), 'utf8');

  assert.match(
    sectionSource,
    /direction === 'horizontal'\s*\? <SplitSquareVertical size=\{15\} \/>\s*: <SplitSquareHorizontal size=\{15\} \/>/,
  );
});

test('side panel layout state is initialized before callbacks read it', () => {
  const layerSource = readFileSync(new URL('../TerminalLayer.tsx', import.meta.url), 'utf8');
  const layoutStateIndex = layerSource.indexOf('} = useTerminalSidePanelLayoutState();');
  const statusCallbackIndex = layerSource.indexOf('const handleStatusChange = useCallback');

  assert.notEqual(layoutStateIndex, -1);
  assert.notEqual(statusCallbackIndex, -1);
  assert.ok(layoutStateIndex < statusCallbackIndex);
});

test('split dragging previews locally, commits once, and cleans up on every exit path', () => {
  const sectionSource = readFileSync(new URL('./TerminalLayerSidePanelSection.tsx', import.meta.url), 'utf8');

  assert.match(sectionSource, /const updatePreview = \(\) => \{[\s\S]*setPreviewSizes\(next\)/);
  assert.match(sectionSource, /const finish = \(\) => \{[\s\S]*onResize\(node\.id, latestSizes\)/);
  const previewBody = sectionSource.slice(
    sectionSource.indexOf('const updatePreview = () => {'),
    sectionSource.indexOf('const onMouseMove = (moveEvent: MouseEvent) => {'),
  );
  assert.doesNotMatch(previewBody, /onResize/);
  assert.match(sectionSource, /window\.addEventListener\('blur', finish\)/);
  assert.match(sectionSource, /resizeCleanupRef\.current\?\.\(\)/);
  assert.match(sectionSource, /terminalLayoutSuppressStore\.end\(\)/);
});

test('split resizers do not consume visible gutter space', () => {
  const sectionSource = readFileSync(new URL('./TerminalLayerSidePanelSection.tsx', import.meta.url), 'utf8');

  assert.match(sectionSource, /group relative w-px shrink-0 cursor-ew-resize/);
  assert.match(sectionSource, /group relative h-px shrink-0 cursor-ns-resize/);
  assert.match(sectionSource, /after:w-2/);
  assert.match(sectionSource, /after:h-2/);
  assert.doesNotMatch(sectionSource, /group relative w-1 shrink-0 cursor-ew-resize/);
  assert.doesNotMatch(sectionSource, /group relative h-1 shrink-0 cursor-ns-resize/);
});

test('side panel resize uses the expanded width limit and protects terminal space', () => {
  const layerSource = readFileSync(new URL('../TerminalLayer.tsx', import.meta.url), 'utf8');
  const sectionSource = readFileSync(new URL('./TerminalLayerSidePanelSection.tsx', import.meta.url), 'utf8');

  assert.match(layerSource, /TERMINAL_SIDE_PANEL_MAX_WIDTH/);
  assert.match(sectionSource, /clampTerminalSidePanelWidth/);
  assert.match(sectionSource, /terminalLayer\.getBoundingClientRect\(\)\.width/);
  assert.match(sectionSource, /terminal-workspace-sidebar/);
  assert.match(sectionSource, /new ResizeObserver/);
  assert.match(sectionSource, /shellRef\.current\?\.getBoundingClientRect\(\)\.width \?\? shellWidth/);
  assert.doesNotMatch(sectionSource, /window\.innerWidth[,)\n]/);
  assert.doesNotMatch(sectionSource, /100vw/);
  assert.doesNotMatch(sectionSource, /const startWidth = sidePanelWidth/);
  assert.doesNotMatch(sectionSource, /Math\.min\(800,/);
});

test('side panel width dragging cleans up on mouseup, blur, and unmount', () => {
  const sectionSource = readFileSync(new URL('./TerminalLayerSidePanelSection.tsx', import.meta.url), 'utf8');

  assert.match(sectionSource, /shellResizeCleanupRef\.current\?\.\(\)/);
  assert.match(sectionSource, /window\.addEventListener\('mouseup', finish\)/);
  assert.match(sectionSource, /window\.addEventListener\('blur', finish\)/);
  assert.match(sectionSource, /window\.removeEventListener\('blur', finish\)/);
});

test('split resizing preserves nested minimums without rerendering on every pixel', () => {
  const sectionSource = readFileSync(new URL('./TerminalLayerSidePanelSection.tsx', import.meta.url), 'utf8');

  assert.match(sectionSource, /getSidePanelSplitResizeBounds/);
  assert.match(sectionSource, /getSidePanelNodeMinimumPixels\(activeSidePanelLayout\.root, 'vertical'\)/);
  assert.match(sectionSource, /focusedPaneSplitAvailability/);
  assert.doesNotMatch(sectionSource, /focusedPaneSize/);
});

test('available-width observer releases a removed focus sidebar immediately', () => {
  const sectionSource = readFileSync(new URL('./TerminalLayerSidePanelSection.tsx', import.meta.url), 'utf8');

  assert.match(sectionSource, /focusSidebar !== observedFocusSidebar/);
  assert.match(sectionSource, /if \(observedFocusSidebar\) resizeObserver\.unobserve\(observedFocusSidebar\)/);
  assert.match(sectionSource, /observedFocusSidebar = null/);
});
