import test from 'node:test';
import assert from 'node:assert/strict';
import { getSftpVirtualListScrollTop } from './sftpVirtualList';

test('SFTP typeahead can reveal an item outside a large virtualized viewport', () => {
  assert.equal(getSftpVirtualListScrollTop({
    itemIndex: 75,
    rowHeight: 28,
    currentScrollTop: 0,
    viewportHeight: 280,
  }), 1848);
});

test('SFTP virtualized list keeps an already visible selection in place', () => {
  assert.equal(getSftpVirtualListScrollTop({
    itemIndex: 12,
    rowHeight: 28,
    currentScrollTop: 280,
    viewportHeight: 280,
  }), 280);
});
