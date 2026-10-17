const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { startPtyJob } = require('./ptyExec.cjs');
const { buildWrappedCommand } = require('./ptyExecHelpers.cjs');
const { buildLiveShellProbe, buildLiveShellProbeCleanup } = require('./liveShellProbe.cjs');

// systemd >=258 (Ubuntu 25.10/26.04) ships a PS0/PROMPT_COMMAND hook that emits
// OSC 3008 context sequences around every submitted command (issue #3676).
// During paced typed delivery that bypass output can desync the payload's own
// final newline and leave the command sitting on the input line uncommitted.
// A delivery that observed OSC 3008 must be followed by one standalone submit
// Enter written as its own write; quiet deliveries must not change shape.

const COMMAND = "echo " + "x".repeat(1200);
const OSC_3008 = "\x1b]3008;start=uuid;type=command\x1b\\";

function makePty() {
  const pty = new EventEmitter();
  const writes = [];
  pty.write = (data) => { writes.push(String(data)); return true; };
  return { pty, writes };
}

function expectedDeliveryLength(marker) {
  const probe = 2 + buildLiveShellProbe(marker).length;
  const wrapper = 2 + buildLiveShellProbeCleanup(marker).length + buildWrappedCommand(COMMAND, "posix", marker, true).length;
  return probe + wrapper;
}

async function driveDelivery(t, pty, writes, marker, { osc, finalTick = true }) {
  const totalLength = expectedDeliveryLength(marker);
  // Short probe is delivered as a single write; reply to finish probing.
  t.mock.timers.tick(30);
  assert.ok(writes.length >= 1, "probe was written");
  pty.emit("data", `${marker}_P:sh\n${marker}_Q`);
  let delivered = false;
  for (let i = 0; i < 4000; i += 1) {
    t.mock.timers.tick(30);
    if (osc && i % 4 === 0) pty.emit("data", osc);
    if (writes.join("").length >= totalLength) { delivered = true; break; }
  }
  assert.ok(delivered, "wrapper delivery completed");
  if (finalTick) t.mock.timers.tick(60);
}

test("delivery that observes OSC 3008 sends a standalone submit Enter (issue #3676)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { pty, writes } = makePty();
  const job = startPtyJob(pty, COMMAND, {
    shellKind: "posix", probeLiveShell: true, timeoutMs: 5000,
  });
  await driveDelivery(t, pty, writes, job.marker, { osc: OSC_3008 });
  assert.equal(writes[writes.length - 1], "\n", "a standalone Enter is written after the noisy delivery");
  assert.ok(writes[writes.length - 2].endsWith("\n"), "payload batch still ends with its own newline");
  pty.emit("data", `${job.marker}_S\nout\n${job.marker}_E:0\n`);
  assert.equal((await job.resultPromise).exitCode, 0);
  pty.emit("close");
  t.mock.timers.reset();
});

test("delivery without OSC 3008 noise does not gain an extra standalone Enter", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { pty, writes } = makePty();
  const job = startPtyJob(pty, COMMAND, {
    shellKind: "posix", probeLiveShell: true, timeoutMs: 5000,
  });
  await driveDelivery(t, pty, writes, job.marker, { osc: null });
  const payload = writes[writes.length - 1];
  assert.notEqual(payload, "\n", "no standalone Enter is written on quiet delivery");
  assert.ok(payload.endsWith("\n"), "wrapper payload still ends with its own newline");
  pty.emit("data", `${job.marker}_S\nout\n${job.marker}_E:0\n`);
  assert.equal((await job.resultPromise).exitCode, 0);
  pty.emit("close");
  t.mock.timers.reset();
});

test("decorative title OSC noise does not trigger the standalone Enter", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { pty, writes } = makePty();
  const job = startPtyJob(pty, COMMAND, {
    shellKind: "posix", probeLiveShell: true, timeoutMs: 5000,
  });
  await driveDelivery(t, pty, writes, job.marker, { osc: "\x1b]0;user@host: /tmp\x07" });
  assert.notEqual(writes[writes.length - 1], "\n", "title-only noise must not add a standalone Enter");
  pty.emit("data", `${job.marker}_S\nout\n${job.marker}_E:0\n`);
  assert.equal((await job.resultPromise).exitCode, 0);
  pty.emit("close");
  t.mock.timers.reset();
});

test("start marker arriving during the recovery delay suppresses the extra Enter", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { pty, writes } = makePty();
  const job = startPtyJob(pty, COMMAND, {
    shellKind: "posix", probeLiveShell: true, timeoutMs: 5000,
  });
  // Skip the final tick so the recovery Enter is still pending when the marker
  // arrives; it must then be withheld instead of reaching the command's stdin.
  await driveDelivery(t, pty, writes, job.marker, { osc: OSC_3008, finalTick: false });
  pty.emit("data", `${job.marker}_S\nout\n${job.marker}_E:0\n`);
  assert.ok(writes[writes.length - 1].length > 1, "no standalone Enter was written after foundStart");
  assert.equal((await job.resultPromise).exitCode, 0);
  pty.emit("close");
  t.mock.timers.reset();
});

test("OSC 3008 split across PTY chunks still triggers the standalone Enter", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { pty, writes } = makePty();
  const job = startPtyJob(pty, COMMAND, {
    shellKind: "posix", probeLiveShell: true, timeoutMs: 5000,
  });
  const totalLength = expectedDeliveryLength(job.marker);
  t.mock.timers.tick(30);
  pty.emit("data", `${job.marker}_P:sh\n${job.marker}_Q`);
  let delivered = false;
  const half = Math.ceil(OSC_3008.length / 2);
  for (let i = 0; i < 4000; i += 1) {
    t.mock.timers.tick(30);
    if (i % 4 === 0) pty.emit("data", OSC_3008.slice(0, half));
    if (i % 4 === 1) pty.emit("data", OSC_3008.slice(half));
    if (writes.join("").length >= totalLength) { delivered = true; break; }
  }
  assert.ok(delivered, "wrapper delivery completed");
  t.mock.timers.tick(60);
  assert.equal(writes[writes.length - 1], "\n", "a split OSC 3008 sequence still latches the flag");
  pty.emit("data", `${job.marker}_S\nout\n${job.marker}_E:0\n`);
  assert.equal((await job.resultPromise).exitCode, 0);
  pty.emit("close");
  t.mock.timers.reset();
});

test("OSC 3008 split across three PTY chunks still triggers the standalone Enter", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { pty, writes } = makePty();
  const job = startPtyJob(pty, COMMAND, {
    shellKind: "posix", probeLiveShell: true, timeoutMs: 5000,
  });
  const totalLength = expectedDeliveryLength(job.marker);
  t.mock.timers.tick(30);
  pty.emit("data", `${job.marker}_P:sh\n${job.marker}_Q`);
  let delivered = false;
  // "\x1b]", "30" and "08;..." — the constant "\x1b]3008;" prefix itself
  // spans three data callbacks; the retained suffix must survive every hop.
  const three = [OSC_3008.slice(0, 2), OSC_3008.slice(2, 4), OSC_3008.slice(4)];
  for (let i = 0; i < 4000; i += 1) {
    t.mock.timers.tick(30);
    if (i % 6 === 0) pty.emit("data", three[0]);
    if (i % 6 === 1) pty.emit("data", three[1]);
    if (i % 6 === 2) pty.emit("data", three[2]);
    if (writes.join("").length >= totalLength) { delivered = true; break; }
  }
  assert.ok(delivered, "wrapper delivery completed");
  // Stop emitting: the first quiet recovery window (after the chunk that
  // landed alongside delivery completion is drained) must send the Enter.
  let enterSent = false;
  for (let i = 0; i < 10 && !enterSent; i += 1) {
    t.mock.timers.tick(30);
    enterSent = writes[writes.length - 1] === "\n";
  }
  assert.ok(enterSent, "a three-chunk split OSC 3008 sequence still latches the flag");
  pty.emit("data", `${job.marker}_S\nout\n${job.marker}_E:0\n`);
  assert.equal((await job.resultPromise).exitCode, 0);
  pty.emit("close");
  t.mock.timers.reset();
});

test("PTY output during the recovery window postpones the standalone Enter", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { pty, writes } = makePty();
  const job = startPtyJob(pty, COMMAND, {
    shellKind: "posix", probeLiveShell: true, timeoutMs: 5000,
  });
  await driveDelivery(t, pty, writes, job.marker, { osc: OSC_3008, finalTick: false });
  // Output keeps flowing after the payload finished (echo of the submit /
  // further OSC chunks): the recovery must not fire while it streams in.
  pty.emit("data", OSC_3008);
  t.mock.timers.tick(30);
  assert.notEqual(writes[writes.length - 1], "\n", "output in flight postpones the Enter");
  // One full quiet pacing window without any PTY output: the submission is
  // not resolving on its own, so the recovery Enter is justified.
  t.mock.timers.tick(30);
  assert.equal(writes[writes.length - 1], "\n", "quiet window sends the recovery Enter");
  pty.emit("data", `${job.marker}_S\nout\n${job.marker}_E:0\n`);
  assert.equal((await job.resultPromise).exitCode, 0);
  pty.emit("close");
  t.mock.timers.reset();
});

test("a continuously chatty PTY cannot postpone the recovery Enter past the cap", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { pty, writes } = makePty();
  const job = startPtyJob(pty, COMMAND, {
    shellKind: "posix", probeLiveShell: true, timeoutMs: 5000,
  });
  await driveDelivery(t, pty, writes, job.marker, { osc: OSC_3008, finalTick: false });
  // Output arriving during every recovery window: the cap (~1s) must still
  // submit the payload eventually.
  let enterSent = false;
  for (let i = 0; i < 60 && !enterSent; i += 1) {
    t.mock.timers.tick(15);
    pty.emit("data", OSC_3008);
    t.mock.timers.tick(15);
    enterSent = writes[writes.length - 1] === "\n";
  }
  assert.ok(enterSent, "the recovery Enter is sent despite ongoing PTY output");
  pty.emit("data", `${job.marker}_S\nout\n${job.marker}_E:0\n`);
  assert.equal((await job.resultPromise).exitCode, 0);
  pty.emit("close");
  t.mock.timers.reset();
});
