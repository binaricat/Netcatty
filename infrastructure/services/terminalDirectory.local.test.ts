import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { createTerminalDirectoryIO } from './terminalDirectory';
import { createTerminalDirectoryController } from '../../application/state/terminalDirectoryController';

const require = createRequire(import.meta.url);

test('directory picker changes a real POSIX PTY cwd with quoted names and directory symlinks', {
  skip: process.platform === 'win32', timeout: 20000,
}, async t => {
  const tempDirBridge = require('../../electron/bridges/tempDirBridge.cjs');
  const { readLocalSessionCwd } = require('../../electron/bridges/localSessionCwd.cjs');
  const pty = require('node-pty') as typeof import('node-pty');
  tempDirBridge.ensureTempDir();
  const fixture = fs.mkdtempSync(tempDirBridge.getTempFilePath('directory-picker-'));
  const name = "space ' $() `literal` 中文";
  const target = path.join(fixture, name);
  fs.mkdirSync(target);
  fs.symlinkSync(target, path.join(fixture, 'link'));
  let ready = false;
  const shell = pty.spawn('/bin/bash', ['--noprofile', '--norc', '-i'], {
    cwd: fixture, env: { ...process.env, PS1: '__DIRECTORY_READY__ ', PROMPT_COMMAND: '' },
    cols: 100, rows: 24,
  });
  shell.onData(data => { if (data.includes('__DIRECTORY_READY__ ')) ready = true; });
  const waitReady = async () => {
    const deadline = Date.now() + 4000;
    while (!ready && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(ready, 'shell reached its prompt');
  };
  t.after(() => { shell.kill(); fs.rmSync(fixture, { recursive: true, force: true }); });
  await waitReady();
  let published = '';
  const io = createTerminalDirectoryIO({
    getSessionPwd: async () => readLocalSessionCwd({ pty: shell }),
    realpathLocal: async value => fs.promises.realpath(value),
    writeToSession: (id, data) => { assert.equal(id, 'real-shell'); ready = false; shell.write(data); },
  } as unknown as NetcattyBridge, 'real-shell', { local: true, hostname: '', username: '' });
  const controller = createTerminalDirectoryController({
    sessionId: 'real-shell', io, isReady: () => ready, isCurrent: () => true,
    publish: cwd => { published = cwd; },
  });
  t.after(() => controller.dispose());
  await controller.change(target, new AbortController().signal, () => {});
  assert.equal(await io.cwd(), fs.realpathSync(target));
  assert.equal(published, fs.realpathSync(target));
  await waitReady();
  await controller.change(path.join(fixture, 'link'), new AbortController().signal, () => {});
  assert.equal(await io.cwd(), fs.realpathSync(target));
});
