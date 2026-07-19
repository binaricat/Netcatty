import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveSftpActiveSelection, resolveSftpSelectAllTarget } from './sftpSelection.ts';

const treeSelection = [{ name: 'tree.log', path: '/tree.log' }];

test('SFTP list view ignores hidden tree selection', () => {
  assert.deepEqual(resolveSftpActiveSelection('list', ['list.log'], treeSelection), {
    selectedFileNames: ['list.log'],
    treeSelection: [],
  });
});

test('SFTP tree view ignores hidden list selection even when tree selection is empty', () => {
  assert.deepEqual(resolveSftpActiveSelection('tree', ['hidden-list.log'], []), {
    selectedFileNames: [],
    treeSelection: [],
  });
});

test('SFTP select-all does not fall back to hidden list items in an empty tree', () => {
  assert.equal(resolveSftpSelectAllTarget('tree', 0), 'none');
  assert.equal(resolveSftpSelectAllTarget('tree', 2), 'tree');
  assert.equal(resolveSftpSelectAllTarget('list', 0), 'list');
});
