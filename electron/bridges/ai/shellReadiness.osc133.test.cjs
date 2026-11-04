const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { trackSessionIdlePrompt, getFreshIdlePrompt, getVisibleIdlePrompt, computeOsc133ReadyState } = require('./shellUtils.cjs');
const { startPtyJob, resolveEffectiveShellKind } = require('./ptyExec.cjs');

const A = '\x1b]133;A\x07';
const B = '\x1b]133;B\x07';
const C = '\x1b]133;C\x07';
const D = '\x1b]133;D;0\x1b\\';
const ready = session => getFreshIdlePrompt(session) || getVisibleIdlePrompt(session);

class TestPty extends EventEmitter {
  writes = [];
  write(data) {
    this.writes.push(data);
    const marker = String(data).match(/(__NCMCP_[a-z0-9]+_[0-9a-f]+__)/i)?.[1];
    if (marker) queueMicrotask(() => this.emit('data', `${marker}_S\nOK\n${marker}_E:0\n`));
  }
}

test('OSC prompts reject pending input and continuations without writing any bytes', async () => {
  for (const prompt of ['review@local:~$ ', 'custom λ ', '> ']) {
    for (const pending of ['echo half-typed', ' ', 'echo "unfinished\r\n> ']) {
      const session = {};
      trackSessionIdlePrompt(session, A + prompt + B);
      assert.equal(ready(session), prompt);
      trackSessionIdlePrompt(session, pending);
      assert.equal(ready(session), '', JSON.stringify({ prompt, pending }));
      const pty = new TestPty();
      const result = await startPtyJob(pty, 'echo OK', {
        shellKind: 'posix', getReadyPrompt: () => ready(session), promptWaitTimeoutMs: 5, timeoutMs: 200,
      }).resultPromise;
      assert.equal(result.code, 'SHELL_NOT_READY');
      assert.deepEqual(pty.writes, []);
    }
  }
});

test('OSC prompt start alone does not revive a stale cached prompt', () => {
  const session = {};
  trackSessionIdlePrompt(session, 'PS C:\\Users\\review> ');
  trackSessionIdlePrompt(session, A);
  assert.equal(ready(session), '');
  trackSessionIdlePrompt(session, '❯ ' + B);
  assert.equal(getFreshIdlePrompt(session), '');
  assert.equal(ready(session), '❯ ');
  assert.equal(resolveEffectiveShellKind('', ready(session), { loginShellHint: 'posix' }), 'posix');
});

test('OSC custom prompts need prompt-end B before arbitrary text can qualify', () => {
  const session = {};
  trackSessionIdlePrompt(session, A + 'custom λ ');
  assert.equal(ready(session), '');
  trackSessionIdlePrompt(session, B);
  assert.equal(ready(session), 'custom λ ');
});

test('OSC busy and finished states survive 4KB tail eviction until a new prompt', () => {
  for (const marker of [C, D]) {
    const session = {};
    trackSessionIdlePrompt(session, A + 'review@local:~$ ' + B + marker);
    trackSessionIdlePrompt(session, 'x'.repeat(4200) + '\r\nreview@local:~$ ');
    assert.equal(session.osc133Ready, false);
    assert.equal(ready(session), '');
    trackSessionIdlePrompt(session, '\r\n' + A + 'custom λ ' + B);
    assert.equal(ready(session), 'custom λ ');
  }
});

test('OSC busy marker is retained even when it arrives inside one oversized chunk', () => {
  const session = {};
  trackSessionIdlePrompt(session, C + 'x'.repeat(4200) + '\r\nreview@local:~$ ');
  assert.equal(session.osc133Ready, false);
  assert.equal(ready(session), '');
});

test('OSC parser accepts complete BEL/ST parameterized markers but rejects prefixes and invalid opcodes', () => {
  for (const tail of ['\x1b]133;A', '\x1b]133;Aardvark\x07', '\x1b]133;C-more\x07']) {
    assert.equal(computeOsc133ReadyState(tail), null, JSON.stringify(tail));
  }
  assert.equal(computeOsc133ReadyState('\x1b]133;A;cl=m\x1b\\'), true);
  assert.equal(computeOsc133ReadyState(C + '\x1b]133;A'), false);
});

test('OSC secondary prompt markers never make unfinished input ready', () => {
  for (const prompt of ['> ', 'review@local:~$ ']) {
    const session = {};
    trackSessionIdlePrompt(session, A + 'custom λ ' + B + 'echo "\r\n');
    trackSessionIdlePrompt(session, '\x1b]133;A;k=s\x07' + prompt + B);
    assert.equal(session.osc133Ready, false);
    assert.equal(ready(session), '');
    assert.equal(computeOsc133ReadyState('\x1b]133;A;k=s\x07'), false);
  }
});

test('OSC markers and custom prompts survive every one-byte PTY split', () => {
  const session = {};
  for (const byte of '\x1b]133;A;cl=m\x1b\\custom λ \x1b]133;B\x1b\\') {
    trackSessionIdlePrompt(session, byte);
  }
  assert.equal(ready(session), 'custom λ ');
  for (const byte of C) trackSessionIdlePrompt(session, byte);
  assert.equal(ready(session), '');
});

test('OSC prompt recovery after erased input accepts only the original empty prompt', () => {
  const session = {};
  trackSessionIdlePrompt(session, A + 'custom λ ' + B + 'partial');
  assert.equal(ready(session), '');
  trackSessionIdlePrompt(session, '\r\x1b[2Kcustom λ ');
  assert.equal(ready(session), 'custom λ ');
  trackSessionIdlePrompt(session, 'echo "\r\n> ');
  trackSessionIdlePrompt(session, '\r\x1b[2Kcustom λ ');
  assert.equal(ready(session), '', 'continuation requires a new prompt cycle');
  trackSessionIdlePrompt(session, '\r\n' + A + 'custom λ ' + B);
  assert.equal(ready(session), '', 'newline and A/B do not prove cancellation');
  trackSessionIdlePrompt(session, C + D + A + 'custom λ ' + B);
  assert.equal(ready(session), 'custom λ ');
});

test('ambiguous backspace-space-backspace output never authorizes command injection', async () => {
  for (const prompt of ['review@local:~$ ', 'custom \u03bb ']) {
    for (const erased of ['x\b \b', 'xy\b \b\b \b',
      'hello' + '\b'.repeat(5) + ' '.repeat(5) + '\b'.repeat(5)]) {
      const session = {};
      trackSessionIdlePrompt(session, A + prompt + B);
      trackSessionIdlePrompt(session, erased);
      assert.equal(ready(session), '', JSON.stringify({ prompt, erased }));
      const pty = new TestPty();
      const result = await startPtyJob(pty, 'echo OK', {
        shellKind: 'posix', getReadyPrompt: () => ready(session), promptWaitTimeoutMs: 5, timeoutMs: 200,
      }).resultPromise;
      assert.equal(result.code, 'SHELL_NOT_READY');
      assert.deepEqual(pty.writes, []);
      trackSessionIdlePrompt(session, ' ');
      assert.equal(ready(session), '', 'a new space advances the input cursor');
      trackSessionIdlePrompt(session, '\b');
      assert.equal(ready(session), '', 'moving left must not erase a genuinely pending space');
      trackSessionIdlePrompt(session, ' \b');
      assert.equal(ready(session), '', 'moving right and left across a blank must remain pending');
    }
  }
});

test('real Bash line editing keeps ambiguous deletion and pending blanks gated', (t) => {
  if (process.platform === 'win32') return t.skip('requires a POSIX Bash PTY');
  const probe = spawnSync('python3', ['-c', 'import pty']);
  if (probe.error?.code === 'ENOENT') return t.skip('python3 is unavailable');
  assert.equal(probe.status, 0, probe.stderr?.toString());
  for (const args of [[], ['--wide-prompt']]) {
    const result = spawnSync('python3', [path.resolve(__dirname, '../../../scripts/fixtures/osc133-erase-input.py'), ...args],
      { encoding: 'utf8', timeout: 10_000 });
    if (result.status === 77) return t.skip('a UTF-8 locale is unavailable');
    assert.equal(result.status, 0, result.stderr);
    const scenarios = JSON.parse(result.stdout);
    assert.equal(scenarios.length, 27);
    const word = scenarios.find(({ name }) => name === 'Ctrl-W whole word');
    assert.ok(word.states.at(-1).raw.includes('\b'.repeat(5) + ' '.repeat(5) + '\b'.repeat(5)));
    const forward = scenarios.find(({ name }) => name === 'mixed forward delete');
    const kill = scenarios.find(({ name }) => name === 'indistinguishable mixed line kill');
    // The first leaves a genuine blank; the second empties input. Identical
    // output cannot certify which happened, so both must stay conservatively gated.
    assert.equal(forward.states.slice(1).map(({ raw }) => raw).join(''),
      kill.states.slice(1).map(({ raw }) => raw).join(''));
    for (const scenario of scenarios) {
      const session = {}, splitSession = {};
      for (const { step, raw, ready: expected } of scenario.states) {
        trackSessionIdlePrompt(session, raw);
        for (const ch of raw) {
          trackSessionIdlePrompt(splitSession, ch);
          if (!expected) assert.equal(Boolean(ready(splitSession)), false,
            `intermediate byte of ${scenario.name}: ${step}`);
        }
        assert.equal(Boolean(ready(session)), expected, `${scenario.name}: ${step}`);
        assert.equal(Boolean(ready(splitSession)), expected, `byte-split ${scenario.name}: ${step}`);
      }
    }
  }
});

test('real Bash vi replacement and multiline Ctrl-L remain unready through every packet boundary', async (t) => {
  if (process.platform === 'win32') return t.skip('requires a POSIX Bash PTY');
  const probe = spawnSync('python3', ['-c', 'import pty']);
  if (probe.error?.code === 'ENOENT') return t.skip('python3 is unavailable');
  assert.equal(probe.status, 0, probe.stderr?.toString());
  const result = spawnSync('python3', [path.resolve(__dirname, '../../../scripts/fixtures/osc133-erase-input.py'), '--risk-probes'],
    { encoding: 'utf8', timeout: 10_000 });
  if (result.status === 77) return t.skip('a UTF-8 locale is unavailable');
  assert.equal(result.status, 0, result.stderr);
  const scenarios = JSON.parse(result.stdout);
  assert.equal(scenarios.length, 2);
  assert.equal(scenarios[0].readline_line, ' ', 'bind -x confirms vi replacement leaves real input');
  assert.equal(scenarios[0].states.slice(1).map(({ raw }) => raw).join(''), 'x\b \b');
  assert.equal(scenarios[1].readline_line, 'echo pending');
  const redraw = scenarios[1].states.at(-1).raw;
  assert.ok(redraw.includes(A + 'header\r\r\n'));
  assert.ok(redraw.includes(B), 'Ctrl-L redraw includes the input boundary before re-echo');
  for (const scenario of scenarios) {
    const session = {};
    for (const { step, raw, ready: expected } of scenario.states) {
      for (const ch of raw) {
        trackSessionIdlePrompt(session, ch);
        if (!expected) assert.equal(ready(session), '', `${scenario.name}: ${step}, intermediate packet`);
      }
      assert.equal(Boolean(ready(session)), expected, `${scenario.name}: ${step}`);
    }
    const pty = new TestPty();
    const result = await startPtyJob(pty, 'echo OK', {
      shellKind: 'posix', getReadyPrompt: () => ready(session), promptWaitTimeoutMs: 5, timeoutMs: 200,
    }).resultPromise;
    assert.equal(result.code, 'SHELL_NOT_READY');
    assert.deepEqual(pty.writes, []);
    // Repeated redraws, their own newlines, and secondary prompts cannot reset
    // uncertain input. Only a completed command lifecycle permits recovery.
    for (const text of ['\r\n' + A + 'header\r\nreview@local:~$ ' + B,
      '\x1b]133;A;k=s\x07> ' + B + A + 'custom ' + B]) {
      for (const ch of text) {
        trackSessionIdlePrompt(session, ch);
        assert.equal(ready(session), '');
      }
    }
    trackSessionIdlePrompt(session, C + D + A + 'custom ' + B);
    assert.equal(ready(session), 'custom ');
  }
});

test('same-row OSC redraw stays gated until a fresh prompt lifecycle', () => {
  const session = {}, prompt = 'review@local:~$ ';
  trackSessionIdlePrompt(session, A + prompt + B + 'x ');
  for (const ch of '\r' + A + prompt + B) {
    trackSessionIdlePrompt(session, ch);
    assert.equal(ready(session), '');
  }
  trackSessionIdlePrompt(session, '\r\n' + A + prompt + B);
  assert.equal(ready(session), '', 'a newline cannot clear the redraw latch');
  trackSessionIdlePrompt(session, 'x' + '\r' + A + prompt + B);
  assert.equal(ready(session), '');
  trackSessionIdlePrompt(session, C + D + A + prompt + B);
  assert.equal(ready(session), prompt);
});

test('OSC repeats complete execution and prompt cycles without stale prompt state', async () => {
  const session = {};
  for (const prompt of ['custom λ ', 'other ❯ ', 'review@local:~$ ']) {
    trackSessionIdlePrompt(session, '\r\n' + A + prompt + B);
    const pty = new TestPty();
    const result = await startPtyJob(pty, 'echo OK', {
      shellKind: 'posix', getReadyPrompt: () => ready(session), promptWaitTimeoutMs: 5, timeoutMs: 200,
    }).resultPromise;
    assert.equal(result.ok, true);
    assert.equal(pty.writes.length, 1);
    trackSessionIdlePrompt(session, C + 'output' + D);
    assert.equal(ready(session), '');
  }
});
