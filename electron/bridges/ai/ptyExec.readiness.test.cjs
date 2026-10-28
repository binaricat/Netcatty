const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { startPtyJob } = require('./ptyExec.cjs');
const { getFreshIdlePrompt, getVisibleIdlePrompt, trackSessionIdlePrompt } = require('./shellUtils.cjs');
const { terminalCursorLine } = require('../terminalLogSanitizer.cjs');

function readyPrompt(session) {
  return getFreshIdlePrompt(session) || getVisibleIdlePrompt(session);
}

// PSReadLine echoes the PowerShell clear-prefix keys, then erases them with
// cursor-column + ED without rewriting the prompt into the byte stream.
function powershellEraseRedraw(prompt) {
  return `${prompt}ggd2147483647d\x1b[20G\x1b[0J`;
}

class TestPty extends EventEmitter {
  writes = [];
  write(data) {
    this.writes.push(String(data));
    const marker = String(data).match(/(__NCMCP_[a-z0-9]+_[0-9a-f]+__)/i)?.[1];
    if (marker) queueMicrotask(() => this.emit('data', `${marker}_S\nOK\n${marker}_E:0\n`));
  }
}

test('PTY sends no bytes while a slow shell is starting, then runs once ready', async () => {
  const pty = new TestPty();
  let prompt = '';
  const job = startPtyJob(pty, 'echo OK', { shellKind:'posix', getReadyPrompt:()=>prompt, promptWaitTimeoutMs:200, timeoutMs:1000 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(pty.writes, []);
  prompt = 'user@host:~$ ';
  const result = await job.resultPromise;
  assert.equal(result.ok, true);
  assert.equal(pty.writes.length, 1);
});

test('macOS default zsh prompt is recognized as an idle prompt', async () => {
  const pty = new TestPty();
  const session = { _promptTrackTail: '', lastIdlePrompt: '' };
  const prompt = 'hexiao@JosephdeMacBook-Pro-2 ~ % ';
  trackSessionIdlePrompt(session, `Last login: Mon Oct 26\r\n${prompt}`);
  assert.equal(session.lastIdlePrompt, prompt);
  assert.equal(readyPrompt(session), prompt);

  const job = startPtyJob(pty, 'echo OK', {
    shellKind: 'posix',
    getReadyPrompt: () => readyPrompt(session),
    promptWaitTimeoutMs: 200,
    timeoutMs: 1000,
  });
  const result = await job.resultPromise;
  assert.equal(result.ok, true);
  assert.equal(pty.writes.length, 1);
});

test('zsh prompt with pending input does not become ready', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const pty = new TestPty();
  const session = { _promptTrackTail: '', lastIdlePrompt: '' };
  trackSessionIdlePrompt(session, 'hexiao@JosephdeMacBook-Pro-2 ~ % echo half-typed');
  assert.equal(readyPrompt(session), '');

  const job = startPtyJob(pty, 'echo OK', {
    shellKind: 'posix',
    getReadyPrompt: () => readyPrompt(session),
    promptWaitTimeoutMs: 50,
    timeoutMs: 1000,
  });
  t.mock.timers.tick(50);
  const result = await job.resultPromise;
  assert.equal(result.code, 'SHELL_NOT_READY');
  assert.deepEqual(pty.writes, []);
});

test('zsh default prompts allow directory spaces and the privileged marker', async () => {
  for (const prompt of ['alice@MacBook-Pro My Project % ', 'root@MacBook-Pro ~ # ', 'root@MacBook-Pro My Project # ']) {
    const pty = new TestPty();
    const session = { _promptTrackTail: '', lastIdlePrompt: '' };
    trackSessionIdlePrompt(session, `Last login\r\n${prompt}`);
    assert.equal(getFreshIdlePrompt(session), prompt);
    assert.equal(getVisibleIdlePrompt(session), prompt);

    const result = await startPtyJob(pty, 'echo OK', {
      shellKind: 'posix',
      getReadyPrompt: () => readyPrompt(session),
      promptWaitTimeoutMs: 200,
      timeoutMs: 1000,
    }).resultPromise;
    assert.equal(result.ok, true, prompt);
    assert.equal(pty.writes.length, 1, prompt);
  }
});

test('zsh spaced-directory prompts with pending input stay unready', async () => {
  for (const line of ['alice@MacBook-Pro My Project % echo %', 'root@MacBook-Pro My Project # echo #']) {
    const pty = new TestPty();
    const session = { _promptTrackTail: '', lastIdlePrompt: '' };
    trackSessionIdlePrompt(session, line);
    assert.equal(readyPrompt(session), '', line);
    const result = await startPtyJob(pty, 'echo forbidden', {
      getReadyPrompt: () => readyPrompt(session),
      promptWaitTimeoutMs: 25,
      timeoutMs: 1000,
    }).resultPromise;
    assert.equal(result.code, 'SHELL_NOT_READY', line);
    assert.deepEqual(pty.writes, [], line);
  }
});

test('parenthesized Deck prompts allow execution only while idle', async () => {
  for (const prompt of ['(deck@steamdeck ~)$ ', '(root@steamdeck /home/deck)# ', '(venv) (deck@steamdeck My Project)$ ', '(deck@steamdeck My Project (1))$ ', '(root@steamdeck /cash$# (old))# ', '(venv) (deck@steamdeck $work#1)$ ']) {
    const session = { _promptTrackTail: '', lastIdlePrompt: '' };
    trackSessionIdlePrompt(session, `Last login\r\n${prompt}`);
    assert.equal(readyPrompt(session), prompt);
    const pty = new TestPty();
    const result = await startPtyJob(pty, 'echo OK', {
      shellKind: 'posix', getReadyPrompt: () => readyPrompt(session), promptWaitTimeoutMs: 25, timeoutMs: 1000,
    }).resultPromise;
    assert.equal(result.ok, true, prompt);
    assert.equal(pty.writes.length, 1);

    trackSessionIdlePrompt(session, 'echo pending');
    assert.equal(readyPrompt(session), '');
    const pendingPty = new TestPty();
    const pending = await startPtyJob(pendingPty, 'echo OK', {
      shellKind: 'posix', getReadyPrompt: () => readyPrompt(session), promptWaitTimeoutMs: 25, timeoutMs: 1000,
    }).resultPromise;
    assert.equal(pending.code, 'SHELL_NOT_READY');
    assert.deepEqual(pendingPty.writes, []);
  }
});

test('parenthesized Deck prompts with pending input do not allow execution', async () => {
  for (const line of ['(deck@steamdeck ~)$ echo hello', '(deck@steamdeck ~)$ echo $', '(deck@steamdeck ~)$ echo (x)$', '(deck@steamdeck 100%)%']) {
    const session = { _promptTrackTail: '', lastIdlePrompt: '' };
    trackSessionIdlePrompt(session, line);
    assert.equal(readyPrompt(session), '', line);
    const pty = new TestPty();
    const result = await startPtyJob(pty, 'echo OK', {
      shellKind: 'posix', getReadyPrompt: () => readyPrompt(session), promptWaitTimeoutMs: 25, timeoutMs: 1000,
    }).resultPromise;
    assert.equal(result.code, 'SHELL_NOT_READY', line);
    assert.deepEqual(pty.writes, [], line);
  }
});

test('PTY readiness timeout does not send command or interrupt to a busy program', async () => {
  const pty = new TestPty();
  const job = startPtyJob(pty, 'echo OK', { getReadyPrompt:()=>'', promptWaitTimeoutMs:25, timeoutMs:1000 });
  const result = await job.resultPromise;
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SHELL_NOT_READY');
  assert.deepEqual(pty.writes, []);
});

test('cancel while waiting for prompt never sends Ctrl+C or a delayed command', async () => {
  const pty = new TestPty();
  let prompt = '';
  const job = startPtyJob(pty, 'echo OK', { getReadyPrompt:()=>prompt, promptWaitTimeoutMs:200, timeoutMs:1000 });
  job.cancel();
  prompt = 'user@host:~$ ';
  const result = await job.resultPromise;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(result.error, 'Cancelled');
  assert.deepEqual(pty.writes, []);
});

test('closing stream during readiness wait finishes without typing', async () => {
  const pty = new TestPty();
  const job = startPtyJob(pty, 'echo OK', { getReadyPrompt:()=>'', promptWaitTimeoutMs:200, timeoutMs:1000 });
  pty.emit('close');
  assert.equal((await job.resultPromise).ok, false);
  assert.deepEqual(pty.writes, []);
});

test('readiness failure does not echo a command or interrupt a waiting program', async () => {
  const pty = new TestPty();
  const echoes = [];
  const interrupts = [];
  const result = await startPtyJob(pty, 'echo OK', {
    getReadyPrompt: () => '', promptWaitTimeoutMs: 25,
    typedInput: true, echoCommand: value => echoes.push(value),
    onInterrupt: () => interrupts.push(true),
  }).resultPromise;
  assert.equal(result.code, 'SHELL_NOT_READY');
  assert.deepEqual(pty.writes, []);
  assert.deepEqual(echoes, []);
  assert.deepEqual(interrupts, []);
});

test('wall deadline during startup fails without writing or interrupting', async () => {
  const pty = new TestPty();
  const result = await startPtyJob(pty, 'echo OK', {
    getReadyPrompt: () => '', promptWaitTimeoutMs: 1000,
    timeoutMs: 25, enforceWallTimeout: true,
  }).resultPromise;
  assert.equal(result.code, 'SHELL_NOT_READY');
  assert.deepEqual(pty.writes, []);
});

test('a prompt inspection error fails closed without typing', async () => {
  const pty = new TestPty();
  const result = await startPtyJob(pty, 'echo OK', {
    getReadyPrompt: () => { throw new Error('session disappeared'); },
  }).resultPromise;
  assert.equal(result.code, 'SHELL_NOT_READY');
  assert.deepEqual(pty.writes, []);
});

test('cancel during asynchronous input authorization never writes after a late grant', async () => {
  const pty = new TestPty();
  let authorize;
  let entered;
  const authorizationStarted = new Promise(resolve => { entered = resolve; });
  const job = startPtyJob(pty, 'echo forbidden', {
    getReadyPrompt: () => 'user@host:~$ ',
    beforeInput: () => {
      entered();
      return new Promise(resolve => { authorize = resolve; });
    },
  });
  await authorizationStarted;
  job.cancel();
  assert.equal((await job.resultPromise).error, 'Cancelled');
  authorize();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(pty.writes, []);
});

test('input authorization rejects without command echo or control bytes', async () => {
  const pty = new TestPty();
  const echoes = [];
  const result = await startPtyJob(pty, 'echo forbidden', {
    getReadyPrompt: () => 'user@host:~$ ',
    beforeInput: async () => { throw new Error('Authorization revoked'); },
    typedInput: true, echoCommand: value => echoes.push(value),
  }).resultPromise;
  assert.equal(result.code, 'EXECUTION_NOT_AUTHORIZED');
  assert.deepEqual(pty.writes, []);
  assert.deepEqual(echoes, []);
});

test('a prompt lost during asynchronous authorization fails closed', async () => {
  const pty = new TestPty();
  let prompt = 'user@host:~$ ';
  const result = await startPtyJob(pty, 'echo forbidden', {
    getReadyPrompt: () => prompt,
    beforeInput: async () => { prompt = ''; },
  }).resultPromise;
  assert.equal(result.code, 'SHELL_NOT_READY');
  assert.deepEqual(pty.writes, []);
});

test('stalled input authorization is bounded without interrupting the PTY', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const pty = new TestPty();
  const job = startPtyJob(pty, 'echo forbidden', {
    getReadyPrompt: () => 'user@host:~$ ',
    beforeInput: () => new Promise(() => {}),
  });
  t.mock.timers.tick(30001);
  const result = await job.resultPromise;
  assert.equal(result.code, 'EXECUTION_NOT_AUTHORIZED');
  assert.deepEqual(pty.writes, []);
});

test('wall deadline during authorization reports authorization failure rather than readiness', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const pty = new TestPty();
  const job = startPtyJob(pty, 'echo forbidden', {
    getReadyPrompt: () => 'user@host:~$ ',
    beforeInput: () => new Promise(() => {}),
    timeoutMs: 25, enforceWallTimeout: true,
  });
  t.mock.timers.tick(26);
  const result = await job.resultPromise;
  assert.equal(result.code, 'EXECUTION_NOT_AUTHORIZED');
  assert.match(result.error, /authorization timed out/);
  assert.deepEqual(pty.writes, []);
});

test('idle PowerShell whose raw tail was CSI-erased still receives the command', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const pty = new TestPty();
  const session = { _promptTrackTail: '', lastIdlePrompt: '' };
  const prompt = 'PS C:\\Users\\alice> ';
  trackSessionIdlePrompt(session, `Windows PowerShell\r\n${powershellEraseRedraw(prompt)}`);
  assert.equal(getFreshIdlePrompt(session), '');
  const job = startPtyJob(pty, 'Write-Output ok', {
    shellKind: 'powershell',
    getReadyPrompt: () => readyPrompt(session),
    promptWaitTimeoutMs: 200,
    timeoutMs: 1000,
    typedInput: true,
  });
  t.mock.timers.tick(200);
  const result = await job.resultPromise;
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'OK');
  assert.equal(pty.writes.length, 1);
  assert.match(pty.writes[0], /\$__NCMCP_/);
});

test('the next PowerShell exec runs after the clear-prefix echo is erased on screen', async () => {
  const prompt = 'PS C:\\Users\\alice> ';
  const session = { _promptTrackTail: '', lastIdlePrompt: '' };
  trackSessionIdlePrompt(session, prompt);
  const pty = new EventEmitter();
  pty.writes = [];
  pty.write = (data) => {
    const text = String(data);
    pty.writes.push(text);
    const marker = text.match(/(__NCMCP_[0-9a-z]+_[0-9a-f]+__)/i)?.[1];
    if (!marker) return;
    queueMicrotask(() => {
      const chunk = `${marker}_S\r\nok\r\n${marker}_E:0\r\n${powershellEraseRedraw(prompt)}`;
      trackSessionIdlePrompt(session, chunk);
      pty.emit('data', chunk);
    });
  };

  const first = startPtyJob(pty, 'Write-Output ok', {
    shellKind: 'powershell',
    getReadyPrompt: () => readyPrompt(session),
    timeoutMs: 1000,
    typedInput: true,
  });
  const firstResult = await first.resultPromise;
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.stdout, 'ok');
  assert.equal(getFreshIdlePrompt(session), '');
  assert.equal(getVisibleIdlePrompt(session), prompt);

  const second = startPtyJob(pty, 'Write-Output next', {
    shellKind: 'powershell',
    getReadyPrompt: () => readyPrompt(session),
    promptWaitTimeoutMs: 200,
    timeoutMs: 1000,
    typedInput: true,
  });
  const secondResult = await second.resultPromise;
  assert.equal(secondResult.ok, true);
  assert.equal(secondResult.stdout, 'ok');
  assert.equal(pty.writes.length, 2);
});

test('alt-screen paint is not ready after the entry sequence leaves the prompt tail', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const pty = new TestPty();
  const session = { _promptTrackTail: '', lastIdlePrompt: '' };
  const prompt = 'PS C:\\Users\\alice> ';
  // A full-screen app can emit more than the 4096-byte prompt tail. Once the
  // alternate-screen entry scrolls off, a painted idle prompt must not unlock
  // ptyExec and type into the still-running program.
  trackSessionIdlePrompt(session, prompt);
  trackSessionIdlePrompt(session, `\x1b[?1049h${'x'.repeat(4200)}`);
  trackSessionIdlePrompt(session, `\r\n${prompt}\r`);
  assert.equal(session._promptTrackTail.includes('\x1b[?1049h'), false);
  assert.equal(terminalCursorLine(session._promptTrackTail).trimEnd(), prompt.trimEnd());
  assert.equal(getFreshIdlePrompt(session), '');
  assert.equal(getVisibleIdlePrompt(session), '');
  assert.equal(readyPrompt(session), '');

  const job = startPtyJob(pty, 'Write-Output ok', {
    shellKind: 'powershell',
    getReadyPrompt: () => readyPrompt(session),
    promptWaitTimeoutMs: 50,
    timeoutMs: 1000,
  });
  t.mock.timers.tick(50);
  const result = await job.resultPromise;
  assert.equal(result.code, 'SHELL_NOT_READY');
  assert.match(result.error, /no command was sent/);
  assert.deepEqual(pty.writes, []);
});

test('real pending PowerShell input is still not sent', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const pty = new TestPty();
  const session = { _promptTrackTail: '', lastIdlePrompt: '' };
  trackSessionIdlePrompt(session, 'PS C:\\Users\\alice> Write-Output ok');
  const job = startPtyJob(pty, 'echo OK', {
    shellKind: 'powershell',
    getReadyPrompt: () => readyPrompt(session),
    promptWaitTimeoutMs: 50,
    timeoutMs: 1000,
  });
  t.mock.timers.tick(50);
  const result = await job.resultPromise;
  assert.equal(result.code, 'SHELL_NOT_READY');
  assert.match(result.error, /no command was sent/);
  assert.deepEqual(pty.writes, []);
});
