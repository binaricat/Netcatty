import test from 'node:test';
import assert from 'node:assert/strict';

import { sftpPaneViewModeStore } from './sftpPaneViewModeStore.ts';

test('SFTP pane view mode store distinguishes an empty list from tree view', () => {
  const paneId = 'empty-list-pane';
  assert.equal(sftpPaneViewModeStore.get(paneId), 'list');

  sftpPaneViewModeStore.set(paneId, 'tree');
  assert.equal(sftpPaneViewModeStore.get(paneId), 'tree');

  sftpPaneViewModeStore.set(paneId, 'list');
  assert.equal(sftpPaneViewModeStore.get(paneId), 'list');
  sftpPaneViewModeStore.clear(paneId);
});
