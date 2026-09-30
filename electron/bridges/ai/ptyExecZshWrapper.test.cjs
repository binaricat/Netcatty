const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const {
  buildWrappedCommand,
  posixFlavorForSession,
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

test('zsh and unknown flavors type a single-line live probe; bash keeps the Bash cleanup', () => {
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
  // Versioned zsh basenames stay POSIX-kind, mirroring
  // posixFlavorFromShellPath(): a fish login-shell hint must not survive
  // refinement or fish syntax would be typed into versioned zsh.
  assert.deepEqual(
    parseLiveShellProbe(`${marker}_P:zsh-5.9\n${marker}_Q`, marker),
    { kind: 'posix', shellName: 'zsh-5.9' },
  );
  // Unknown flavors are zsh-safe too: the first unknown-flavor job must not
  // type the multiline Bash cleanup probe into a possibly-zsh line editor.
  const unknownProbe = buildLiveShellProbe(marker);
  assert.ok(!unknownProbe.includes('\\\n'), unknownProbe);
  assert.ok(!unknownProbe.includes('__nc_h_'));
  assert.ok(unknownProbe.endsWith(`${marker}_Q'\n`), unknownProbe.slice(-80));
  // A live-probe-reported bash restores the multiline form with its cleanup.
  const bashProbe = buildLiveShellProbe(marker, 'bash');
  assert.ok(bashProbe.includes('\\\n'));
  assert.ok(bashProbe.includes('__nc_h_'));
});

test('posixFlavorFromShellPath detects zsh executables only', () => {
  const { posixFlavorFromShellPath } = require('./ptyExecHelpers.cjs');
  assert.equal(posixFlavorFromShellPath('/bin/zsh'), 'zsh');
  assert.equal(posixFlavorFromShellPath('/opt/homebrew/bin/zsh'), 'zsh');
  assert.equal(posixFlavorFromShellPath('/usr/local/bin/zsh-5.9'), 'zsh');
  assert.equal(posixFlavorFromShellPath('/bin/bash'), '');
  assert.equal(posixFlavorFromShellPath('/usr/bin/fish'), '');
  assert.equal(posixFlavorFromShellPath('remote-shell'), '');
  assert.equal(posixFlavorFromShellPath(''), '');
  assert.equal(posixFlavorFromShellPath(undefined), '');
});

test('posixFlavorForSession uses the configured path, then the probed login-shell path', () => {
  assert.equal(posixFlavorForSession({ shellExecutable: '/usr/local/bin/zsh-5.9' }), 'zsh');
  // Remote sessions: no configured executable path, the probed login shell
  // makes the initially typed live probe zsh-safe before refinement.
  assert.equal(posixFlavorForSession({ shellExecutable: 'remote-shell', _loginShellPath: '/usr/bin/zsh' }), 'zsh');
  assert.equal(posixFlavorForSession({ shellExecutable: 'remote-shell', _loginShellPath: '/bin/zsh-5.9' }), 'zsh');
  // A zsh login must stay a probe-form hint only: unknown/non-zsh paths and
  // missing hints keep the generic multiline form.
  assert.equal(posixFlavorForSession({ shellExecutable: 'remote-shell', _loginShellPath: '/bin/bash' }), '');
  assert.equal(posixFlavorForSession({ shellExecutable: 'remote-shell', _loginShellPath: '/usr/bin/fish' }), '');
  assert.equal(posixFlavorForSession({ shellExecutable: 'remote-shell' }), '');
  assert.equal(posixFlavorForSession({ shellExecutable: '/bin/bash', _loginShellPath: '/bin/bash' }), '');
  assert.equal(posixFlavorForSession(undefined), '');
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

test('a refined remote zsh flavor keeps the single-line probe for later jobs', async () => {
  const pty = new EventEmitter();
  const writes = [];
  pty.write = (data) => writes.push(data);
  const first = startPtyJob(pty, 'printf success', {
    shellKind: 'posix', probeLiveShell: true, timeoutMs: 1000,
  });
  await sleep(400);
  // First job types the zsh-safe single-line probe: the flavor is unknown and
  // the multiline Bash cleanup probe could wedge a zsh line editor.
  assert.ok(!writes.join('').includes('\\\n'), writes.join(''));
  pty.emit('data', `${first.marker}_P:zsh-5.9\n${first.marker}_Q`);
  await sleep(400);
  pty.emit('data', `${first.marker}_S\r\nsuccess\r\n${first.marker}_E:0\r\n`);
  await first.resultPromise;
  writes.length = 0;

  const second = startPtyJob(pty, 'printf success', {
    shellKind: 'posix', probeLiveShell: true, timeoutMs: 1000,
  });
  await sleep(600);
  // The remembered flavor already avoids the wedge-prone multiline probe.
  const typedProbe = writes.join('');
  assert.ok(!typedProbe.includes('\\\n'), typedProbe);
  pty.emit('data', `${second.marker}_P:zsh-5.9\n${second.marker}_Q`);
  await sleep(400);
  const typedWrapper = writes.join('');
  assert.ok(!typedWrapper.includes('\\\n'), typedWrapper);
  assert.ok(!typedWrapper.includes('__nc_h_'));
  pty.emit('data', `${second.marker}_S\r\nsuccess\r\n${second.marker}_E:0\r\n`);
  const result = await second.resultPromise;
  assert.equal(result.exitCode, 0);
});

test('a refined remote bash flavor is not reused; later jobs stay on the zsh-safe single-line probe', async () => {
  const pty = new EventEmitter();
  const writes = [];
  pty.write = (data) => writes.push(data);
  const first = startPtyJob(pty, 'printf success', {
    shellKind: 'posix', probeLiveShell: true, timeoutMs: 1000,
  });
  pty.emit('data', `${first.marker}_P:bash\n${first.marker}_Q`);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !writes.join('').includes(`${first.marker}_E:`)) {
    await sleep(100);
  }
  pty.emit('data', `${first.marker}_S\r\nsuccess\r\n${first.marker}_E:0\r\n`);
  await first.resultPromise;
  writes.length = 0;

  const second = startPtyJob(pty, 'printf success', {
    shellKind: 'posix', probeLiveShell: true, timeoutMs: 1000,
  });
  await sleep(600);
  // A remembered bash flavor must not treat the previous bash report as
  // authoritative for the next command: the user could switch this stream to
  // zsh, and the multiline Bash cleanup probe would wedge a busy zsh line
  // editor before live detection observes the switch. The next job restarts
  // on the zsh-safe single-line probe.
  const typedProbe = writes.join('');
  assert.ok(!typedProbe.includes('\\\n'), typedProbe);
  assert.ok(!typedProbe.includes('__nc_h_'), typedProbe);
  pty.emit('data', `${second.marker}_P:bash\n${second.marker}_Q`);
  const secondDeadline = Date.now() + 3000;
  while (Date.now() < secondDeadline && !writes.join('').includes(`${second.marker}_E:`)) {
    await sleep(100);
  }
  pty.emit('data', `${second.marker}_S\r\nsuccess\r\n${second.marker}_E:0\r\n`);
  await second.resultPromise;
});

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
