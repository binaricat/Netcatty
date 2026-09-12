import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getAvailablePaneMagnificationController,
  getPaneMagnificationShortcutLabel,
  isPaneMagnificationSelectionValid,
  resolvePaneMagnificationCandidate,
  resolvePaneMagnificationStyle,
  resolveTwoPaneMagnificationStyle,
  type PaneMagnificationController,
} from './paneMagnification.ts';

test('selects the first controller that can magnify the active surface', () => {
  const unavailable: PaneMagnificationController = {
    getState: () => 'unavailable',
    focus: () => false,
    restore: () => false,
    toggle: () => false,
  };
  const focusable: PaneMagnificationController = {
    getState: () => 'focusable',
    focus: () => true,
    restore: () => false,
    toggle: () => true,
  };

  assert.equal(
    getAvailablePaneMagnificationController([null, unavailable, focusable]),
    focusable,
  );
  assert.equal(getAvailablePaneMagnificationController([unavailable]), null);
});

test('invalidates magnification when its pane closes or changes tab ownership', () => {
  const selection = {
    tabId: 'workspace-1',
    target: { kind: 'terminal' as const, sessionId: 'session-1' },
  };
  assert.equal(isPaneMagnificationSelectionValid(
    selection,
    [{ tabId: 'workspace-1', sessionId: 'session-1' }],
    [],
  ), true);
  assert.equal(isPaneMagnificationSelectionValid(
    selection,
    [{ tabId: 'session-1', sessionId: 'session-1' }],
    [],
  ), false);
  assert.equal(isPaneMagnificationSelectionValid(selection, [], []), false);
});

test('uses the configured shortcut label for the current platform', () => {
  const bindings = [{ id: 'toggle-pane-zoom', mac: '⌥ + M', pc: 'Alt + M' }];

  assert.equal(getPaneMagnificationShortcutLabel(bindings, 'mac'), '⌥+M');
  assert.equal(getPaneMagnificationShortcutLabel(bindings, 'pc'), 'Alt+M');
  assert.equal(getPaneMagnificationShortcutLabel(bindings, 'disabled'), '');
});

test('magnification overlays the original layout without changing its rect', () => {
  const original = { left: '0px', top: '300px', width: '600px', height: '300px' };

  assert.deepEqual(resolvePaneMagnificationStyle(original, false), original);
  assert.deepEqual(resolvePaneMagnificationStyle(original, true), {
    left: '12px',
    top: '12px',
    width: 'calc(100% - 24px)',
    height: 'calc(100% - 24px)',
    zIndex: 50,
  });
  assert.deepEqual(original, {
    left: '0px',
    top: '300px',
    width: '600px',
    height: '300px',
  });
  assert.deepEqual(resolvePaneMagnificationStyle(original, true, {
    left: 120,
    top: 80,
    width: 1400,
    height: 900,
  }), {
    position: 'fixed',
    left: '132px',
    top: '92px',
    width: '1376px',
    height: '876px',
    zIndex: 50,
  });
});

test('two-pane magnification keeps the dormant pane geometry unchanged', () => {
  assert.deepEqual(resolveTwoPaneMagnificationStyle('left', true, true), {
    left: '12px', top: '12px', width: 'calc(100% - 24px)', height: 'calc(100% - 24px)', zIndex: 50,
  });
  assert.deepEqual(resolveTwoPaneMagnificationStyle('right', true, false), {
    left: '50%', top: '0%', width: '50%', height: '100%', zIndex: 10,
  });
  assert.deepEqual(resolveTwoPaneMagnificationStyle('right', false, false), {
    left: '0%', top: '50%', width: '100%', height: '50%', zIndex: 10,
  });
});

test('resolves the last interacted pane without borrowing another tab target', () => {
  const sidePane = { id: 'pane-sftp', tool: 'sftp' };
  const current = {
    tabId: 'workspace-other',
    target: { kind: 'terminal' as const, sessionId: 'session-other' },
  };

  assert.deepEqual(resolvePaneMagnificationCandidate({
    tabId: 'workspace-1',
    terminalSessionIds: ['session-1'],
    focusedSessionId: 'session-1',
    sidePanelPanes: [sidePane],
    lastTarget: { kind: 'side-panel', paneId: sidePane.id, tool: sidePane.tool },
    current,
  }), {
    target: { kind: 'side-panel', paneId: sidePane.id, tool: sidePane.tool },
    focused: false,
  });
});

test('keyboard workspace focus overrides a stale terminal interaction', () => {
  assert.deepEqual(resolvePaneMagnificationCandidate({
    tabId: 'workspace-1',
    terminalSessionIds: ['session-1', 'session-2'],
    focusedSessionId: 'session-2',
    sidePanelPanes: [],
    lastTarget: { kind: 'terminal', sessionId: 'session-1' },
    current: null,
  }), {
    target: { kind: 'terminal', sessionId: 'session-2' },
    focused: false,
  });
});

test('keeps a valid magnified pane focused and rejects a single-pane surface', () => {
  const current = {
    tabId: 'workspace-1',
    target: { kind: 'terminal' as const, sessionId: 'session-2' },
  };
  assert.deepEqual(resolvePaneMagnificationCandidate({
    tabId: 'workspace-1',
    terminalSessionIds: ['session-1', 'session-2'],
    focusedSessionId: 'session-1',
    sidePanelPanes: [],
    current,
  }), { target: current.target, focused: true });
  assert.equal(resolvePaneMagnificationCandidate({
    tabId: 'workspace-1',
    terminalSessionIds: ['session-1'],
    focusedSessionId: 'session-1',
    sidePanelPanes: [],
    current: null,
  }), null);
});
