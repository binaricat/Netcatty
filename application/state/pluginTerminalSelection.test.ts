import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginTerminalSelectionSource } from './usePluginTerminalSelection';
import { readPluginTerminalSelection, registerTerminalSelectionSource } from '../../infrastructure/plugins/terminalSelectionRegistry';
import type { Terminal } from '@xterm/xterm';

function fixture() {
  let reads = 0;
  const term = { cols: 80, element: { isConnected: true },
    getSelectionPosition: () => ({ start: { x: 0, y: 0 }, end: { x: 3, y: 0 } }),
    getSelection() { reads++; return 'raw'; },
    buffer: { active: { getLine: () => ({ length: 3, translateToString: () => 'normalized' }) } },
  } as unknown as Terminal;
  const state = { term, sessionId: 'a', bootEpoch: 1, visible: true, isFocusedPane: true, connected: true, sensitive: false, normalize: false, label: 'Synthetic A' };
  const source = createPluginTerminalSelectionSource(() => state, 'renderer');
  return { term, state, source, get reads() { return reads; } };
}

test('registered reader honors explicit false normalization and reads only on Preview', () => {
  const f = fixture();
  const cleanup = registerTerminalSelectionSource('a', f.source);
  try {
    assert.equal(f.reads, 0);
    assert.equal(readPluginTerminalSelection('a', 'renderer:1'), 'raw');
    assert.equal(f.reads, 1);
    f.state.normalize = true;
    assert.equal(readPluginTerminalSelection('a', 'renderer:1'), 'normalized');
  } finally { cleanup(); }
});
test('separate terminal references, hidden/attached renderer, reconnect and empty selection have no fallback', () => {
  const a = fixture(), b = fixture(); b.state.sessionId = 'b';
  const cleanupA = registerTerminalSelectionSource('a', a.source), cleanupB = registerTerminalSelectionSource('b', b.source);
  try {
    assert.throws(() => readPluginTerminalSelection('wrong', 'renderer:1'), /no longer/);
    a.term.getSelection = () => '';
    assert.throws(() => readPluginTerminalSelection('a', 'renderer:1'), /between 1/);
    assert.equal(b.reads, 0);
    a.state.bootEpoch++;
    assert.throws(() => readPluginTerminalSelection('a', 'renderer:1'), /no longer/);
    for (const field of ['visible', 'isFocusedPane', 'connected'] as const) {
      a.state[field] = false;
      assert.equal(a.source.target(), null);
      a.state[field] = true;
    }
    a.state.sensitive = true;
    assert.equal(a.source.target(), null);
    a.state.sensitive = false;
    Object.defineProperty(a.term.element, 'isConnected', { value: false });
    assert.equal(a.source.target(), null);
  } finally { cleanupA(); cleanupB(); }
  assert.throws(() => readPluginTerminalSelection('b', 'renderer:1'), /no longer/);
});
test('oversized ranges refuse to materialize selection and UTF-8 bytes are bounded', () => {
  const f = fixture(), cleanup = registerTerminalSelectionSource('a', f.source);
  try {
    f.term.getSelectionPosition = () => ({ start: { x: 0, y: 0 }, end: { x: 1, y: 100 } });
    assert.throws(() => readPluginTerminalSelection('a', 'renderer:1'), /bounded/);
    assert.equal(f.reads, 0);
    f.term.getSelectionPosition = () => ({ start: { x: 0, y: 0 }, end: { x: 1, y: 0 } });
    f.term.getSelection = () => '\u20ac'.repeat(1366);
    assert.throws(() => readPluginTerminalSelection('a', 'renderer:1'), /4096 bytes/);
  } finally { cleanup(); }
});

test('real pane snapshots give sharing ownership to solo, Focus mode, and only the selected split pane', async () => {
  const { getTerminalPaneRenderSnapshot, parseTerminalPaneRenderSnapshot, resolveTerminalPaneInputProps } = await import('../../components/terminalPaneVisibility');
  const workspaceById = new Map<string, import('../../types').Workspace>([
    ['split', { id: 'split', title: 'Split', viewMode: 'split', focusedSessionId: 'split-a', root: { id: 'split-root', type: 'split', direction: 'vertical', children: [{ id: 'a', type: 'pane', sessionId: 'split-a' }, { id: 'b', type: 'pane', sessionId: 'split-b' }] } }],
    ['focus', { id: 'focus', title: 'Focus', viewMode: 'focus', focusedSessionId: 'focus-a', root: { id: 'focus-root', type: 'split', direction: 'vertical', children: [{ id: 'a', type: 'pane', sessionId: 'focus-a' }, { id: 'b', type: 'pane', sessionId: 'focus-b' }] } }],
  ]);
  const cases = [
    { name: 'solo', activeTabId: 'solo', sessionId: 'solo', eligible: true },
    { name: 'inactive solo', activeTabId: 'solo', sessionId: 'other', eligible: false },
    { name: 'Focus mode', activeTabId: 'focus', sessionId: 'focus-a', sessionWorkspaceId: 'focus', eligible: true },
    { name: 'other Focus pane', activeTabId: 'focus', sessionId: 'focus-b', sessionWorkspaceId: 'focus', eligible: false },
    { name: 'selected split', activeTabId: 'split', sessionId: 'split-a', sessionWorkspaceId: 'split', eligible: true },
    { name: 'other visible split', activeTabId: 'split', sessionId: 'split-b', sessionWorkspaceId: 'split', eligible: false },
    { name: 'inactive workspace', activeTabId: 'solo', sessionId: 'split-a', sessionWorkspaceId: 'split', eligible: false },
    { name: 'hidden layer', activeTabId: 'solo', sessionId: 'solo', isTerminalLayerVisible: false, eligible: false },
  ];
  for (const item of cases) {
    const snapshot = getTerminalPaneRenderSnapshot({ ...item, workspaceById, isTerminalLayerVisible: item.isTerminalLayerVisible ?? true });
    const inputProps = resolveTerminalPaneInputProps(parseTerminalPaneRenderSnapshot(snapshot));
    const f = fixture();
    const state = { ...f.state, sessionId: item.sessionId, visible: inputProps.isVisible,
      isFocusedPane: inputProps.isFocusedPane };
    const source = createPluginTerminalSelectionSource(() => state, 'derived-pane');
    assert.equal(source.target() !== null, item.eligible, `${item.name}: ${snapshot}`);
    if (item.name === 'solo' || item.name === 'Focus mode') assert.equal(inputProps.isFocused, false, 'do not redefine the legacy focus bit');
  }
});
