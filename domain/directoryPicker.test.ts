import assert from 'node:assert/strict';
import test from 'node:test';
import { directoryDisplayName, directoryEntries, directoryLabel, directoryParent, filterDirectories, isDirectoryPath } from './directoryPicker';

test('directory paths preserve names, enforce home boundaries, and stop at root', () => {
  assert.equal(directoryLabel('/home/me/a ', '/home/me'), '~/a ');
  assert.equal(directoryLabel('/home/metal/a', '/home/me'), '/home/metal/a');
  assert.equal(directoryParent('/'), null);
  assert.equal(directoryParent('/one/'), '/');
  assert.equal(directoryParent('/one/two '), '/one');
  assert.ok(isDirectoryPath("/a '$()`中文"));
  for (const value of ['~/a', 'C:\\a', '/a\n', '/a\x1b', '/a\0']) assert.equal(isDirectoryPath(value), false);
  assert.equal(directoryDisplayName('a\n\x1b'), 'a\\x0a\\x1b');
});

test('directory results include only directories and directory symlinks; filtering is local and natural', () => {
  const entries = directoryEntries('/base', [
    { name: 'app10', type: 'directory', size: '', lastModified: '' },
    { name: 'app2', type: 'symlink', linkTarget: 'directory', size: '', lastModified: '' },
    { name: '.config', type: 'directory', size: '', lastModified: '' },
    { name: 'broken', type: 'symlink', size: '', lastModified: '' },
    { name: 'file', type: 'file', size: '', lastModified: '' },
    { name: '..', type: 'directory', size: '', lastModified: '' },
  ]);
  assert.deepEqual(filterDirectories(entries, 'APP', false).map(entry => entry.path), ['/base/app2', '/base/app10']);
  assert.equal(filterDirectories(entries, '', false).length, 2);
  assert.equal(filterDirectories(entries, '', true).length, 3);
  assert.deepEqual(filterDirectories(entries, 'missing', true), []);
});
