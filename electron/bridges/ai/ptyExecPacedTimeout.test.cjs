const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { startPtyJob } = require('./ptyExec.cjs');
const { buildLiveShellProbe } = require('./liveShellProbe.cjs');
const { buildWrappedCommand } = require('./ptyExecHelpers.cjs');

test('short wall-clock bypass resumes session flow control before typing the wrapper', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pty = new EventEmitter();
  const writes = [];
  const events = [];
  pty.write = (data) => writes.push(String(data));
  // The probe needs ~600ms of paced delivery and the wrapper ~330ms, so a
  // 800ms wall budget skips the probe and types the wrapper directly. That
  // bypass must still resume session-owned flow (clearSessionFlowState)
  // before typing the wrapper, otherwise a renderer flow paused before the
  // job keeps the buffered start/end markers away from onData and the job
  // times out despite the command executing remotely.
  const job = startPtyJob(pty, 'printf resumed', {
    shellKind: 'posix', probeLiveShell: true, timeoutMs: 800, enforceWallTimeout: true,
    onInterrupt: () => events.push('interrupt'),
  });
  assert.ok(events.includes('interrupt'), 'bypass must invoke onInterrupt before typing');
  const totalLength = 2 + buildWrappedCommand('printf resumed', 'posix', job.marker, true).length;
  while (writes.join('').length < totalLength) t.mock.timers.tick(30);
  assert.ok(!writes.join('').includes('function __ncmcp_int'),
    'bypass must skip the probe and type the wrapper directly');
  pty.emit('data', `${job.marker}_S\r\nresumed\r\n${job.marker}_E:0\r\n`);
  const result = await job.resultPromise;
  assert.equal(result.exitCode, 0, JSON.stringify(result));
});

for (const background of [true, false]) {
  test(`paced ${background ? 'background' : 'silent foreground'} delivery does not consume startup time`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pty = new EventEmitter();
    const writes = [];
    pty.write = (data) => writes.push(String(data));
    const command = `echo ${'x'.repeat(background ? 150000 : 12000)}`;
    const job = startPtyJob(pty, command, {
      shellKind: 'posix', probeLiveShell: true,
      timeoutMs: background ? 3600000 : 500,
      maxBufferedChars: background ? 1024 : 0,
    });
    const advance = (ms) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 30) t.mock.timers.tick(30);
    };
    try {
      const probeLength = 2 + buildLiveShellProbe(job.marker).length;
      while (writes.join('').length < probeLength && !writes.includes('\x03')) advance(30);
      assert.ok(!writes.includes('\x03'), 'probe delivery was interrupted');
      pty.emit('data', `${job.marker}_P:sh\n${job.marker}_Q`);
      // The background case crosses the old probe timer; the foreground
      // case has no echo to refresh its inactivity timer during delivery.
      advance(background ? 32010 : 1200);
      assert.ok(!writes.includes('\x03'), 'wrapper interrupted before delivery completed');
      const totalLength = probeLength + 2 + buildWrappedCommand(command, 'posix', job.marker, true).length;
      while (writes.join('').length < totalLength && !writes.includes('\x03')) advance(30);
      assert.ok(!writes.includes('\x03'), 'delivery did not finish');
      pty.emit('data', `${job.marker}_S\nOK\n${job.marker}_E:0\n`);
      assert.equal((await job.resultPromise).exitCode, 0);
    } finally {
      pty.emit('close');
      t.mock.timers.reset();
    }
  });
}

test('completed delivery still has a bounded wait for a missing probe reply', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pty = new EventEmitter();
  const writes = [];
  pty.write = (data) => writes.push(String(data));
  const job = startPtyJob(pty, 'echo never', {
    shellKind: 'posix', probeLiveShell: true, timeoutMs: 500,
  });
  const length = 2 + buildLiveShellProbe(job.marker).length;
  while (writes.join('').length < length) t.mock.timers.tick(30);
  // Unrelated output must not keep a never-started command alive forever.
  // The probe fallback fires before the command deadline (75% of the
  // budget) so a lost _Q sentinel still gets the wrapper typed.
  let resolved = false;
  job.resultPromise.then(() => { resolved = true; });
  for (let i = 0; i < 40 && !resolved; i++) {
    pty.emit('data', 'unrelated output\n');
    t.mock.timers.tick(100);
  }
  assert.ok(writes.join('').includes('echo never'), 'probe fallback typed the wrapped command');
  const result = await job.resultPromise;
  assert.match(result.error, /Command startup timed out/);
  assert.ok(writes.includes('\x03'));
});

for (const cancel of [false, true]) {
  test(`backpressure pauses input until ${cancel ? 'cancellation' : 'drain'}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pty = new EventEmitter();
    const writes = [];
    let blocked = true;
    pty.write = (data) => { writes.push(data); return !blocked; };
    const job = startPtyJob(pty, 'echo 😀', { shellKind: 'posix', bastionKeystrokes: true, timeoutMs: 500 });
    assert.equal(writes.length, 1);
    t.mock.timers.tick(300);
    assert.equal(writes.length, 1, 'no more input is queued while blocked');
    if (cancel) {
      job.cancel();
      const count = writes.length;
      pty.emit('drain');
      t.mock.timers.tick(30);
      assert.equal(writes.length, count, 'cancelled input never resumes');
      assert.equal(pty.listenerCount('drain'), 0);
      pty.emit('close');
      assert.match((await job.resultPromise).error, /Cancelled/);
    } else {
      blocked = false;
      pty.emit('drain');
      t.mock.timers.tick(30);
      while (!writes.join('').endsWith('\n')) t.mock.timers.tick(30);
      assert.ok(writes.every((value) => Array.from(value).length === 1));
      assert.ok(writes.includes('😀'));
      pty.emit('data', `${job.marker}_S\nOK\n${job.marker}_E:0\n`);
      assert.equal((await job.resultPromise).exitCode, 0);
    }
  });
}

test('a stalled drain has a bounded wait and releases its listener', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pty = new EventEmitter();
  pty.write = () => false;
  const job = startPtyJob(pty, 'echo blocked', { shellKind: 'posix', timeoutMs: 500 });
  t.mock.timers.tick(500);
  assert.match((await job.resultPromise).error, /input timed out waiting for drain/);
  assert.equal(pty.listenerCount('drain'), 0);
});

for (const shellKind of ['powershell', 'cmd']) {
  test(`bastion ${shellKind} input yields without a live probe and stops on cancel`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pty = new EventEmitter();
    const writes = [];
    pty.write = (data) => { writes.push(data); };
    const job = startPtyJob(pty, `echo ${'x'.repeat(12000)}`, {
      shellKind, bastionKeystrokes: true, timeoutMs: 500,
    });
    assert.equal(writes.length, 128);
    t.mock.timers.tick(30);
    assert.equal(writes.length, 256);
    assert.ok(writes.every((value) => Array.from(value).length === 1));
    job.cancel();
    const count = writes.length;
    t.mock.timers.tick(30);
    assert.equal(writes.length, count);
    pty.emit('close');
    assert.match((await job.resultPromise).error, /Cancelled/);
  });
}
