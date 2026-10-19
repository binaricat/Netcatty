"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Duplex } = require("node:stream");
const { startPtyJob } = require("./ptyExec.cjs");
const { buildLiveShellProbe } = require("./liveShellProbe.cjs");
const {
  createJobStartupDiag,
  emitJobDiag,
  isJobDiagEnabled,
} = require("./jobStartupDiagnostics.cjs");
const { getSessionSnapshot } = require("../terminalInterruptDiagnostics.cjs");
const {
  clearSessionFlowState,
  setRendererFlowPaused,
} = require("../terminalFlowAck.cjs");

const nextTick = () => new Promise((resolve) => setImmediate(resolve));
const JOB_DIAG_PREFIX = "[Netcatty JobDiag] ";

function captureJobDiagEvents() {
  const events = [];
  const original = console.info;
  console.info = (...args) => {
    const line = args.join(" ");
    if (typeof line === "string" && line.startsWith(JOB_DIAG_PREFIX)) {
      try {
        events.push(JSON.parse(line.slice(JOB_DIAG_PREFIX.length)));
        return;
      } catch {
        // Fall through to the original logger on malformed lines.
      }
    }
    original(...args);
  };
  return {
    events,
    restore() {
      console.info = original;
    },
  };
}

function withJobDiagEnv(t, key = "NETCATTY_JOB_DIAG") {
  process.env[key] = "1";
  t.after(() => {
    delete process.env[key];
    delete process.env.NETCATTY_JOB_DIAG;
    delete process.env.NETCATTY_TERMINAL_DEBUG;
  });
}

function makeQuietPty() {
  const writes = [];
  return {
    pty: new Duplex({
      read() {},
      write(data, _encoding, callback) {
        writes.push(data.toString());
        callback();
      },
    }),
    writes,
  };
}

test("job diagnostics gate defaults to off and NETCATTY_TERMINAL_DEBUG also lights it", async (t) => {
  delete process.env.NETCATTY_JOB_DIAG;
  delete process.env.NETCATTY_TERMINAL_DEBUG;
  assert.equal(isJobDiagEnabled(), false);

  const capture = captureJobDiagEvents();
  emitJobDiag("job-start-accepted", { sessionId: "s1", jobId: "j1" });
  assert.equal(capture.events.length, 0);

  process.env.NETCATTY_TERMINAL_DEBUG = "1";
  assert.equal(isJobDiagEnabled(), true);
  emitJobDiag("route-removed", { sessionId: "s1", jobId: "j1" });
  capture.restore();

  assert.equal(capture.events.length, 1);
  assert.equal(capture.events[0].event, "route-removed");
  assert.equal(capture.events[0].sessionId, "s1");
  assert.equal(capture.events[0].jobId, "j1");
  assert.ok(Number.isFinite(capture.events[0].at));
});

test("emitJobDiag always keys payloads by sessionId and jobId", async (t) => {
  withJobDiagEnv(t);
  const capture = captureJobDiagEvents();
  emitJobDiag("job-stop-miss", { jobId: "job-42", op: "stop" });
  capture.restore();

  assert.equal(capture.events.length, 1);
  const payload = capture.events[0];
  assert.equal(payload.event, "job-stop-miss");
  assert.equal(payload.jobId, "job-42");
  assert.equal(payload.sessionId, null);
  assert.equal(payload.op, "stop");
  assert.ok(Number.isFinite(payload.at));
});

test("startup timeout emits the #3443 checkpoint timeline keyed by sessionId+jobId", async (t) => {
  withJobDiagEnv(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const capture = captureJobDiagEvents();
  const writes = [];
  const pty = new Duplex({
    read() {},
    write(data, _encoding, callback) {
      writes.push(data.toString());
      callback();
    },
  });
  const session = { protocol: "ssh", stream: pty };
  let displayedOutput = "";
  pty.on("data", (data) => { displayedOutput += data.toString(); });
  await nextTick();
  setRendererFlowPaused(session, true);

  try {
    const job = startPtyJob(pty, "echo SHOULD_NOT_RUN", {
      shellKind: "posix",
      probeLiveShell: true,
      timeoutMs: 3600000,
      maxBufferedChars: 1024,
      sessionId: "sess-3443",
      jobId: "job-3443",
      chatSessionId: "chat-3443",
      diagnosticsSession: session,
      onInterrupt: () => clearSessionFlowState(session),
    });
    const probeLength = 2 + buildLiveShellProbe(job.marker).length;
    for (let tick = 0; tick < 100 && writes.join("").length < probeLength; tick += 1) {
      t.mock.timers.tick(30);
    }
    assert.equal(writes.join("").length, probeLength, "the shell probe must drain before timeout");
    const probeWrites = [...writes];
    const probeReply = `${job.marker}_P:sh\n${job.marker}_Q`;
    // The paused renderer swallows the probe reply: it is buffered by flow
    // control and never delivered to onData, the exact #3443 stall shape.
    pty.push(probeReply);
    await nextTick();
    assert.equal(pty.isPaused(), true);
    assert.equal(job.getSnapshot().foundStart, false);

    t.mock.timers.tick(30000);
    const result = await job.resultPromise;
    await nextTick();
    capture.restore();

    assert.equal(result.error, "Background job startup timed out — start marker never arrived");

    const events = capture.events;
    for (const event of events) {
      assert.equal(event.sessionId, "sess-3443", "every payload must carry sessionId");
      assert.equal(event.jobId, "job-3443", "every payload must carry jobId");
      assert.equal(event.chatSessionId, "chat-3443");
      assert.ok(Number.isFinite(event.at));
      assert.ok(Number.isFinite(event.sinceStartMs));
    }
    const names = events.map((event) => event.event);
    assert.ok(names.includes("job-start-accepted"));
    assert.ok(names.includes("probe-write"));
    assert.ok(names.includes("startup-timeout-fired"));
    assert.ok(names.includes("send-interrupt"));
    assert.ok(names.includes("interrupt-callback-invoked"));
    assert.equal(names.includes("probe-output-arrived"), false, "the paused stream never delivered the reply");
    assert.equal(names.includes("probe-reply-parsed"), false);
    assert.equal(names.includes("cmd-write"), false, "the timed-out command must not be typed");
    const probeWrite = events.find((event) => event.event === "probe-write");
    assert.equal(probeWrite.bytes, Buffer.byteLength(buildLiveShellProbe(job.marker)));
    assert.equal(Object.hasOwn(probeWrite, "probeBytes"), false,
      "outbound bytes must not look like received probe evidence");

    const accepted = events.find((event) => event.event === "job-start-accepted");
    assert.equal(accepted.outputMode, "background");

    const timeout = events.find((event) => event.event === "startup-timeout-fired");
    assert.equal(timeout.elapsedMs, 30000);
    assert.equal(timeout.probeOutputSeen, false);
    assert.equal(timeout.outputChunks, 0);
    assert.equal(timeout.session.flowState.rendererPaused, true);
    assert.equal(timeout.session.flowState.appliedPause, true);
    assert.equal(timeout.session.stream.isPaused, true);
    assert.equal(timeout.probeBytes, 0, "no probe bytes were delivered to the job");
    assert.equal(timeout.session.stream.readableLength, Buffer.byteLength(probeReply),
      "the reply is still queued in the paused stream");

    const sendInterrupt = events.find((event) => event.event === "send-interrupt");
    assert.equal(sendInterrupt.trigger, "startup-timeout");
    assert.equal(sendInterrupt.etxWritten, true);

    // The maintainer's key finding (#3443): recovery runs after the job has
    // already finished - observable here as finishedAtCallback === true.
    const invoked = events.find((event) => event.event === "interrupt-callback-invoked");
    assert.equal(invoked.trigger, "startup-timeout");
    assert.equal(invoked.finishedAtCallback, true);

    // Behavior is unchanged: recovery resumes the paused session.
    assert.equal(session.flowState.appliedPause, false);
    assert.equal(pty.isPaused(), false);
    assert.equal(displayedOutput, probeReply);
    assert.deepEqual(writes, [...probeWrites, "\x03"], "recovery must not launch the timed-out command");
  } finally {
    capture.restore();
    clearSessionFlowState(session);
    pty.destroy();
  }
});

test("interrupt-callback-skipped fires when no recovery callback is wired", async (t) => {
  withJobDiagEnv(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const capture = captureJobDiagEvents();
  const { pty, writes } = makeQuietPty();
  const session = { protocol: "ssh", stream: pty };

  try {
    const controller = new AbortController();
    const job = startPtyJob(pty, "echo x", {
      shellKind: "posix",
      timeoutMs: 60000,
      sessionId: "sess-skip",
      jobId: "job-skip",
      diagnosticsSession: session,
      abortSignal: controller.signal,
    });
    controller.abort();
    t.mock.timers.tick(2000);
    const result = await job.resultPromise;
    capture.restore();

    assert.equal(result.error, "Cancelled");
    const skipped = capture.events.filter((event) => event.event === "interrupt-callback-skipped");
    assert.ok(skipped.length >= 1);
    assert.equal(skipped[0].reason, "no-callback");
    assert.equal(skipped[0].sessionId, "sess-skip");
    assert.equal(skipped[0].jobId, "job-skip");
    const cancels = capture.events.filter(
      (event) => event.event === "send-interrupt" && event.trigger === "cancel",
    );
    assert.equal(cancels.length, 1);
    assert.ok(writes.includes("\x03"), "ETX still written with diagnostics off the behavior path");
  } finally {
    capture.restore();
    pty.destroy();
  }
});

test("successful startup emits probe reply, parse, and start-marker checkpoints", async (t) => {
  withJobDiagEnv(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const capture = captureJobDiagEvents();
  const writes = [];
  const pty = new Duplex({
    read() {},
    write(data, _encoding, callback) {
      writes.push(data.toString());
      callback();
    },
  });
  const session = { protocol: "ssh", stream: pty };

  try {
    const job = startPtyJob(pty, "echo done", {
      shellKind: "posix",
      probeLiveShell: true,
      timeoutMs: 3600000,
      maxBufferedChars: 1024,
      sessionId: "sess-ok",
      jobId: "job-ok",
      diagnosticsSession: session,
      onInterrupt: () => clearSessionFlowState(session),
    });
    const probeLength = 2 + buildLiveShellProbe(job.marker).length;
    for (let tick = 0; tick < 100 && writes.join("").length < probeLength; tick += 1) {
      t.mock.timers.tick(30);
    }
    pty.push(`${job.marker}_P:sh\n${job.marker}_Q`);
    await nextTick();
    for (let tick = 0; tick < 100 && !job.getSnapshot().foundStart; tick += 1) {
      t.mock.timers.tick(30);
    }
    pty.push(`${job.marker}_S\nhello\n${job.marker}_E:0\n`);
    await nextTick();
    const result = await job.resultPromise;
    await nextTick();
    capture.restore();

    assert.equal(result.ok, true);
    const names = capture.events.map((event) => event.event);
    assert.ok(names.includes("probe-write"));
    assert.ok(names.includes("probe-output-arrived"));
    assert.ok(names.includes("probe-reply-parsed"));
    assert.ok(names.includes("cmd-write"));
    assert.ok(names.includes("start-marker-matched"));
    const parsed = capture.events.find((event) => event.event === "probe-reply-parsed");
    assert.equal(parsed.shellKind, "posix", "parseLiveShellProbe normalizes sh to posix");
    const marker = capture.events.find((event) => event.event === "start-marker-matched");
    assert.ok(marker.preStartChars > 0);
  } finally {
    capture.restore();
    clearSessionFlowState(session);
    pty.destroy();
  }
});

test("startup timeout reports the bytes of a partial probe reply", async (t) => {
  withJobDiagEnv(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const capture = captureJobDiagEvents();
  const { pty, writes } = makeQuietPty();
  try {
    const job = startPtyJob(pty, "echo SHOULD_NOT_RUN", {
      shellKind: "posix",
      probeLiveShell: true,
      timeoutMs: 3600000,
      maxBufferedChars: 1024,
      sessionId: "sess-partial",
      jobId: "job-partial",
    });
    const probeLength = 2 + buildLiveShellProbe(job.marker).length;
    for (let tick = 0; tick < 100 && writes.join("").length < probeLength; tick += 1) {
      t.mock.timers.tick(30);
      await nextTick();
    }
    const partialReply = "partial reply \u00e9\u00e9 without the probe marker";
    pty.push(partialReply);
    await nextTick();
    t.mock.timers.tick(30000);
    await job.resultPromise;
    await nextTick();
    capture.restore();
    const timeout = capture.events.find((event) => event.event === "startup-timeout-fired");
    assert.equal(timeout.probeOutputSeen, true);
    assert.equal(timeout.probeBytes, Buffer.byteLength(partialReply));
    // The arrival event reports raw bytes too, not UTF-16 code units.
    const arrived = capture.events.find((event) => event.event === "probe-output-arrived");
    assert.equal(arrived.probeBytes, Buffer.byteLength(partialReply));
  } finally {
    capture.restore();
    pty.destroy();
  }
});

test("startup timeout counts raw probe bytes, including an incomplete UTF-8 prefix", async (t) => {
  withJobDiagEnv(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const capture = captureJobDiagEvents();
  const { pty, writes } = makeQuietPty();
  try {
    const job = startPtyJob(pty, "echo SHOULD_NOT_RUN", {
      shellKind: "posix",
      probeLiveShell: true,
      timeoutMs: 3600000,
      maxBufferedChars: 1024,
      sessionId: "sess-utf8",
      jobId: "job-utf8",
    });
    const probeLength = 2 + buildLiveShellProbe(job.marker).length;
    for (let tick = 0; tick < 100 && writes.join("").length < probeLength; tick += 1) {
      t.mock.timers.tick(30);
      await nextTick();
    }
    // Two bytes of a three-byte character: the decoder yields no text yet, but
    // the bytes did arrive and belong in the timeout evidence.
    pty.push(Buffer.from([0xe2, 0x82]));
    await nextTick();
    const arrived = capture.events.find((event) => event.event === "probe-output-arrived");
    assert.equal(arrived.probeBytes, 2, "raw arrival must be recorded before any decoded text");
    t.mock.timers.tick(30000);
    await job.resultPromise;
    await nextTick();
    capture.restore();
    const timeout = capture.events.find((event) => event.event === "startup-timeout-fired");
    assert.equal(timeout.probeBytes, 2);
    assert.equal(timeout.probeOutputSeen, true);
    assert.equal(timeout.outputChunks, 1);
    assert.equal(timeout.outputChars, 0);
  } finally {
    capture.restore();
    pty.destroy();
  }
});


test("worker diagnostics use the existing IPC channel only when enabled", (t) => {
  const previousPort = process.parentPort;
  const messages = [];
  process.parentPort = { postMessage(message) { messages.push(message); } };
  t.after(() => {
    if (previousPort === undefined) delete process.parentPort;
    else process.parentPort = previousPort;
    delete process.env.NETCATTY_JOB_DIAG;
    delete process.env.NETCATTY_TERMINAL_DEBUG;
  });
  t.mock.method(console, "info", () => assert.fail("worker must not duplicate console output"));
  delete process.env.NETCATTY_JOB_DIAG;
  delete process.env.NETCATTY_TERMINAL_DEBUG;
  const job = createJobStartupDiag({ sessionId: "s-ipc", jobId: "j-ipc" });
  emitJobDiag("route-removed");
  job.emit("probe-write");
  assert.deepEqual(messages, []);

  process.env.NETCATTY_JOB_DIAG = "1";
  emitJobDiag("route-removed", { sessionId: "s-ipc", jobId: "j-ipc" });
  job.emit("probe-write", { bytes: 12 });
  const events = messages.map((message) => {
    assert.equal(message.kind, "job-diagnostic");
    return JSON.parse(message.line.slice(JOB_DIAG_PREFIX.length));
  });
  assert.deepEqual(events.map(({ event, sessionId, jobId }) => [event, sessionId, jobId]), [
    ["route-removed", "s-ipc", "j-ipc"], ["probe-write", "s-ipc", "j-ipc"],
  ]);
  process.parentPort.postMessage = () => { throw new Error("closed port"); };
  assert.doesNotThrow(() => emitJobDiag("route-removed"));
  assert.doesNotThrow(() => job.emit("probe-write"));
});

test("paused snapshots distinguish queued reply bytes without consuming them", () => {
  const empty = makeQuietPty().pty;
  const buffered = makeQuietPty().pty;
  try {
    empty.pause();
    buffered.pause();
    buffered.push(Buffer.from("queued probe reply"));
    const emptyState = getSessionSnapshot({ stream: empty }).stream;
    const bufferedState = getSessionSnapshot({ stream: buffered }).stream;
    assert.equal(emptyState.isPaused, true);
    assert.equal(bufferedState.isPaused, true);
    assert.equal(emptyState.readableLength, 0);
    assert.equal(bufferedState.readableLength, Buffer.byteLength("queued probe reply"));
    assert.equal(buffered.readableLength, bufferedState.readableLength);
    assert.equal(buffered.isPaused(), true);
  } finally {
    empty.destroy();
    buffered.destroy();
  }
});
