import assert from 'node:assert/strict';
import test from 'node:test';

import type { Workspace } from '../../domain/models';
import { collectSessionIds } from '../../domain/workspace';
import { moveWorkspacePaneInWorkspaces } from './useSessionState';

// Issue #4037: moving a member pane must rearrange only the tree shape.
// Session ids, workspace id, anchorChatId (AI binding), focus fields and tab
// order all live outside the touched surface, and these tests pin that.

const workspace = (id = 'ws-1'): Workspace => ({
  id,
  title: 'Workspace',
  focusedSessionId: 's1',
  focusSessionOrder: ['s1', 's2', 's3'],
  anchorChatId: 'chat-anchor-1',
  root: {
    id: 'split-1',
    type: 'split',
    direction: 'vertical',
    children: [
      { id: 'pane-1', type: 'pane', sessionId: 's1' },
      { id: 'pane-2', type: 'pane', sessionId: 's2' },
      { id: 'pane-3', type: 'pane', sessionId: 's3' },
    ],
    sizes: [1, 1, 1],
  },
});

test('moveWorkspacePaneInWorkspaces rearranges the tree and preserves every identity field', () => {
  const ws = workspace();
  const next = moveWorkspacePaneInWorkspaces([ws], 'ws-1', 's3', {
    direction: 'vertical',
    position: 'left',
    targetSessionId: 's1',
  });

  assert.equal(next.length, 1);
  const moved = next[0];
  assert.equal(moved.id, ws.id, 'workspace id (AI binding key) unchanged');
  assert.equal(moved.title, ws.title);
  assert.equal(moved.anchorChatId, 'chat-anchor-1', 'anchorChatId unchanged');
  assert.equal(moved.focusedSessionId, 's1', 'focus stays on the same session id');
  assert.deepEqual(moved.focusSessionOrder, ['s1', 's2', 's3'], 'tab/focus order unchanged');
  assert.deepEqual(collectSessionIds(moved.root), ['s3', 's1', 's2']);
  assert.notEqual(moved.root, ws.root, 'the tree shape actually changed');
});

test('moveWorkspacePaneInWorkspaces leaves other workspaces and no-op cases untouched', () => {
  const ws1 = workspace('ws-1');
  const ws2 = workspace('ws-2');

  // Same-reference no-op: pane dropped onto itself.
  const selfDrop = moveWorkspacePaneInWorkspaces([ws1, ws2], 'ws-1', 's2', {
    direction: 'vertical',
    position: 'left',
    targetSessionId: 's2',
  });
  assert.equal(selfDrop[0], ws1, 'no-op workspace keeps its reference');
  assert.equal(selfDrop[1], ws2);

  // Unknown session / foreign workspace id: nothing moves.
  const ghost = moveWorkspacePaneInWorkspaces([ws1, ws2], 'ws-1', 'ghost', {
    direction: 'vertical',
    position: 'left',
    targetSessionId: 's1',
  });
  assert.equal(ghost[0], ws1);
  assert.equal(ghost[1], ws2);

  const foreign = moveWorkspacePaneInWorkspaces([ws1, ws2], 'ws-other', 's1', {
    direction: 'vertical',
    position: 'left',
    targetSessionId: 's2',
  });
  assert.equal(foreign[0], ws1);
  assert.equal(foreign[1], ws2);
});

test('moveWorkspacePaneInWorkspaces only rewrites the targeted workspace entry', () => {
  const ws1 = workspace('ws-1');
  const ws2 = workspace('ws-2');
  const next = moveWorkspacePaneInWorkspaces([ws1, ws2], 'ws-2', 's2', {
    direction: 'vertical',
    position: 'right',
    targetSessionId: 's3',
  });
  assert.equal(next[0], ws1, 'sibling workspaces keep their references');
  assert.notEqual(next[1], ws2);
  assert.deepEqual(collectSessionIds(next[1].root), ['s1', 's3', 's2']);
});
