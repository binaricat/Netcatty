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
  pty.write = (data) => {
    if (String(data).includes('command sh -c')) return;
    if (data === '\x03') return;
    const script = String(data).replace(/^\x15\x0b/, '');
    const result = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8' });
    queueMicrotask(() => pty.emit('data', `${job.marker}_QPROMPT> ${result.stdout}`));
  };
  job = startPtyJob(pty, 'printf no-newline-output', { probeLiveShell: true, timeoutMs: 1000 });
  pty.emit('data', `${job.marker}_P:sh\n${job.marker}_Q`);
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

for (const customization of [':', 'HISTCONTROL=ignorespace', "alias history='history 10'", 'history() { :; }', "alias eval=':'", 'eval() { :; }', 'PATH=/nonexistent']) {
  for (const executeCommand of [false, true]) {
    test(`bash probe keeps user history clean (${customization}, wrapper=${executeCommand})`, () => {
      const { spawnSync } = require('node:child_process');
      const { buildWrappedCommand } = require('./ptyExecHelpers.cjs');
      const marker = '__NCMCP_HISTORY_PROBE__';
      const input = `HISTFILE=/dev/null; HISTCONTROL=; PS1=; PS2=\n${customization}\nbuiltin history -c\necho user_one\necho user_two\n`
        + buildLiveShellProbe(marker)
        + (executeCommand ? buildWrappedCommand('echo command_ok', 'posix', marker, true) : '')
        + '\nprintf \"\\n\"\nbuiltin history\nexit\n';
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
    const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'netcatty-probe-bash-'));
    try {
      const shell = path.join(directory, invocationName);
      fs.symlinkSync('/bin/bash', shell);
      const marker = '__NCMCP_RENAMED_BASH__';
      const result = spawnSync(shell, ['--noprofile', '--norc', '-i'], {
        input: 'HISTFILE=/dev/null; HISTCONTROL=; PS1=; PS2=\nbuiltin history -c\necho preserve_user_history\n'
          + buildLiveShellProbe(marker) + '\nprintf "\\n"\nbuiltin history\nexit\n',
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
