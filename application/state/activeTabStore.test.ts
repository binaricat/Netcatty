import assert from 'node:assert/strict';
import test from 'node:test';

import { isTerminalLayerVisibleTab } from './activeTabStore';

test('terminal layer stays visible for editor tabs so the host sidebar can be used', () => {
  assert.equal(isTerminalLayerVisibleTab('editor:file-1'), true);
});

test('terminal layer visibility excludes root pages and includes work tabs', () => {
  assert.equal(isTerminalLayerVisibleTab('vault'), false);
  assert.equal(isTerminalLayerVisibleTab('sftp'), false);
  assert.equal(isTerminalLayerVisibleTab('session-1'), true);
  assert.equal(isTerminalLayerVisibleTab('workspace-1'), true);
});
