const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { startPtyJob } = require('./ptyExec.cjs');
const { buildLiveShellProbe } = require('./liveShellProbe.cjs');
const { buildWrappedCommand } = require('./ptyExecHelpers.cjs');

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

test('paced delivery with enforceWallTimeout stays inside the absolute request deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pty = new EventEmitter();
  const writes = [];
  pty.write = (data) => writes.push(String(data));
  // Long enough that paced delivery (128 chars / 30ms) exceeds the absolute
  // deadline (timeoutMs + 5s transport grace) from job start.
  const command = `echo ${'x'.repeat(40000)}`;
  const job = startPtyJob(pty, command, {
    shellKind: 'posix', probeLiveShell: true, timeoutMs: 500, enforceWallTimeout: true,
  });
  try {
    const probeLength = 2 + buildLiveShellProbe(job.marker).length;
    while (writes.join('').length < probeLength && !writes.includes('\x03')) t.mock.timers.tick(30);
    pty.emit('data', `${job.marker}_P:sh\n${job.marker}_Q`);
    const totalLength = probeLength + 2 + buildWrappedCommand(command, 'posix', job.marker, true).length;
    // Delivery takes ~10s of mock time; the absolute deadline (~5.5s) must
    // interrupt mid-pacing instead of letting delivery outlast the client.
    while (!writes.includes('\x03') && writes.join('').length < totalLength) t.mock.timers.tick(30);
    assert.ok(writes.includes('\x03'), 'paced delivery was not bounded by the absolute deadline');
    assert.ok(writes.join('').length < totalLength, 'delivery continued past the absolute deadline');
    const result = await job.resultPromise;
    assert.equal(result.ok, false);
    assert.match(result.error, /timed out/);
  } finally {
    pty.emit('close');
    t.mock.timers.reset();
  }
});

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
  for (let i = 0; i < 6; i++) {
    pty.emit('data', 'unrelated output\n');
    t.mock.timers.tick(100);
  }
  // The probe deadline first clears the probe state and delivers the command
  // anyway (#3403); after the paced wrapper delivery the re-armed deadline
  // then fails the job, so advance until the interrupt/finish happens.
  while (!writes.includes('\x03')) t.mock.timers.tick(30);
  const result = await job.resultPromise;
  assert.match(result.error, /timed out/);
  assert.ok(writes.join('').includes('echo never'), 'a missing probe reply must still deliver the command');
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
