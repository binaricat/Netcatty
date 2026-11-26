import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getAvailablePaneMagnificationController,
  getPaneMagnificationShortcutLabel,
  isPaneMagnificationSelectionValid,
  PANE_MAGNIFICATION_DURATION_MS,
  resolvePaneMagnificationCandidate,
  resolvePaneMagnificationLayoutGeometry,
  resolvePaneMagnificationStyle,
  resolveTwoPaneMagnificationStyle,
  snapCssRectToDevicePixels,
  type PaneMagnificationController,
} from './paneMagnification.ts';

const geometryTransition = {
  transitionProperty: 'left, top, width, height',
  transitionDuration: '200ms',
  transitionTimingFunction: 'ease-out',
};

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
    ...geometryTransition,
    position: 'fixed',
    left: '132px',
    top: '92px',
    width: '1376px',
    height: '876px',
    zIndex: 50,
  });
});

test('magnified surface bounds snap to the device-pixel grid after the 12px inset', () => {
  const original = { left: '0px', top: '0px', width: '100px', height: '100px' };
  // Integer CSS pixels at 1x stay unchanged (existing contract).
  assert.deepEqual(resolvePaneMagnificationStyle(original, true, {
    left: 120,
    top: 80,
    width: 1400,
    height: 900,
  }, 1), {
    ...geometryTransition,
    position: 'fixed',
    left: '132px',
    top: '92px',
    width: '1376px',
    height: '876px',
    zIndex: 50,
  });

  // 120.4+12=132.4 at 2x -> 264.8 rounds to 265 -> 132.5
  // right: 120.4+1400-12=1508.4 at 2x -> 3016.8 rounds to 3017 -> 1508.5
  const snapped = resolvePaneMagnificationStyle(original, true, {
    left: 120.4,
    top: 80.4,
    width: 1400,
    height: 900,
  }, 2);
  assert.deepEqual(snapped, {
    ...geometryTransition,
    position: 'fixed',
    left: '132.5px',
    top: '92.5px',
    width: '1376px',
    height: '876px',
    zIndex: 50,
  });

  const rect = snapCssRectToDevicePixels(10.2, 20.2, 110.2, 80.2, 2);
  assert.deepEqual(rect, { left: 10, top: 20, width: 100, height: 60 });
});

test('switching to fixed positioning preserves the split origin below the tabs', () => {
  const original = { left: '300px', top: '0px', width: '300px', height: '400px' };
  const surface = { left: 100.4, top: 80.4, width: 1000, height: 800 };
  // A sidebar can offset the split containing block within the workspace.
  const origin = { left: 280.4, top: 80.4 };
  const magnified = resolvePaneMagnificationStyle(original, true, surface, 2, origin);
  const px = (value: unknown) => parseFloat(String(value));

  // The initial fixed frame uses the old local offsets. Non-transitioning
  // margins keep that frame at the same viewport position as the split pane.
  assert.equal(px(original.top) + px(magnified.marginTop), origin.top);
  assert.equal(px(original.left) + px(magnified.marginLeft), origin.left + 300);
  // The final rect is the device-snapped workspace inset, not a viewport inset
  // or an inset from the smaller split containing block.
  assert.equal(px(magnified.top) + px(magnified.marginTop), 92.5);
  assert.equal(px(magnified.left) + px(magnified.marginLeft), 112.5);
  assert.equal(px(magnified.width), 976);
  assert.equal(px(magnified.height), 776);
  assert.deepEqual(original, { left: '300px', top: '0px', width: '300px', height: '400px' });
});

test('restore retains the same geometry transition and overlay stacking until bounds clear', () => {
  const original = { left: '0px', top: '400px', width: '600px', height: '400px' };
  const surface = { left: 0, top: 80, width: 1200, height: 800 };
  const origin = { left: 0, top: 80, width: 1200, height: 800 };
  const magnified = resolvePaneMagnificationStyle(original, true, surface, 1, origin);
  const restoring = resolvePaneMagnificationStyle(original, false, surface, 1, origin);

  for (const property of ['transitionProperty', 'transitionDuration', 'transitionTimingFunction'] as const) {
    assert.equal(restoring[property], magnified[property]);
    assert.equal(restoring[property], geometryTransition[property]);
  }
  assert.equal(PANE_MAGNIFICATION_DURATION_MS, 200);
  assert.equal(restoring.zIndex, 50);
  assert.equal(restoring.position, 'fixed');
  assert.equal(restoring.marginTop, '80px');
  for (const property of ['left', 'top', 'width', 'height'] as const) {
    assert.equal(restoring[property], original[property]);
  }
  assert.equal(resolvePaneMagnificationStyle(original, false, null), original);
});

test('standalone zoom entry commits parent-resolved pixels before switching to fixed', () => {
  const original = { left: 0, top: 0, width: '100%', height: '100%' };
  const surface = { left: 220, top: 36, width: 1180, height: 864 };
  const origin = { left: 640, top: 36, width: 760, height: 864 };
  // Commit and flush this geometry while absolute, then apply the fixed target.
  // The CSS transition's starting lengths must already be px at that switch.
  const entry = resolvePaneMagnificationLayoutGeometry(original, origin);
  assert.deepEqual(entry, { left: '0px', top: '0px', width: '760px', height: '864px' });
  assert.equal(entry.position, undefined);
  assert.equal(entry.transitionDuration, undefined);
  const target = resolvePaneMagnificationStyle(original, true, surface, 1, origin);
  assert.deepEqual(target, {
    ...geometryTransition,
    position: 'fixed',
    marginLeft: '640px',
    marginTop: '36px',
    left: '-408px',
    top: '12px',
    width: '1156px',
    height: '840px',
    zIndex: 50,
  });
  assert.deepEqual(original, { left: 0, top: 0, width: '100%', height: '100%' });
});

test('standalone terminal restore resolves percentage geometry against its layout parent', () => {
  const original = { left: 0, top: 0, width: '100%', height: '100%' };
  const surface = { left: 100, top: 80, width: 1200, height: 800 };
  const origin = { left: 300, top: 100, width: 1000, height: 760 };
  const magnified = resolvePaneMagnificationStyle(original, true, surface, 1, origin);
  const restoring = resolvePaneMagnificationStyle(original, false, surface, 1, origin);

  assert.deepEqual(restoring, {
    ...geometryTransition,
    position: 'fixed',
    zIndex: 50,
    marginLeft: '300px',
    marginTop: '100px',
    left: '0px',
    top: '0px',
    width: '1000px',
    height: '760px',
  });
  for (const property of [
    'transitionProperty', 'transitionDuration', 'transitionTimingFunction', 'position', 'zIndex',
  ] as const) {
    assert.equal(restoring[property], magnified[property]);
  }
  assert.equal(resolvePaneMagnificationStyle(original, false, null, 1, origin), original);
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
