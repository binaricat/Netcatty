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
  assert.deepEqual(parseLiveShellProbe(`\r${marker}_P:/usr/bin/fish\r\n`, marker), { kind: 'fish' });
  assert.deepEqual(parseLiveShellProbe(`${marker}_P:-zsh\n`, marker), { kind: 'posix' });
  assert.deepEqual(parseLiveShellProbe(`${marker}_P:\n`, marker), { kind: null });
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
  pty.emit('data', 'sh\r\n');
  assert.equal(writes.length, 2);
  assert.ok(writes[1].includes('function __ncmcp_int'));
  pty.emit('data', `${job.marker}_S\r\nsuccess\r\n${job.marker}_E:0\r\n`);
  assert.equal((await job.resultPromise).exitCode, 0);
});

test('cancelled probe never injects user command after a late reply', async () => {
  const pty = new EventEmitter();
  const writes = [];
  pty.write = (data) => writes.push(data);
  const job = startPtyJob(pty, 'touch should-not-run', { probeLiveShell: true, timeoutMs: 1000 });
  job.cancel();
  pty.emit('data', `${job.marker}_P:fish\n`);
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
      if (startup) continue;
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
