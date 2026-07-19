import test from 'node:test';
import assert from 'node:assert/strict';

import { advanceSftpTypeahead, resolveSftpTypeaheadSource } from './sftpTypeahead.ts';

const names = ['config', 'Error.log', 'errors.old', 'readme'];

test('SFTP typeahead narrows the match as the user keeps typing', () => {
  const first = advanceSftpTypeahead(names, null, 'e', 100);
  const second = advanceSftpTypeahead(names, first.state, 'r', 200);
  const third = advanceSftpTypeahead(names, second.state, 'r', 300);

  assert.deepEqual(
    [first.state.query, second.state.query, third.state.query],
    ['e', 'er', 'err'],
  );
  assert.deepEqual(
    [first.matchIndex, second.matchIndex, third.matchIndex],
    [1, 1, 1],
  );
});

test('SFTP typeahead starts a new search after the typing pause', () => {
  const first = advanceSftpTypeahead(names, null, 'e', 100);
  const afterPause = advanceSftpTypeahead(names, first.state, 'r', 1200);

  assert.equal(afterPause.state.query, 'r');
  assert.equal(afterPause.matchIndex, 3);
});

test('SFTP typeahead never falls back to hidden tree items in list view', () => {
  assert.deepEqual(resolveSftpTypeaheadSource('list', [], [
    { name: 'hidden-tree-file.log', path: '/hidden-tree-file.log' },
  ]), {
    kind: 'list',
    names: [],
  });
});
