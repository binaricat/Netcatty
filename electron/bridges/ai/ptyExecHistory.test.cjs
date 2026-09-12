const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { buildWrappedCommand } = require('./ptyExecHelpers.cjs');
const { buildLiveShellProbe } = require('./liveShellProbe.cjs');

const marker = '__NCMCP_mttikd5b_ccbc892e865a115a80c88afdc77b96a6__';

for (const [customization, listHistory] of [
  [':', 'command builtin history'],
  ['history() { builtin history "$@" | cat; }', 'command builtin history'],
  ['command() { :; }', '\\builtin history'],
]) {
  for (const probe of [false, true]) {
    test(`separate Bash history lines are removed (${customization}, probe=${probe})`, () => {
      const input = `HISTFILE=/dev/null; HISTCONTROL=; PS1=; PS2=\nshopt -u cmdhist\n${customization}\n${listHistory} -c\necho user_one\necho user_two\n`
        + (probe ? buildLiveShellProbe(marker) : '')
        + buildWrappedCommand('echo command_ok', 'posix', marker, true)
        + '\nprintf "\\n"\n' + listHistory + '\nexit\n';
      const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-i'], {
        input, encoding: 'utf8', env: { ...process.env, TERM: 'dumb' }, timeout: 5000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /command_ok/);
      const entries = result.stdout.split('\n').filter(line => /^\s*\d+\s/.test(line));
      assert.ok(entries.some(line => line.includes('echo user_one')), entries.join('\n'));
      assert.ok(entries.some(line => line.includes('echo user_two')), entries.join('\n'));
      assert.ok(entries.every(line => !line.includes(marker)), entries.join('\n'));
    });
  }
}

for (const probe of [false, true]) {
  test(`zsh ignores both logical input commands with HIST_IGNORE_SPACE (probe=${probe})`, (t) => {
    const input = 'HISTFILE=/dev/null; HISTSIZE=100; setopt HIST_IGNORE_SPACE\necho user_one\n'
      + (probe ? buildLiveShellProbe(marker) : '')
      + buildWrappedCommand('echo command_ok', 'posix', marker, true)
      + '\necho user_two\nfc -l 1\nexit\n';
    const result = spawnSync('zsh', ['-f', '-i'], {
      input, encoding: 'utf8', env: { ...process.env, TERM: 'dumb' }, timeout: 5000,
    });
    if (result.error?.code === 'ENOENT') {
      t.skip('zsh is not installed');
      return;
    }
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /command_ok/);
    const entries = result.stdout.split('\n').filter(line => /^\s*\d+\s/.test(line));
    assert.ok(entries.some(line => line.includes('echo user_one')), entries.join('\n'));
    assert.ok(entries.some(line => line.includes('echo user_two')), entries.join('\n'));
    assert.ok(entries.every(line => !line.includes(marker)), entries.join('\n'));
  });
}
