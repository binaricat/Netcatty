import assert from 'node:assert/strict';
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
    'browser',
    'history',
    'theme',
    'system',
    'notes',
    'ai',
  ]);
});

test('side panel tab order accepts a stored permutation', () => {
  const stored = ['scripts', 'sftp', 'browser', 'history', 'theme', 'system', 'notes', 'ai'];

  assert.deepEqual(normalizeTerminalSidePanelTabOrder(stored), stored);
});

test('side panel tab order moves the dragged tab before the target tab', () => {
  assert.deepEqual(
    reorderTerminalSidePanelTab(
      TERMINAL_SIDE_PANEL_TAB_DEFAULT_ORDER,
      'notes',
      'scripts',
    ),
    ['sftp', 'browser', 'notes', 'scripts', 'history', 'theme', 'system', 'ai'],
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
    ['sftp', 'browser', 'history', 'theme', 'system', 'notes', 'ai', 'scripts'],
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
  assert.deepEqual(fitted.collapsed, ['browser', 'scripts', 'history', 'theme', 'system', 'notes']);
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


