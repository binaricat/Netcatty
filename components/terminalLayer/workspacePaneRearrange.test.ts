import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Source-contract tests for issue #4037 (rearrange member panes within a
// workspace). The layout hook is render-heavy; these pin the wiring the way
// TerminalLayerTabBridge.test.ts pins its bridge.

const layoutSource = readFileSync(new URL('./useTerminalWorkspaceLayout.ts', import.meta.url), 'utf8');
const bridgeSource = readFileSync(new URL('./TerminalLayerTabBridge.tsx', import.meta.url), 'utf8');
const stateSource = readFileSync(new URL('../../application/state/useSessionState.ts', import.meta.url), 'utf8');

test('drop handler rearranges same-workspace panes and still rejects cross-workspace drops', () => {
  assert.match(layoutSource, /draggedSession\.workspaceId === activeWorkspace\.id/);
  // Cross-workspace drops must fall through without calling either action:
  // the branch only moves when the ids match, then returns unconditionally.
  const dropBody = layoutSource.slice(layoutSource.indexOf('const handleWorkspaceDrop'));
  assert.match(dropBody, /if \(draggedSession\.workspaceId === activeWorkspace\.id\) \{\s*onMoveWorkspacePane/);
  assert.match(dropBody, /onAddSessionToWorkspace\(activeWorkspace\.id, draggedSessionId, hint\)/);
});

test('member pane drags drive the split-hint preview over the pointer stream', () => {
  assert.match(layoutSource, /isMemberPaneDrag/);
  assert.match(layoutSource, /window\.addEventListener\('pointermove', onPointerMove\)/);
  // Release is owned by the pane gesture, not a competing window listener.
  assert.match(bridgeSource, /onDropWorkspacePane: handleWorkspacePanePointerDrop/);
  assert.doesNotMatch(layoutSource, /window\.addEventListener\('pointerup'/);
});

test('the bridge threads the move action and the dragged member session', () => {
  assert.match(bridgeSource, /onMoveWorkspacePane: s\.onMoveWorkspacePane/);
  assert.match(bridgeSource, /draggingSession: s\.draggingSessionId/);
});

test('moveWorkspacePane mutates only the workspace pane tree', () => {
  const start = stateSource.indexOf('const moveWorkspacePane = useCallback');
  const end = stateSource.indexOf('const createWorkspaceFromSessions = useCallback', start);
  assert.ok(start > -1 && end > start, 'moveWorkspacePane callback exists');
  const body = stateSource.slice(start, end);
  assert.match(body, /moveWorkspacePaneInWorkspaces\(prev, workspaceId, sessionId, hint\)/);
  // Identity guarantee: no session, tab-order, focus or AI-state writes.
  assert.doesNotMatch(body, /setSessions|setTabOrder|setActiveTabId|setWorkspaceFocusedSession|anchorChat|activeSessionIdMap/);
});
