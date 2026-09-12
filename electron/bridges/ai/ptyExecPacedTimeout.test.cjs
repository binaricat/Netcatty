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
  const result = await job.resultPromise;
  assert.match(result.error, /Command startup timed out/);
  assert.ok(writes.includes('\x03'));
});
