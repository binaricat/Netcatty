const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { buildLiveShellProbe, parseLiveShellProbe } = require('./liveShellProbe.cjs');
const { startPtyJob } = require('./ptyExec.cjs');

test('live shell response excludes echoed commands, stale markers and partial lines', () => {
  const marker = '__NCMCP_probe__';
  assert.equal(parseLiveShellProbe(buildLiveShellProbe(marker), marker), null);
  assert.equal(parseLiveShellProbe(`${marker}_P:fi`, marker), null);
  assert.equal(parseLiveShellProbe('__NCMCP_old___P:fish\n', marker), null);
  assert.deepEqual(parseLiveShellProbe(`\r${marker}_P:/usr/bin/fish\r\n${marker}_Q`, marker), { kind: 'fish' });
  assert.deepEqual(parseLiveShellProbe(`${marker}_P:-zsh\n${marker}_Q`, marker), { kind: 'posix' });
  assert.deepEqual(parseLiveShellProbe(`${marker}_P:\n${marker}_Q`, marker), { kind: null });
});

test('probe waits for complete reply before choosing the first wrapper', async () => {
  const pty = new EventEmitter();
  const writes = [];
  pty.write = (data) => writes.push(data);
  const job = startPtyJob(pty, 'printf success', { shellKind: 'posix', probeLiveShell: true, timeoutMs: 1000 });
  assert.equal(writes.length, 1);
  assert.ok(!writes[0].includes('printf success'));
  pty.emit('data', `${job.marker}_P:fi`);
  assert.equal(writes.length, 1);
  pty.emit('data', `sh\r\n${job.marker}_Q`);
  assert.equal(writes.length, 2);
  assert.ok(writes[1].includes('function __ncmcp_int'));
  pty.emit('data', `${job.marker}_S\r\nsuccess\r\n${job.marker}_E:0\r\n`);
  assert.equal((await job.resultPromise).exitCode, 0);
});

test('probe wrapper keeps the start marker separate when terminal echo is disabled', async () => {
  const { spawnSync } = require('node:child_process');
  const pty = new EventEmitter();
  let job;
  let probing = true;
  let pendingInput = '';
  pty.write = (data) => {
    if (data === "\x03") return;
    pendingInput += String(data);
    if (!pendingInput.endsWith('\n') || pendingInput.endsWith('\\\n')) return;
    if (probing) {
      // Wait for the complete probe, including paced chunks and continuations.
      if (!pendingInput.includes("printf '%s'")) return;
      pendingInput = '';
      probing = false;
      queueMicrotask(() => pty.emit('data', `${job.marker}_P:sh\n${job.marker}_Q`));
      return;
    }
    if (!pendingInput.includes(`${job.marker}_E:`)) return;
    const script = pendingInput.replace(/^\x0b\x15/, '');
    pendingInput = '';
    const result = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8' });
    queueMicrotask(() => pty.emit('data', `${job.marker}_QPROMPT> ${result.stdout}`));
  };
  job = startPtyJob(pty, 'printf no-newline-output', { probeLiveShell: true, timeoutMs: 3000 });
  const result = await job.resultPromise;
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.match(result.stdout, /no-newline-output/);
});

test('cancelled probe never injects user command after a late reply', async () => {
  const pty = new EventEmitter();
  const writes = [];
  pty.write = (data) => writes.push(data);
  const job = startPtyJob(pty, 'touch should-not-run', { probeLiveShell: true, timeoutMs: 1000 });
  job.cancel();
  pty.emit('data', `${job.marker}_P:fish\n${job.marker}_Q`);
  pty.emit('close');
  await job.resultPromise;
  assert.ok(writes.every((data) => !data.includes('touch should-not-run')));
});

test('probe deadline delivers the command when the probe reply never arrives', async () => {
  const pty = new EventEmitter();
  const writes = [];
  pty.write = (data) => writes.push(data);
  const aborted = [];
  const job = startPtyJob(pty, 'printf silent-command', {
    shellKind: 'posix', probeLiveShell: true, timeoutMs: 5000, probeDeadlineMs: 80,
    onProbeAborted: (marker) => aborted.push(marker),
  });
  assert.equal(writes.length, 1);
  assert.ok(!writes.join('').includes('printf silent-command'));
  // The paced probe (~1s) plus the probe deadline must pass, then the paced
  // wrapped command is typed even though no probe reply ever came back.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !writes.join('').includes('printf silent-command')) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.ok(writes.join('').includes('printf silent-command'), writes.join('|'));
  // The display reset must NOT be sent when the probe is abandoned: the
  // preload treats _R as a permanent abort for the marker, which would stop
  // the fallback wrapper's _I from re-arming echo suppression. It is
  // deferred to finish() and only sent when the command never starts.
  assert.deepEqual(aborted, []);
  pty.emit('data', `${job.marker}_S\r\nsilent-ok\r\n${job.marker}_E:0\r\n`);
  const result = await job.resultPromise;
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.match(result.stdout, /silent-ok/);
  assert.equal(aborted.length, 0, 'no display reset once the command has started');
});

test('probe deadline fires before the command timers for short timeouts', async () => {
  const pty = new EventEmitter();
  const writes = [];
  pty.write = (data) => writes.push(data);
  const job = startPtyJob(pty, 'printf short-timeout', {
    shellKind: 'posix', probeLiveShell: true, timeoutMs: 2000,
    enforceWallTimeout: true,
  });
  assert.equal(writes.length, 1);
  // With a 2s command timeout (and an active wall clock), the probe deadline
  // must fire strictly before the output/wall timers so the wrapped command
  // is still delivered instead of the job being finished as a timeout.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !writes.join('').includes('printf short-timeout')) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.ok(writes.join('').includes('printf short-timeout'), writes.join('|'));
  assert.ok(!writes.includes('\x03'), 'the output/wall timeout must not interrupt first');
  pty.emit('data', `${job.marker}_S\r\nok\r\n${job.marker}_E:0\r\n`);
  const result = await job.resultPromise;
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.match(result.stdout, /ok/);
});

test('wall timeout does not finish the job before the wrapped command is delivered', async () => {
  const pty = new EventEmitter();
  const writes = [];
  pty.write = (data) => writes.push(data);
  const job = startPtyJob(pty, 'printf one-second-budget', {
    shellKind: 'posix', probeLiveShell: true, timeoutMs: 1000,
    enforceWallTimeout: true,
  });
  assert.equal(writes.length, 1);
  // With a 1s wall budget the paced probe alone takes most of it: the wall
  // timer must be paused during paced delivery and re-armed with the
  // remaining wall time, and the probe recovery must fire against the
  // remaining wall clock, so the wrapped command still gets typed instead of
  // the job being finished as a wall timeout (#3449).
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !writes.join('').includes('printf one-second-budget')) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(writes.join('').includes('printf one-second-budget'), writes.join('|'));
  assert.ok(!writes.includes('\x03'), 'the wall timeout must not interrupt mid-delivery');
  pty.emit('data', `${job.marker}_S\r\nok\r\n${job.marker}_E:0\r\n`);
  const result = await job.resultPromise;
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.match(result.stdout, /ok/);
});

test('wall timeout preserves budget for the command after paced delivery completes', async () => {
  const pty = new EventEmitter();
  const writes = [];
  pty.write = (data) => writes.push(String(data));
  const job = startPtyJob(pty, 'printf post-delivery-budget', {
    shellKind: 'posix', probeLiveShell: true, timeoutMs: 1000,
    enforceWallTimeout: true,
  });
  assert.equal(writes.length, 1);
  // Wait for the silent probe's recovery wrapper to be fully delivered (the
  // paced writes must have stopped before the success arrives, otherwise the
  // paused wall clock hides the re-arm being negative).
  let stable = 0;
  const deadline = Date.now() + 10000;
  while (
    Date.now() < deadline
    && (!writes.join('').includes('printf post-delivery-budget') || stable < 2)
  ) {
    const before = writes.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    stable = writes.length === before ? stable + 1 : 0;
  }
  assert.ok(writes.join('').includes('printf post-delivery-budget'), writes.join('|'));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(!writes.includes('\x03'), 'the wall timeout must not fire right after delivery');
  pty.emit('data', `${job.marker}_S\r\nok\r\n${job.marker}_E:0\r\n`);
  const result = await job.resultPromise;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /ok/);
});

test('wall deadline stays active while paced input waits for drain', async () => {
  const pty = new EventEmitter();
  const writes = [];
  let finished = false;
  // Every write hits backpressure and drains after 300ms: without an active
  // wall deadline the drain waits would accumulate far beyond the 1s budget.
  pty.write = (data) => {
    writes.push(String(data));
    setTimeout(() => {
      if (!finished) pty.emit('drain');
    }, 300);
    return false;
  };
  const job = startPtyJob(pty, 'printf slow-drain-command', {
    shellKind: 'posix', probeLiveShell: true, timeoutMs: 1000,
    enforceWallTimeout: true,
  });
  job.resultPromise.then(() => { finished = true; }, () => { finished = true; });
  const start = Date.now();
  const result = await job.resultPromise;
  const elapsed = Date.now() - start;
  assert.ok(writes.length >= 2, 'the probe must have been paced across drains');
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.error, /timed out/);
  assert.ok(elapsed < 3000, `the wall deadline must bound the drain waits (${elapsed}ms)`);
});

test('late probe reply after the deadline is ignored and never double-delivers', async () => {
  const pty = new EventEmitter();
  const writes = [];
  pty.write = (data) => writes.push(data);
  const job = startPtyJob(pty, 'printf late-ok', {
    shellKind: 'posix', probeLiveShell: true, timeoutMs: 5000, probeDeadlineMs: 60,
  });
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && !writes.join('').includes('printf late-ok')) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.ok(writes.join('').includes('printf late-ok'));
  // Let the paced wrapper delivery finish before snapshotting the writes.
  let stable = writes.length;
  do {
    await new Promise((resolve) => setTimeout(resolve, 100));
    stable = writes.length;
  } while (writes.length !== stable);
  const count = writes.length;
  const delivered = writes.join('').split('printf late-ok').length - 1;
  pty.emit('data', `${job.marker}_P:fish\n${job.marker}_Q`);
  assert.equal(writes.length, count, 'a late reply must not re-trigger the probe');
  pty.emit('data', `${job.marker}_S\r\nlate-ok\r\n${job.marker}_E:0\r\n`);
  const result = await job.resultPromise;
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.match(result.stdout, /late-ok/);
  assert.equal(writes.join('').split('printf late-ok').length - 1, delivered);
  assert.equal(count, writes.length);
});

test('probe deadline abort reset is not duplicated when the command never starts', async () => {
  const pty = new EventEmitter();
  pty.write = () => {};
  const aborted = [];
  const job = startPtyJob(pty, 'echo never-runs', {
    shellKind: 'posix', probeLiveShell: true, timeoutMs: 300, probeDeadlineMs: 50,
    onProbeAborted: (marker) => aborted.push(marker),
  });
  const result = await job.resultPromise;
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(aborted.length, 1, aborted);
});

test('cancelling a probe completes when the idle prompt returns', async () => {
  const pty = new EventEmitter();
  pty.write = () => {};
  const job = startPtyJob(pty, 'should-not-run', {
    probeLiveShell: true, expectedPrompt: 'user@host:~$ ', timeoutMs: 1000,
  });
  job.cancel();
  pty.emit('data', 'user@host:~$ ');
  const result = await job.resultPromise;
  assert.equal(result.error, 'Cancelled');
});

test('real PTY: first execution in startup fish and return to parent shells', {
  skip: process.env.NETCATTY_LIVE_FISH_TEST !== '1', timeout: 30000,
}, async () => {
  const nodePty = require('node-pty');
  const { execViaPty } = require('./ptyExec.cjs');
  for (const [parent, startup] of [['/bin/bash', false], ['/bin/zsh', false], ['/bin/bash', true]]) {
    const fishCommand = "fish --no-config -C 'function fish_prompt; printf FISH_READY\\>\\ ; end'";
    const terminal = nodePty.spawn(parent, startup ? ['-c', `exec ${fishCommand}`] : parent.endsWith('bash') ? ['--noprofile', '--norc'] : ['-f'], {
      name: 'dumb', cols: 240, rows: 24,
      env: { ...process.env, TERM: 'dumb', PS1: 'PARENT_READY> ', BASH_SILENCE_DEPRECATION_WARNING: '1' },
    });
    let output = '';
    terminal.onData((data) => { output += data; });
    const waitFor = async (text) => {
      const deadline = Date.now() + 5000;
      while (!output.includes(text)) {
        if (Date.now() > deadline) throw new Error(`Missing ${text}: ${output.slice(-1500)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      output = '';
    };
    try {
      if (!startup) {
        await waitFor('PARENT_READY>');
        terminal.write('echo earlier-command\r');
        await waitFor('PARENT_READY>');
        terminal.write(`${fishCommand}\r`);
      }
      await waitFor('FISH_READY>');
      const result = await execViaPty(terminal, 'printf first-command-success', {
        loginShellHint: 'posix', probeLiveShell: true, stripMarkers: true, timeoutMs: 3000, enforceWallTimeout: true,
      });
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      assert.match(result.stdout, /first-command-success/);
      if (startup) {
        await waitFor('FISH_READY>');
        terminal.write('set -gx PATH /nonexistent\r');
        await waitFor('FISH_READY>');
        const fallback = await execViaPty(terminal, 'printf fallback-success', {
          shellKind: 'fish', probeLiveShell: true, timeoutMs: 3000,
        });
        assert.equal(fallback.exitCode, 0, JSON.stringify(fallback));
        assert.match(fallback.stdout, /fallback-success/);
        continue;
      }
      await waitFor('FISH_READY>');
      terminal.write('exit\r');
      await waitFor('PARENT_READY>');
      const returned = await execViaPty(terminal, 'printf parent-command-success', {
        loginShellHint: 'fish', probeLiveShell: true, stripMarkers: true, timeoutMs: 3000,
      });
      assert.equal(returned.exitCode, 0, JSON.stringify(returned));
      assert.match(returned.stdout, /parent-command-success/);
    } finally {
      terminal.kill();
    }
  }
});

test('real PTY: echo-disabled bash completes output without a trailing newline', {
  skip: process.env.NETCATTY_LIVE_FISH_TEST !== '1', timeout: 10000,
}, async () => {
  const pty = require('node-pty').spawn('/bin/bash', ['--noprofile', '--norc', '--noediting'], {
    name: 'dumb', cols: 240, rows: 24,
    env: { ...process.env, TERM: 'dumb', PS1: 'NOECHO_READY> ', BASH_SILENCE_DEPRECATION_WARNING: '1' },
  });
  let output = '';
  pty.onData((data) => { output += data; });
  const ready = async () => {
    const deadline = Date.now() + 3000;
    while (!output.includes('NOECHO_READY>')) {
      if (Date.now() > deadline) throw new Error('No echo-disabled shell prompt');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    output = '';
  };
  try {
    await ready();
    pty.write('stty -echo\n');
    await ready();
    const result = await require('./ptyExec.cjs').execViaPty(pty, 'printf noecho-success', {
      shellKind: 'posix', probeLiveShell: true, timeoutMs: 2000,
    });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.match(result.stdout, /noecho-success/);
    assert.ok(!output.includes('command sh -c'), 'the terminal must actually suppress input echo');
  } finally {
    pty.kill();
  }
});

for (const editing of [true, false]) {
  test(`real PTY: pending input clearing leaves no control command (editing=${editing})`, {
    skip: process.env.NETCATTY_LIVE_FISH_TEST !== '1', timeout: 5000,
  }, async () => {
    const pty = require('node-pty').spawn('/bin/bash', ['--noprofile', '--norc', ...(editing ? [] : ['--noediting'])], {
      name: 'dumb', cols: 240, rows: 24,
      env: { ...process.env, TERM: 'dumb', PS1: 'CLEAR_READY> ', HISTFILE: '/dev/null', BASH_SILENCE_DEPRECATION_WARNING: '1' },
    });
    let output = '';
    pty.onData(data => { output += data; });
    try {
      const waitForPrompt = async () => {
        const deadline = Date.now() + 3000;
        while (!output.includes('CLEAR_READY>')) {
          if (Date.now() > deadline) throw new Error(`Missing prompt: ${output}`);
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      };
      await waitForPrompt();
      output = '';
      // Leave text on both sides of the readline cursor. Without editing, all
      // bytes remain pending canonical input and must still be discarded.
      pty.write('left-right\x1b[5D');
      await new Promise(resolve => setTimeout(resolve, 50));
      const { buildPendingInputClearPrefix } = require('./ptyExecHelpers.cjs');
      pty.write(buildPendingInputClearPrefix('posix') + "printf 'CLEAR_SUCCESS\\n'\n");
      await waitForPrompt();
      assert.match(output, /CLEAR_SUCCESS\r\n/);
      assert.doesNotMatch(output, /command not found|syntax error/);
    } finally {
      pty.kill();
    }
  });
}

test('real PTY: canonical bash executes a long literal command without truncation', {
  skip: process.env.NETCATTY_LIVE_FISH_TEST !== '1', timeout: 15000,
}, async () => {
  const pty = require('node-pty').spawn('/bin/bash', ['--noprofile', '--norc', '--noediting'], {
    name: 'dumb', cols: 240, rows: 24,
    env: { ...process.env, TERM: 'dumb', PS1: 'CANONICAL_READY> ', HISTFILE: '/dev/null', BASH_SILENCE_DEPRECATION_WARNING: '1' },
  });
  let output = '';
  pty.onData((data) => { output += data; });
  try {
    const deadline = Date.now() + 3000;
    while (!output.includes('CANONICAL_READY>')) {
      if (Date.now() > deadline) throw new Error('Missing canonical shell prompt');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const literal = 'x'.repeat(12000);
    const result = await require('./ptyExec.cjs').execViaPty(pty, `printf '%s' '${literal}'`, {
      shellKind: 'posix', probeLiveShell: true, timeoutMs: 1500,
    });
    assert.equal(result.exitCode, 0, JSON.stringify({ ...result, stdout: result.stdout?.slice(-200) }));
    assert.equal(result.stdout.trim(), literal);
  } finally {
    pty.kill();
  }
});

// The second element is a history-listing invocation that still reaches the
// real history builtin under that customization.
for (const [customization, listHistory] of [
  [':', 'command builtin history'],
  ['HISTCONTROL=ignorespace', 'command builtin history'],
  ["alias history='history 10'", 'command builtin history'],
  ['history() { :; }', 'command builtin history'],
  ['history() { builtin history "$@" | cat; }', 'command builtin history'],
  ["alias eval=':'", 'command builtin history'],
  ['eval() { :; }', 'command builtin history'],
  ['PATH=/nonexistent', 'command builtin history'],
  ["alias builtin=':'", 'command builtin history'],
  ['builtin() { :; }', 'command builtin history'],
  ["alias command=':'", '\\builtin history'],
  ['command() { :; }', '\\builtin history'],
]) {
  for (const executeCommand of [false, true]) {
    test(`bash probe keeps user history clean (${customization}, wrapper=${executeCommand})`, () => {
      const { spawnSync } = require('node:child_process');
      const { buildWrappedCommand } = require('./ptyExecHelpers.cjs');
      const marker = '__NCMCP_HISTORY_PROBE__';
      const input = `HISTFILE=/dev/null; HISTCONTROL=; PS1=; PS2=\n${customization}\n${listHistory} -c\necho user_one\necho user_two\n`
        + buildLiveShellProbe(marker)
        + (executeCommand ? buildWrappedCommand('echo command_ok', 'posix', marker, true) : '')
        + '\nprintf \"\\n\"\n' + listHistory + '\nexit\n';
      const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-i'], {
        input, encoding: 'utf8', env: { ...process.env, TERM: 'dumb' }, timeout: 5000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(`${marker}_Q`), result.stdout);
      const entries = result.stdout.split('\n').filter(line => /^\s*\d+\s/.test(line));
      assert.ok(entries.some(line => line.includes('echo user_one')), entries.join('\n'));
      assert.ok(entries.some(line => line.includes('echo user_two')), entries.join('\n'));
      assert.ok(entries.every(line => !line.includes(marker)), entries.join('\n'));
    });
  }
}

test('real PTY: probe and execution leave only user commands for arrow recall', {
  skip: process.env.NETCATTY_LIVE_FISH_TEST !== '1', timeout: 10000,
}, async () => {
  const terminal = require('node-pty').spawn('/bin/bash', ['--noprofile', '--norc'], {
    name: 'dumb', cols: 240, rows: 24,
    env: { ...process.env, TERM: 'dumb', HISTFILE: '/dev/null', HISTCONTROL: '',
      PS1: 'HISTORY_READY> ', BASH_SILENCE_DEPRECATION_WARNING: '1' },
  });
  let output = '';
  terminal.onData(data => { output += data; });
  const waitFor = async text => {
    const deadline = Date.now() + 3000;
    while (!output.includes(text)) {
      if (Date.now() > deadline) throw new Error(`Missing ${text}: ${output.slice(-1500)}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const result = output;
    output = '';
    return result;
  };
  try {
    await waitFor('HISTORY_READY>');
    terminal.write('builtin history -c\r');
    await waitFor('HISTORY_READY>');
    terminal.write('echo user_history_one\r');
    await waitFor('HISTORY_READY>');
    terminal.write('echo user_history_two\r');
    await waitFor('HISTORY_READY>');
    const result = await require('./ptyExec.cjs').execViaPty(terminal, 'printf agent_success', {
      shellKind: 'posix', probeLiveShell: true, timeoutMs: 2000,
    });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.match(result.stdout, /agent_success/);
    await waitFor('HISTORY_READY>');
    terminal.write('\x1b[A\r');
    const recalled = await waitFor('HISTORY_READY>');
    assert.match(recalled, /user_history_two/);
    assert.doesNotMatch(recalled, /__NCMCP_/);
    terminal.write('builtin history\r');
    const history = await waitFor('HISTORY_READY>');
    assert.match(history, /echo user_history_one/);
    assert.match(history, /echo user_history_two/);
    assert.doesNotMatch(history, /__NCMCP_/);
  } finally {
    terminal.kill();
  }
});

for (const invocationName of ['sh', 'renamed-bash']) {
  test(`Bash invoked as ${invocationName} cleans probe history`, () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const { spawnSync } = require('node:child_process');
    const directory = require('../tempDirBridge.cjs').getTempFilePath('probe-bash');
    fs.mkdirSync(directory, { mode: 0o700 });
    try {
      const shell = path.join(directory, invocationName);
      fs.symlinkSync('/bin/bash', shell);
      const marker = '__NCMCP_RENAMED_BASH__';
      const result = spawnSync(shell, ['--noprofile', '--norc', '-i'], {
        input: 'HISTFILE=/dev/null; HISTCONTROL=; PS1=; PS2=\nbuiltin history -c\necho preserve_user_history\n'
          + buildLiveShellProbe(marker) + '\nprintf "\\n"\ncommand builtin history\nexit\n',
        encoding: 'utf8', env: { ...process.env, TERM: 'dumb' }, timeout: 5000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(`${marker}_Q`), result.stdout);
      const entries = result.stdout.split('\n').filter(line => /^\s*\d+\s/.test(line));
      assert.ok(entries.some(line => line.includes('echo preserve_user_history')), result.stdout);
      assert.ok(entries.every(line => !line.includes(marker)), result.stdout);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

for (const [shell, args] of [
  ['/bin/dash', ['-i']],
  ['/bin/zsh', ['-f', '-i']],
  ['/bin/bash', ['--noprofile', '--norc', '-i']],
]) {
  test(`probe preserves an interactive errexit session in ${shell}`, (t) => {
    const { spawnSync } = require('node:child_process');
    const marker = '__NCMCP_ERREXIT_PROBE__';
    const result = spawnSync(shell, args, {
      input: 'set -e\n' + buildLiveShellProbe(marker) + '\necho shell_survived\nexit\n',
      encoding: 'utf8', env: { ...process.env, TERM: 'dumb', HISTFILE: '/dev/null' }, timeout: 5000,
    });
    if (result.error?.code === 'ENOENT') return t.skip(`${shell} is unavailable`);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`${marker}_Q`), result.stdout);
    assert.ok(result.stdout.includes('shell_survived'), result.stdout);
  });
}

for (const shell of ['/bin/dash', '/bin/zsh']) {
  test(`history cleanup keeps the execution wrapper portable in ${shell}`, { skip: !require('node:fs').existsSync(shell) }, () => {
    const { spawnSync } = require('node:child_process');
    const { buildWrappedCommand } = require('./ptyExecHelpers.cjs');
    const marker = '__NCMCP_PORTABLE_HISTORY__';
    const result = spawnSync(shell, ['-c', buildWrappedCommand('echo portable-history-ok', 'posix', marker, true)], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /portable-history-ok/);
    assert.ok(result.stdout.includes(`${marker}_E:0`));
  });
}

for (const historyControl of ['', 'ignorespace']) {
  test(`successful cleanup does not invoke a shadowed builtin (${historyControl || 'default'})`, () => {
    const { spawnSync } = require('node:child_process');
    const { buildWrappedCommand } = require('./ptyExecHelpers.cjs');
    const marker = '__NCMCP_FALLBACK_GUARD__';
    const input = `HISTFILE=/dev/null; HISTCONTROL=${historyControl}; PS1=; PS2=\nbuiltin() { printf UNEXPECTED_FALLBACK; }\ncommand history -c\necho user_one\n`
      + buildLiveShellProbe(marker)
      + buildWrappedCommand('echo command_ok', 'posix', marker, true)
      + '\ncommand history\nexit\n';
    const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-i'], {
      input, encoding: 'utf8', env: { ...process.env, TERM: 'dumb' }, timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(`${marker}_Q`), result.stdout);
    assert.match(result.stdout, /command_ok/);
    assert.doesNotMatch(result.stdout, /UNEXPECTED_FALLBACK/);
    const entries = result.stdout.split('\n').filter(line => /^\s*\d+\s/.test(line));
    assert.ok(entries.some(line => line.includes('echo user_one')), entries.join('\n'));
    assert.ok(entries.every(line => !line.includes(marker)), entries.join('\n'));
  });
}

for (const stop of ['cancel', 'timeout']) {
  test(`paced probe stops writing after ${stop}`, async () => {
    const pty = new EventEmitter();
    const writes = [];
    pty.write = data => writes.push(data);
    const job = startPtyJob(pty, 'echo must_not_run', {
      shellKind: 'posix', probeLiveShell: true, timeoutMs: stop === 'timeout' ? 70 : 1000,
      enforceWallTimeout: stop === 'timeout',
    });
    await new Promise(resolve => setTimeout(resolve, 45));
    assert.ok(writes.length >= 2, 'probe must have started a later chunk');
    if (stop === 'cancel') {
      job.cancel();
      pty.emit('close');
    }
    await job.resultPromise;
    const count = writes.length;
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(writes.length, count);
    assert.ok(writes.every(data => !data.includes('must_not_run')));
  });
}
