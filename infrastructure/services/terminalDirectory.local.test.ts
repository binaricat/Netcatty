import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { createTerminalDirectoryIO } from './terminalDirectory';
import { createTerminalDirectoryController } from '../../application/state/terminalDirectoryController';
import {
  observeTerminalDirectory, registerTerminalDirectory, scheduleObservedTerminalDirectoryRefresh,
} from '../../application/state/terminalDirectoryRegistry';

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

test('manual cd and delayed shell functions update the observed cwd without shell integration', {
  skip: process.platform === 'win32', timeout: 20000,
}, async t => {
  const tempDirBridge = require('../../electron/bridges/tempDirBridge.cjs');
  const { readLocalSessionCwd } = require('../../electron/bridges/localSessionCwd.cjs');
  const pty = require('node-pty') as typeof import('node-pty');
  tempDirBridge.ensureTempDir();
  const fixture = fs.mkdtempSync(tempDirBridge.getTempFilePath('manual-directory-cd-'));
  const first = path.join(fixture, 'first'); const second = path.join(fixture, 'second');
  fs.mkdirSync(first); fs.mkdirSync(second);
  const id = 'manual-cd-shell';
  // An intentionally non-standard PS1: no trusted prompt/completion callback
  // or OSC directory reporting is available to drive chip updates.
  const shell = pty.spawn('/bin/bash', ['--noprofile', '--norc', '-i'], {
    cwd: fixture, env: { ...process.env, PS1: 'custom input: ', PROMPT_COMMAND: '' }, cols: 100, rows: 24,
  });
  let output = ''; let published = '';
  const subscription = shell.onData(data => {
    output += data;
    scheduleObservedTerminalDirectoryRefresh(id);
  });
  const controller = createTerminalDirectoryController({
    sessionId: id, isCurrent: () => true, isReady: () => false,
    io: { cwd: async () => {
      const result = await readLocalSessionCwd({ pty: shell });
      assert.ok(result.success); return result.cwd;
    }, list: async () => ({ entries: [], home: null }), realpath: async value => value,
    write() { assert.fail('manual navigation must not use the picker write action'); } },
    publish: cwd => { published = cwd; },
  });
  const unregister = registerTerminalDirectory(id, controller);
  const stopObserving = observeTerminalDirectory(id);
  t.after(() => { stopObserving(); unregister(); subscription.dispose(); shell.kill(); fs.rmSync(fixture, { recursive: true, force: true }); });
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert.ok(condition(), 'cwd followed actual shell output');
  };
  await waitFor(() => output.includes('custom input: '));
  shell.write(`cd -- '${first}'\r`);
  await waitFor(() => published === fs.realpathSync(first));
  // The directory changes well after a fixed post-Enter timer would fire.
  shell.write(`go_later() { sleep 0.6; cd -- '${second}'; }; go_later\r`);
  await waitFor(() => published === fs.realpathSync(second));
});
