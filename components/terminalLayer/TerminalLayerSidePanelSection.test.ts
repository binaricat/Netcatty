import assert from 'node:assert/strict';
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
  assert.deepEqual(normalizeTerminalSidePanelTabOrder(['scripts', 'bad-tab']), TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER);
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
