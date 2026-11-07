const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PREFIX, MAX_REPORT, createDirectoryReportReader, canIntegratePowerShell, preparePowerShellDirectoryIntegration } = require('./powerShellDirectoryIntegration.cjs');
const tempDirBridge = require('./tempDirBridge.cjs');
const { readLocalSessionCwd } = require('./localSessionCwd.cjs');

const report = (changes = {}, end = '\x07') => PREFIX + Buffer.from(JSON.stringify({
  version: 1, nonce: 'session-secret', pid: 123, sequence: 1,
  provider: 'FileSystem', cwd: 'C:\\base', home: 'C:\\Users\\me', ...changes,
})).toString('base64') + end;
const reader = () => { const value = createDirectoryReportReader('session-secret'); value.setProcessId(123); return value; };

test('report parser handles every chunk boundary, BEL/ST, and UTF-8 without leaking protocol', () => {
  for (const end of ['\x07', '\x1b\\']) {
    const source = report({ cwd: 'D:\\中文' }, end);
    for (let split = 0; split <= source.length; split++) {
      const value = reader();
      const output = value.consume('before' + source.slice(0, split)) + value.consume(source.slice(split) + 'after');
      assert.equal(output, 'beforeafter', String(split));
      assert.equal(value.read().cwd, 'D:\\中文');
    }
  }
  const value = reader();
  assert.equal(value.consume('\x1b]7;file://localhost/tmp\x07normal\x1b[32m'), '\x1b]7;file://localhost/tmp\x07normal\x1b[32m');
});

test('session nonce, shell PID, version, size and monotonic sequence constrain reports', () => {
  const value = reader();
  for (const change of [{ nonce: 'other' }, { pid: 124 }, { version: 2 }, { sequence: 0 }, { cwd: '/home/me' }]) {
    assert.equal(value.consume(report(change)), '');
    assert.equal(value.read().success, false);
  }
  value.consume(report());
  assert.equal(value.read().directoryState.revision, 1);
  value.invalidate();
  value.consume(report());
  assert.equal(value.read().success, false, 'replaying the pre-input prompt cannot confirm a cd');
  value.consume(report({ sequence: 2, cwd: 'D:\\next' }));
  assert.equal(value.read().cwd, 'D:\\next');
  assert.equal(value.read().directoryState.revision, 2);
  assert.equal(value.consume(PREFIX + 'x'.repeat(MAX_REPORT + 1)), '');
  assert.equal(value.consume('unbounded payload\x1b'), '');
  assert.equal(value.consume('\\tail' + report({ sequence: 3 })), 'tail');
  assert.equal(value.read().directoryState.revision, 3);
});

test('non-filesystem providers clear the filesystem location and Windows local cwd uses only the report', async () => {
  const value = reader();
  value.consume(report());
  assert.equal((await readLocalSessionCwd({ directoryIntegration: value }, { platform: 'win32' })).cwd, 'C:\\base');
  value.consume(report({ sequence: 2, provider: 'Registry', cwd: 'HKLM:\\Software' }));
  const state = value.read();
  assert.equal(state.success, false);
  assert.equal(state.cwd, undefined);
  assert.equal(state.directoryState.cwd, null);
  assert.equal(state.directoryState.provider, 'Registry');
});

test('only known native shell names and ordinary interactive arguments are rewritten', () => {
  for (const shell of ['powershell.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe']) {
    assert.equal(canIntegratePowerShell(shell, ['-NoLogo', '-NoProfile'], 'win32'), true);
    for (const args of [['-Command', 'echo hi'], ['-File', 'test.ps1'], ['-ExecutionPolicy', 'Bypass'], ['-NonInteractive'], ['-nop'], ['-NoLogo', 'extra']]) {
      assert.equal(canIntegratePowerShell(shell, args, 'win32'), false);
    }
  }
  for (const shell of ['wsl.exe', 'bash.exe', 'cmd.exe', 'wrapper.cmd']) assert.equal(canIntegratePowerShell(shell, [], 'win32'), false);
  assert.equal(canIntegratePowerShell('/usr/bin/pwsh', [], 'linux'), false);
});

test('startup copies a real script to managed temp and preserves profiles, policy and original args', t => {
  tempDirBridge.ensureTempDir();
  const dir = fs.mkdtempSync(tempDirBridge.getTempFilePath('directory-integration-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const args = ['-NoLogo', '-NoProfile'];
  const plan = preparePowerShellDirectoryIntegration('pwsh.exe', args, {
    platform: 'win32', getTempFilePath: name => path.join(dir, name),
  });
  assert.ok(plan);
  assert.deepEqual(args, ['-NoLogo', '-NoProfile']);
  assert.deepEqual(plan.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NoExit', '-Command']);
  assert.equal(plan.args.some(arg => /ExecutionPolicy|Bypass/i.test(arg)), false);
  const file = path.join(dir, fs.readdirSync(dir)[0]);
  assert.ok(fs.readFileSync(file, 'utf8').startsWith('\ufeff'));
  assert.ok(plan.args.at(-1).includes(file.replace(/'/g, "''")));
  plan.cleanup(); plan.cleanup();
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal(preparePowerShellDirectoryIntegration('pwsh', [], {
    platform: 'win32', getTempFilePath: () => path.join(dir, 'missing', 'script.ps1'),
  }), null);
  assert.equal(preparePowerShellDirectoryIntegration('pwsh', [], {
    platform: 'win32', getTempFilePath: () => { throw new Error('managed temporary directory is unavailable'); },
  }), null);
});
