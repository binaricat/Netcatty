import assert from 'node:assert/strict';
import test from 'node:test';
import type { TerminalSession, Workspace } from './models';
import {
  buildOrderedTerminalTabIds,
  isRootNavigationTabId,
  resolveAdjacentTabId,
  resolveNextActiveTabAfterTerminalClose,
} from './tabCloseFocus';

const standaloneSession = (id: string, overrides: Partial<TerminalSession> = {}): TerminalSession => ({
  id,
  hostId: id,
  hostLabel: id,
  username: 'user',
  hostname: id,
  status: 'connected',
  ...overrides,
});

const workspace = (id: string, sessionId = `${id}-pane`): Workspace => ({
  id,
  title: id,
  focusedSessionId: sessionId,
  root: { id: `${id}-root`, type: 'pane', sessionId },
});

test('isRootNavigationTabId recognizes vault and sftp only', () => {
  assert.equal(isRootNavigationTabId('vault'), true);
  assert.equal(isRootNavigationTabId('sftp'), true);
  assert.equal(isRootNavigationTabId('session-1'), false);
  assert.equal(isRootNavigationTabId('plugin-view:owner:view'), false);
  assert.equal(isRootNavigationTabId('editor:file-1'), false);
  assert.equal(isRootNavigationTabId(null), false);
  assert.equal(isRootNavigationTabId(undefined), false);
});

test('buildOrderedTerminalTabIds honors visual tabOrder and excludes hidden or workspace-bound sessions', () => {
  const ordered = buildOrderedTerminalTabIds({
    sessions: [
      standaloneSession('s1'),
      standaloneSession('s2'),
      standaloneSession('s3'),
      standaloneSession('hidden', { hiddenFromTabs: true }),
      standaloneSession('ws-member', { workspaceId: 'ws-1' }),
    ],
    workspaces: [workspace('ws-1', 'ws-member')],
    tabOrder: ['s3', 'stale', 'ws-1', 's1'],
  });

  assert.deepEqual(ordered, ['s3', 'ws-1', 's1', 's2']);
});

test('resolveAdjacentTabId prefers immediate left neighbor, then immediate right neighbor', () => {
  assert.equal(
    resolveAdjacentTabId({
      orderedTabIdsBeforeClose: ['a', 'b', 'c'],
      survivingTabIds: ['a', 'b'],
      closedTabId: 'c',
    }),
    'b',
  );
  assert.equal(
    resolveAdjacentTabId({
      orderedTabIdsBeforeClose: ['a', 'b', 'c'],
      survivingTabIds: ['a', 'c'],
      closedTabId: 'b',
    }),
    'a',
  );
  assert.equal(
    resolveAdjacentTabId({
      orderedTabIdsBeforeClose: ['a', 'b', 'c'],
      survivingTabIds: ['b', 'c'],
      closedTabId: 'a',
    }),
    'b',
  );
});

test('closing a terminal tab never jumps to vault, sftp, or plugin views while other terminal tabs remain (#4249)', () => {
  for (const nonTerminalView of ['vault', 'sftp', 'plugin-view:demo:main', 'editor:file-1']) {
    assert.equal(
      resolveNextActiveTabAfterTerminalClose({
        currentActiveTabId: 'c',
        closedTabId: 'c',
        orderedTabIdsBeforeClose: ['a', 'b', 'c'],
        survivingTabIds: ['a', 'b'],
        preferredTabId: nonTerminalView,
      }),
      'b',
      `expected adjacent tab b instead of ${nonTerminalView}`,
    );
  }
});

test('closing the last terminal tab falls back to vault or sftp when preferred, otherwise vault', () => {
  assert.equal(
    resolveNextActiveTabAfterTerminalClose({
      currentActiveTabId: 'a',
      closedTabId: 'a',
      orderedTabIdsBeforeClose: ['a'],
      survivingTabIds: [],
      preferredTabId: 'sftp',
    }),
    'sftp',
  );
  assert.equal(
    resolveNextActiveTabAfterTerminalClose({
      currentActiveTabId: 'a',
      closedTabId: 'a',
      orderedTabIdsBeforeClose: ['a'],
      survivingTabIds: [],
      preferredTabId: 'vault',
    }),
    'vault',
  );
  assert.equal(
    resolveNextActiveTabAfterTerminalClose({
      currentActiveTabId: 'a',
      closedTabId: 'a',
      orderedTabIdsBeforeClose: ['a'],
      survivingTabIds: [],
      preferredTabId: 'plugin-view:demo:main',
    }),
    'vault',
  );
});

test('closing a temporary terminal tab still restores a surviving prior terminal tab (#2788)', () => {
  assert.equal(
    resolveNextActiveTabAfterTerminalClose({
      currentActiveTabId: 's7',
      closedTabId: 's7',
      orderedTabIdsBeforeClose: ['s1', 's2', 's5', 's6', 's7'],
      survivingTabIds: ['s1', 's2', 's5', 's6'],
      preferredTabId: 's5',
    }),
    's5',
  );
});

test('closing an inactive terminal tab returns null', () => {
  assert.equal(
    resolveNextActiveTabAfterTerminalClose({
      currentActiveTabId: 'b',
      closedTabId: 'c',
      orderedTabIdsBeforeClose: ['a', 'b', 'c'],
      survivingTabIds: ['a', 'b'],
      preferredTabId: 'vault',
    }),
    null,
  );
});
