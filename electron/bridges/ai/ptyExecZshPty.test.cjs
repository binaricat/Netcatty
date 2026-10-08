const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { getTempFilePath } = require('../tempDirBridge.cjs');
const { execViaPty } = require('./ptyExec.cjs');

test('zsh startup and ZLE hooks remain usable across real PTY jobs', {
  skip: process.platform !== 'linux' && 'requires the util-linux script PTY',
  timeout: 20000,
}, async (t) => {
  for (const command of ['zsh', 'script']) {
    const check = spawnSync(command, ['--version'], { encoding: 'utf8' });
    if (check.error?.code === 'ENOENT') {
      t.skip(`${command} is not installed`);
      return;
    }
    assert.equal(check.status, 0, check.stderr);
  }

  const zdotdir = mkdtempSync(`${getTempFilePath('zsh-pty-test')}-`);
  t.after(() => rmSync(zdotdir, { recursive: true, force: true }));
  writeFileSync(join(zdotdir, '.zshrc'), `
PROMPT='netcatty-test%# '
RPROMPT=''
HISTFILE=$ZDOTDIR/history
HISTSIZE=100
SAVEHIST=100
setopt HIST_IGNORE_SPACE
typeset -g NETCATTY_RC_LOADED=yes
typeset -gi NETCATTY_REDRAWS=0
zmodload zsh/zle
autoload -Uz add-zle-hook-widget
netcatty_redraw() {
  (( ++NETCATTY_REDRAWS ))
  region_highlight=("0 \${#BUFFER} fg=green")
}
add-zle-hook-widget line-pre-redraw netcatty_redraw
netcatty_line_init() {
  [[ -o zle ]] && print -r -- __NETCATTY_ZLE_READY__
}
add-zle-hook-widget line-init netcatty_line_init
`);

  // script supplies a real controlling PTY without depending on node-pty's
  // Node/Electron ABI. -d excludes machine-wide rc files (CI's compinit can
  // prompt before our fixture loads); unlike -f, it still reads our .zshrc.
  const child = spawn('script', ['-qefc', 'exec zsh -d -i', '/dev/null'], {
    env: { ...process.env, ZDOTDIR: zdotdir, TERM: 'xterm-256color' },
  });
  const stream = new EventEmitter();
  stream.write = (data) => child.stdin.write(data);
  child.stdin.on('drain', () => stream.emit('drain'));
  child.stdin.on('error', (error) => stream.emit('error', error));
  child.on('error', (error) => stream.emit('error', error));
  child.on('close', () => stream.emit('close'));
  let output = '';
  child.stdout.on('data', (data) => {
    output += data.toString();
    stream.emit('data', data);
  });
  child.stderr.on('data', (data) => { output += data.toString(); });
  let streamError;
  stream.on('error', (error) => { streamError = error; });
  t.after(() => child.kill());
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      assert.ifError(streamError);
      assert.ok(Date.now() < deadline, `PTY output:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  await waitFor(() => output.includes('__NETCATTY_ZLE_READY__'));

  const options = {
    shellKind: 'posix', probeLiveShell: true, stripMarkers: true,
    timeoutMs: 5000, enforceWallTimeout: true,
  };
  // No initial path hint: the real probe must discover zsh before wrapping.
  const first = await execViaPty(stream, '[[ -t 0 ]] && print -r -- "rc:$NETCATTY_RC_LOADED"', options);
  assert.equal(first.exitCode, 0, JSON.stringify(first));
  assert.equal(first.stdout.trim(), 'rc:yes');

  // Exercise paced writes, quoting, multiline eval, and the cached flavor on
  // the same live editor, then prove a nonzero exit does not wedge that shell.
  const payload = `quoted ' text ${'x'.repeat(1500)}`;
  const second = await execViaPty(stream, `printf '%s\\n' "${payload}"\nexit 7`, options);
  assert.equal(second.exitCode, 7, JSON.stringify(second));
  assert.equal(second.stdout.trim(), payload);

  output = '';
  child.stdin.write('print -r -- "__USER_""AFTER__:$NETCATTY_REDRAWS"\n');
  await waitFor(() => /__USER_AFTER__:[1-9]\d*\r?\n/.test(output));
  assert.ok(!output.includes('parse error'), output);
  child.stdin.end('exit\n');
  await waitFor(() => child.exitCode !== null);
  assert.equal(child.exitCode, 0, output);
});
