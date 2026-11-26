const assert = require('node:assert/strict');
const test = require('node:test');
const { PREFIX, createCmdDirectoryReader, prepareCmdDirectoryIntegration, readWindowsProcessTree } = require('./cmdDirectoryIntegration.cjs');

test('CMD prompt reports are session scoped, filtered and invalidated on new input', async () => {
  const reader = createCmdDirectoryReader('session', 'C:\\Home', (pid, done) => done({ pid, children: [] }));
  reader.setProcessId(10);
  const frame = PREFIX + 'session;D:\\a & ^ ' + '\u4e2d\x1b\\';
  for (let i = 0; i < frame.length; i++) {
    assert.equal(reader.consume('before' + frame.slice(0, i)) + reader.consume(frame.slice(i) + 'after'), 'beforeafter');
    assert.equal((await reader.read()).cwd, 'D:\\a & ^ \u4e2d');
  }
  const before = await reader.read();
  assert.equal(reader.consume(PREFIX + 'other;C:\\bad\x07'), '');
  assert.deepEqual(await reader.read(), before);
  reader.invalidate();
  assert.equal((await reader.read()).success, false);
  reader.consume(PREFIX + 'session;D:\\\x07');
  assert.ok((await reader.read()).directoryState.revision > before.directoryState.revision);
  reader.consume(PREFIX + 'session;\\\\server\\share\x07');
  assert.equal((await reader.read()).success, false);
});

test('CMD refuses nested or stale prompt reports while checking the original process', async () => {
  let finish;
  const reader = createCmdDirectoryReader('session', null, (_pid, done) => { finish = done; });
  reader.setProcessId(10);
  reader.consume(PREFIX + 'session;C:\\base\x07');
  const nested = reader.read();
  finish({ pid: 10, children: [{ pid: 11 }] });
  assert.equal((await nested).success, false);
  const stale = reader.read();
  reader.invalidate();
  finish({ pid: 10, children: [] });
  assert.equal((await stale).success, false);
});

test('CMD augments the inherited prompt and keeps custom launch arguments intact', () => {
  const shell = 'C:\\Windows\\System32\\cmd.exe';
  const deps = { platform: 'win32' };
  const args = ['/d', '/v:on'];
  const env = { Prompt: 'custom $P$G' };
  const plan = prepareCmdDirectoryIntegration(shell, args, env, deps);
  assert.deepEqual(plan.args, args);
  assert.match(plan.env.Prompt, /^\$E\]633;P;NetcattyCmdDirectory=[a-f0-9]{64};\$P\$E\\custom \$P\$G$/);
  for (const unsupported of [['/c', 'echo hello'], ['/k', 'echo hello'], ['/e:off']]) {
    assert.equal(prepareCmdDirectoryIntegration(shell, unsupported, env, deps), null);
  }
});

test('CMD uses the Windows process query when the optional native module is absent', async () => {
  const pid = 10;
  const check = (error, stdout) => new Promise(resolve => readWindowsProcessTree(pid, resolve, {
    loadNative: () => { throw new Error('optional module unavailable'); },
    execFileFn: (_file, args, options, done) => {
      assert.match(args.at(-1), /ProcessId = 10 OR ParentProcessId = 10/);
      assert.ok(options.windowsHide);
      done(error, stdout);
    },
  }));
  assert.deepEqual(await check(null, 'idle\r\n'), { pid, children: [] });
  assert.equal(await check(null, ''), null);
  assert.equal(await check(new Error('query failed'), 'idle'), null);
});
