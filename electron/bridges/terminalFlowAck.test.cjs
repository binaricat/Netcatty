const test = require("node:test");
const assert = require("node:assert/strict");

const sharedConstants = require("../../infrastructure/config/terminalFlowConstants.cjs");
const {
  FLOW_HIGH_WATER_MARK,
  FLOW_LOW_WATER_MARK,
  clearSessionFlowState,
  setBufferedOutputBytes,
  setRendererFlowPaused,
  shouldAcceptSessionOutput,
  shouldProcessSessionOutput,
  trackAck,
  trackEmitted,
} = require("./terminalFlowAck.cjs");

function makeSession() {
  const calls = [];
  return {
    stream: {
      pause() {
        calls.push("pause");
      },
      resume() {
        calls.push("resume");
      },
    },
    _calls: calls,
  };
}

test("main-process watermarks match shared terminalFlowConstants.cjs", () => {
  assert.equal(FLOW_HIGH_WATER_MARK, sharedConstants.FLOW_HIGH_WATER_MARK);
  assert.equal(FLOW_LOW_WATER_MARK, sharedConstants.FLOW_LOW_WATER_MARK);
});

test("shouldAcceptSessionOutput returns false when flow pause is applied", () => {
  const session = makeSession();
  assert.equal(shouldAcceptSessionOutput(session), true);
  trackEmitted(session, FLOW_HIGH_WATER_MARK);
  assert.equal(shouldAcceptSessionOutput(session), false);
  trackAck(session, FLOW_HIGH_WATER_MARK);
  assert.equal(shouldAcceptSessionOutput(session), true);
});

test("shouldProcessSessionOutput keeps processing paused output for buffering", () => {
  const session = makeSession();
  trackEmitted(session, FLOW_HIGH_WATER_MARK);

  assert.equal(shouldProcessSessionOutput(session), true);
  assert.equal(shouldProcessSessionOutput(session, { isActive: () => false }), true);
  assert.equal(shouldProcessSessionOutput(session, { isActive: () => true }), true);
});

test("trackEmitted pauses once when unacked bytes cross the high watermark", () => {
  const session = makeSession();
  trackEmitted(session, FLOW_HIGH_WATER_MARK);
  assert.deepEqual(session._calls, ["pause"]);
  trackEmitted(session, 1024);
  assert.deepEqual(session._calls, ["pause"]);
});

test("trackAck resumes after draining to the low watermark", () => {
  const session = makeSession();
  trackEmitted(session, FLOW_HIGH_WATER_MARK + FLOW_LOW_WATER_MARK);
  trackAck(session, FLOW_LOW_WATER_MARK);
  assert.deepEqual(session._calls, ["pause"]);
  trackAck(session, FLOW_HIGH_WATER_MARK);
  assert.deepEqual(session._calls, ["pause", "resume"]);
});

test("flow diagnostics remember the renderer session id", () => {
  const session = makeSession();
  trackEmitted(session, 1024, "session-1");
  trackAck(session, 512, "session-1");

  assert.equal(session.flowState.sessionId, "session-1");
});

test("renderer pause flag keeps the stream paused until cleared", () => {
  const session = makeSession();
  trackEmitted(session, FLOW_HIGH_WATER_MARK);
  setRendererFlowPaused(session, true);
  trackAck(session, FLOW_HIGH_WATER_MARK);
  assert.deepEqual(session._calls, ["pause"]);
  setRendererFlowPaused(session, false);
  assert.deepEqual(session._calls, ["pause", "resume"]);
});

test("buffered output pressure pauses the source while still allowing paced drain", () => {
  const session = makeSession();
  setBufferedOutputBytes(session, FLOW_HIGH_WATER_MARK);

  assert.deepEqual(session._calls, ["pause"]);
  assert.equal(shouldAcceptSessionOutput(session), true);

  setBufferedOutputBytes(session, FLOW_LOW_WATER_MARK + 1);
  assert.deepEqual(session._calls, ["pause"]);

  setBufferedOutputBytes(session, FLOW_LOW_WATER_MARK);
  assert.deepEqual(session._calls, ["pause", "resume"]);
});

test("clearSessionFlowState resumes and resets counters", () => {
  const session = makeSession();
  trackEmitted(session, FLOW_HIGH_WATER_MARK);
  clearSessionFlowState(session);
  assert.deepEqual(session._calls, ["pause", "resume"]);
  assert.equal(session.flowState.unackedBytes, 0);
  assert.equal(session.flowState.bufferedBytes, 0);
  assert.equal(session.flowState.rendererPaused, false);
});
