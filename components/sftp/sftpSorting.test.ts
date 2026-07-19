import test from 'node:test';
import assert from 'node:assert/strict';

import type { SftpFileEntry } from '../../types.ts';
import { sortSftpEntries } from './utils.ts';

const entry = (
  name: string,
  type: SftpFileEntry['type'],
  lastModified: number,
): SftpFileEntry => ({
  name,
  type,
  size: 0,
  sizeFormatted: '0 B',
  lastModified,
  lastModifiedFormatted: String(lastModified),
});

const entries = [
  entry('dir-a', 'directory', 100),
  entry('newest.log', 'file', 300),
  entry('dir-b', 'directory', 200),
];

test('SFTP sorting keeps directories first by default', () => {
  const sorted = sortSftpEntries(entries, 'modified', 'desc');

  assert.deepEqual(sorted.map(({ name }) => name), ['dir-b', 'dir-a', 'newest.log']);
});

test('SFTP sorting can mix files and directories in the selected order', () => {
  const sorted = sortSftpEntries(entries, 'modified', 'desc', false);

  assert.deepEqual(sorted.map(({ name }) => name), ['newest.log', 'dir-b', 'dir-a']);
});
