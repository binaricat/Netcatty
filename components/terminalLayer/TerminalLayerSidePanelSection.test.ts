import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  normalizeTerminalSidePanelTabOrder,
  reorderTerminalSidePanelTab,
  TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER,
} from '../../application/state/terminalSidePanelTabs.ts';
import { getTerminalSidePanelShellWidth } from './TerminalLayerSidePanelSection.tsx';

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

test('notes side panel forwards repeated open-note requests', () => {
  const layerSource = readFileSync(new URL('../TerminalLayer.tsx', import.meta.url), 'utf8');
  const slotsSource = readFileSync(new URL('./terminalLayerSidePanelSlots.tsx', import.meta.url), 'utf8');

  assert.match(layerSource, /notesOpenRequestIdRef\.current \+= 1/);
  assert.match(layerSource, /next\.set\(tabId, \{ noteId, requestId \}\)/);
  assert.match(slotsSource, /openNoteRequestId=\{openNoteRequest\?\.requestId \?\? null\}/);
});

test('system monitoring only pauses for hidden remote tabs when hibernation is enabled', () => {
  const source = readFileSync(new URL('./terminalLayerSidePanelSlots.tsx', import.meta.url), 'utf8');

  assert.match(source, /const systemSession = resolveSystemSidebarSession\(/);
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
