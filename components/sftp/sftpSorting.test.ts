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

test('SFTP kind sorting keeps directories first when enabled', () => {
  const kindEntries = [
    entry('BUILD', 'file', 100),
    entry('src', 'directory', 100),
    entry('archive.zip', 'file', 100),
  ];

  const sorted = sortSftpEntries(kindEntries, 'type', 'asc', true);

  assert.deepEqual(sorted.map(({ name }) => name), ['src', 'BUILD', 'archive.zip']);
});

test('SFTP descending kind sorting keeps directories first when enabled', () => {
  const kindEntries = [
    entry('BUILD', 'file', 100),
    entry('src', 'directory', 100),
    entry('archive.zip', 'file', 100),
  ];

  const sorted = sortSftpEntries(kindEntries, 'type', 'desc', true);

  assert.deepEqual(sorted.map(({ name }) => name), ['src', 'archive.zip', 'BUILD']);
});

test('SFTP kind sorting can mix files and directories when folders first is disabled', () => {
  const kindEntries = [
    entry('BUILD', 'file', 100),
    entry('src', 'directory', 100),
    entry('archive.zip', 'file', 100),
  ];

  const sorted = sortSftpEntries(kindEntries, 'type', 'asc', false);

  assert.deepEqual(sorted.map(({ name }) => name), ['BUILD', 'src', 'archive.zip']);
});
