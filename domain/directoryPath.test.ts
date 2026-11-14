import assert from 'node:assert/strict';
import test from 'node:test';
import { isAbsoluteDirectoryPath, joinDirectoryPath, labelDirectoryPath, parentDirectoryPath, sameDirectoryPath, sameDirectoryTarget } from './directoryPath';
import { directoryChangeCommand, directoryEntries } from './directoryPicker';

test('Win32 roots, drive-absolute paths and UNC shares never become relative paths', () => {
  for (const root of ['C:\\', 'C:\\\\', 'D:/', '\\\\server\\share', '\\\\server\\share\\', '\\\\server\\share\\\\']) {
    assert.ok(isAbsoluteDirectoryPath(root, 'win32'), root);
    assert.equal(parentDirectoryPath(root, 'win32'), null, root);
  }
  assert.equal(parentDirectoryPath('D:\\one\\two', 'win32'), 'D:\\one');
  assert.equal(parentDirectoryPath('D:/one/', 'win32'), 'D:\\');
  assert.equal(parentDirectoryPath('\\\\server\\share\\one', 'win32'), '\\\\server\\share\\');
  for (const path of ['C:foo', 'C:', '\\foo', '/home/me', '\\\\server', '\\\\?\\C:\\x', '\\\\.\\C:\\x', 'C:\\a\n', 'C:\\a\x1b', 'C:\\a:stream', 'C:\\a.', 'C:\\a ']) {
    assert.equal(isAbsoluteDirectoryPath(path, 'win32'), false, path);
  }
});

test('path joins and home labels retain namespace, names, and case boundaries', () => {
  assert.equal(joinDirectoryPath('C:\\', "O'Brien [$]", 'win32'), "C:\\O'Brien [$]");
  assert.equal(joinDirectoryPath('\\\\server\\share', 'child', 'win32'), '\\\\server\\share\\child');
  assert.equal(joinDirectoryPath('/base', 'back\\slash', 'posix'), '/base/back\\slash');
  for (const name of ['../escape', '..', '.', 'a\\b', 'a\n', 'a:stream']) assert.equal(joinDirectoryPath('C:\\base', name, 'win32'), null);
  assert.equal(labelDirectoryPath('C:\\Users\\me\\src', 'C:\\Users\\me', 'win32'), '~\\src');
  assert.equal(labelDirectoryPath('C:\\Users\\metal', 'C:\\Users\\me', 'win32'), 'C:\\Users\\metal');
  assert.equal(labelDirectoryPath('/home/me/src', '/home/me', 'posix'), '~/src');
  assert.equal(labelDirectoryPath('/base', '/', 'posix'), '~/base');
  assert.equal(sameDirectoryPath('C:/base/', 'C:\\base', 'win32'), true);
  assert.equal(sameDirectoryPath('C:\\case', 'C:\\CASE', 'win32'), false);
  assert.equal(sameDirectoryPath('/a/../b', '/b', 'posix'), false, 'do not normalize through symlinks');
  assert.equal(sameDirectoryTarget({ authority: 'wsl:a', pathFlavor: 'posix' }, { authority: 'wsl:b', pathFlavor: 'posix' }), false);
  assert.equal(sameDirectoryTarget({ authority: 'local:a', pathFlavor: 'win32' }, { authority: 'ssh:a', pathFlavor: 'posix' }), false);
});

test('PowerShell uses literal paths and quoting independently of POSIX restore callers', () => {
  const path = "D:\\O'Brien [$]`;&!%";
  assert.equal(directoryChangeCommand(path, 'powershell', 'win32'), "Microsoft.PowerShell.Management\\Set-Location -LiteralPath 'D:\\O''Brien [$]`;&!%'");
  assert.equal(directoryChangeCommand(path, 'posix', 'win32'), null);
  assert.equal(directoryChangeCommand('D:relative', 'powershell', 'win32'), null);
  assert.equal(directoryChangeCommand('C:\\smart\u2019;echo injected;\u2018', 'powershell', 'win32'),
    "Microsoft.PowerShell.Management\\Set-Location -LiteralPath 'C:\\smart\u2019\u2019;echo injected;\u2018\u2018'");
  assert.equal(directoryChangeCommand('/a\n', 'posix', 'posix'), null);
  assert.equal(directoryChangeCommand("/O'Brien", 'posix', 'posix'), "cd -- '/O'\\''Brien'");
  assert.deepEqual(directoryEntries('C:\\base', [
    { name: 'child', type: 'directory', size: '', lastModified: '' },
    { name: 'a\\b', type: 'directory', size: '', lastModified: '' },
  ], 'win32').map(entry => entry.path), ['C:\\base\\child']);
});
