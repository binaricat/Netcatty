"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Duplex } = require("node:stream");
const { startPtyJob } = require("./ptyExec.cjs");
const { buildLiveShellProbe } = require("./liveShellProbe.cjs");
const {
  clearSessionFlowState,
  setRendererFlowPaused,
} = require("../terminalFlowAck.cjs");

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

test("startup timeout recovers paused probe output after the job finishes without writing the command", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
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
      onInterrupt: () => clearSessionFlowState(session),
    });
    const probeLength = 2 + buildLiveShellProbe(job.marker).length;
    for (let tick = 0; tick < 100 && writes.join("").length < probeLength; tick += 1) {
      t.mock.timers.tick(30);
    }
    assert.equal(writes.join("").length, probeLength, "the shell probe must drain before timeout");
    const probeWrites = [...writes];
    const probeReply = `${job.marker}_P:sh\n${job.marker}_Q`;
    pty.push(probeReply);
    await nextTick();
    assert.equal(pty.isPaused(), true);
    assert.equal(displayedOutput, "");
    assert.equal(job.getSnapshot().foundStart, false);
    assert.equal(job.getSnapshot().stdout, "");

    t.mock.timers.tick(30000);
    const result = await job.resultPromise;
    await nextTick();

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, -1);
    assert.equal(result.error, "Background job startup timed out — start marker never arrived");
    assert.equal(session.flowState.appliedPause, false);
    assert.equal(session.flowState.rendererPaused, false);
    assert.equal(pty.isPaused(), false);
    assert.equal(displayedOutput, probeReply);
    assert.deepEqual(writes, [...probeWrites, "\x03"], "recovery must not launch the timed-out command");
    assert.equal(job.getSnapshot().foundStart, false);
  } finally {
    clearSessionFlowState(session);
    pty.destroy();
  }
});
