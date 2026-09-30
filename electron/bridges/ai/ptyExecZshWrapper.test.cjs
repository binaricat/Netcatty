const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const {
  buildWrappedCommand,
  posixFlavorFromShellPath,
} = require('./ptyExecHelpers.cjs');
const { buildLiveShellProbe, parseLiveShellProbe } = require('./liveShellProbe.cjs');
const { startPtyJob } = require('./ptyExec.cjs');

test('zsh-flavored posix wrapper is a single physical line without Bash-only cleanup', () => {
  const marker = '__NCMCP_test__';
  const wrapped = buildWrappedCommand('echo zsh_ok', 'posix', marker, true, { posixFlavor: 'zsh' });
  const physicalLines = wrapped.split('\n');
  // One empty final line from the trailing newline, everything else is a
  // complete line: no backslash-newline continuations typed into the editor.
  assert.deepEqual(physicalLines.slice(-1), ['']);
  for (const line of physicalLines) {
    assert.ok(!line.endsWith('\\'), JSON.stringify(line));
  }
  assert.ok(wrapped.includes(`${marker}_I`));
  assert.ok(wrapped.includes(`${marker}_S`));
  assert.ok(wrapped.includes(`${marker}_E:`));
  assert.ok(wrapped.includes('zsh_ok'));
  // The Bash-only history cleanup (for/do/done fragments) is a runtime no-op
  // in zsh and must not appear in the typed payload.
  assert.ok(!wrapped.includes('__nc_h_'));
  assert.ok(!wrapped.includes('done'));
  // Multiline user commands stay inside one command substitution.
  const multiline = buildWrappedCommand("echo one\necho two", 'posix', marker, true, { posixFlavor: 'zsh' });
  assert.ok(multiline.includes(`$(printf '%s\\n' 'echo one' 'echo two')`), multiline);
});

test('generic POSIX wrappers keep the multiline Bash cleanup', () => {
  const marker = '__NCMCP_test__';
  const wrapped = buildWrappedCommand('echo bash_ok', 'posix', marker, true);
  assert.ok(wrapped.includes('\\\n'));
  assert.ok(wrapped.includes('__nc_h_'));
  assert.ok(wrapped.includes('done'));
});

test('zsh-flavored live probe is a single physical line and keeps Bash cleanup for other shells', () => {
  const marker = '__NCMCP_probe__';
  const zshProbe = buildLiveShellProbe(marker, 'zsh');
  const zshLines = zshProbe.split('\n');
  assert.equal(zshLines.length, 3);
  assert.ok(!zshLines[0].includes('_P:'));
  assert.ok(zshProbe.includes(`${marker}_P:`));
  assert.ok(zshProbe.endsWith(`${marker}_Q'\n`), JSON.stringify(zshProbe.slice(-80)));
  assert.ok(!zshProbe.includes('__nc_h_'));
  for (const line of zshLines) {
    assert.ok(!line.endsWith('\\'), JSON.stringify(line));
  }
  // The zsh probe still reports the live shell for wrapper flavor selection.
  assert.deepEqual(
    parseLiveShellProbe(`${marker}_P:-zsh\n${marker}_Q`, marker),
    { kind: 'posix', shellName: 'zsh' },
  );
  const genericProbe = buildLiveShellProbe(marker);
  assert.ok(genericProbe.includes('\\\n'));
  assert.ok(genericProbe.includes('__nc_h_'));
});

test('posixFlavorFromShellPath detects zsh executables only', () => {
  assert.equal(posixFlavorFromShellPath('/bin/zsh'), 'zsh');
  assert.equal(posixFlavorFromShellPath('/opt/homebrew/bin/zsh'), 'zsh');
  assert.equal(posixFlavorFromShellPath('/usr/local/bin/zsh-5.9'), 'zsh');
  assert.equal(posixFlavorFromShellPath('/bin/bash'), '');
  assert.equal(posixFlavorFromShellPath('/usr/bin/fish'), '');
  assert.equal(posixFlavorFromShellPath('remote-shell'), '');
  assert.equal(posixFlavorFromShellPath(''), '');
  assert.equal(posixFlavorFromShellPath(undefined), '');
});

// writeInput paces payloads over 1024 chars in 128-char/30ms chunks; drain
// those timers so the assertions see the complete typed payload.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('zsh flavor selects the single-line wrapper after a live shell probe', async () => {
  const pty = new EventEmitter();
  const writes = [];
  pty.write = (data) => writes.push(data);
  const job = startPtyJob(pty, 'printf success', {
    shellKind: 'posix', probeLiveShell: true, posixFlavor: 'zsh', timeoutMs: 1000,
  });
  const typedProbe = writes.join('');
  assert.ok(!typedProbe.includes('\\\n'), typedProbe);
  pty.emit('data', `${job.marker}_P:zsh\n${job.marker}_Q`);
  await sleep(400);
  const typedWrapper = writes.join('');
  assert.ok(!typedWrapper.includes('\\\n'), typedWrapper);
  assert.ok(!typedWrapper.includes('__nc_h_'));
  pty.emit('data', `${job.marker}_S\r\nsuccess\r\n${job.marker}_E:0\r\n`);
  const result = await job.resultPromise;
  assert.equal(result.exitCode, 0);
});

test('versioned zsh basename from the live probe keeps the zsh flavor', async () => {
  const pty = new EventEmitter();
  const writes = [];
  pty.write = (data) => writes.push(data);
  const job = startPtyJob(pty, 'printf success', {
    shellKind: 'posix', probeLiveShell: true, posixFlavor: 'zsh', timeoutMs: 1000,
  });
  pty.emit('data', `${job.marker}_P:zsh-5.9\n${job.marker}_Q`);
  await sleep(400);
  const typedWrapper = writes.join('');
  assert.ok(!typedWrapper.includes('\\\n'), typedWrapper);
  assert.ok(!typedWrapper.includes('__nc_h_'));
  pty.emit('data', `${job.marker}_S\r\nsuccess\r\n${job.marker}_E:0\r\n`);
  const result = await job.resultPromise;
  assert.equal(result.exitCode, 0);
});

test('a zsh-configured session that switched to bash falls back to the multiline wrapper', async () => {
  const pty = new EventEmitter();
  const writes = [];
  pty.write = (data) => writes.push(data);
  const job = startPtyJob(pty, 'printf success', {
    shellKind: 'posix', probeLiveShell: true, posixFlavor: 'zsh', timeoutMs: 1000,
  });
  pty.emit('data', `${job.marker}_P:bash\n${job.marker}_Q`);
  // Drain the paced 128-char typing chunks of the long multiline wrapper.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !writes.join('').includes(`${job.marker}_E:`)) {
    await sleep(100);
  }
  const typedWrapper = writes.join('');
  assert.ok(typedWrapper.includes('\\\n'), typedWrapper);
  assert.ok(typedWrapper.includes('__nc_h_'));
  pty.emit('data', `${job.marker}_S\r\nsuccess\r\n${job.marker}_E:0\r\n`);
  const result = await job.resultPromise;
  assert.equal(result.exitCode, 0);
});

for (const probeName of ['-zsh', 'zsh-5.9']) {
  test(`live probe refines the flavor to zsh for remote sessions without a path hint (${probeName})`, async () => {
    const pty = new EventEmitter();
    const writes = [];
    pty.write = (data) => writes.push(data);
    const job = startPtyJob(pty, 'printf success', {
      shellKind: 'posix', probeLiveShell: true, timeoutMs: 1000,
    });
    pty.emit('data', `${job.marker}_P:${probeName}\n${job.marker}_Q`);
    await sleep(400);
    const typedWrapper = writes.join('');
    assert.ok(!typedWrapper.includes('\\\n'), typedWrapper);
    assert.ok(!typedWrapper.includes('__nc_h_'));
    pty.emit('data', `${job.marker}_S\r\nsuccess\r\n${job.marker}_E:0\r\n`);
    const result = await job.resultPromise;
    assert.equal(result.exitCode, 0);
  });
}

const marker = '__NCMCP_zshline_ccbc892e865a115a80c88afdc77b96a6__';

for (const extraRc of ['', 'HISTFILE=/dev/null; HISTSIZE=100; setopt HIST_IGNORE_SPACE\n']) {
  test(`interactive zsh executes the single-line probe + wrapper (rc="${extraRc ? 'history' : 'plain'}")`, (t) => {
    const input = `${extraRc}echo user_before\n`
      + buildLiveShellProbe(marker, 'zsh')
      + buildWrappedCommand('echo single_line_ok', 'posix', marker, true, { posixFlavor: 'zsh' })
      + '\necho user_after\nfc -l 1\nexit\n';
    const result = spawnSync('zsh', ['-f', '-i'], {
      input, encoding: 'utf8', env: { ...process.env, TERM: 'dumb' }, timeout: 10000,
    });
    if (result.error?.code === 'ENOENT') {
      t.skip('zsh is not installed');
      return;
    }
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /single_line_ok/);
    assert.ok(!result.stderr.includes('parse error'), result.stderr);
  });
}
