"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Worker } = require("node:worker_threads");
const { once } = require("node:events");
const { runCursorWorkerTurn } = require("./cursorWorkerHost.cjs");

const fixture = `
const { parentPort, workerData } = require('node:worker_threads');
parentPort.postMessage({ type: 'event', method: 'sessionId', args: [workerData.resumeSessionId] });
parentPort.postMessage({ type: 'event', method: 'text', args: [process.env.NETCATTY_CLI_CHAT_SESSION_ID] });
if (workerData.prompt === 'hang') {
  parentPort.on('message', () => {});
} else {
  parentPort.postMessage({ type: 'event', method: 'emitDone', args: [] });
  parentPort.postMessage({ type: 'result', result: { sessionId: workerData.resumeSessionId } });
}
`;

test("real Cursor workers isolate environments and a cancelled stuck worker cannot block the next turn", async () => {
  const workers = [];
  class FixtureWorker {
    constructor(_filename, options) {
      const worker = new Worker(fixture, { ...options, eval: true });
      workers.push(worker);
      return worker;
    }
  }
  const original = process.env.NETCATTY_CLI_CHAT_SESSION_ID;
  const callsA = [];
  const callsB = [];
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const emitter = (calls, onText = () => {}) => ({
    sessionId: (id) => calls.push(["session", id]),
    text: (text) => { calls.push(["text", text]); onText(); },
    emitDone: () => calls.push(["done"]),
    emitError: (error) => calls.push(["error", error]),
  });
  const controller = new AbortController();
  try {
    const first = runCursorWorkerTurn({
      prompt: "hang", resumeSessionId: "agent-a", signal: controller.signal,
      runtimeEnv: { NETCATTY_CLI_CHAT_SESSION_ID: "chat-a" }, emitter: emitter(callsA, ready),
    }, FixtureWorker);
    await started;
    const exited = once(workers[0], "exit");
    controller.abort();
    assert.deepEqual(await first, { sessionId: "agent-a" });
    const second = await runCursorWorkerTurn({
      prompt: "finish", resumeSessionId: "agent-b",
      runtimeEnv: { NETCATTY_CLI_CHAT_SESSION_ID: "chat-b" }, emitter: emitter(callsB),
    }, FixtureWorker);
    assert.deepEqual(second, { sessionId: "agent-b" });
    assert.deepEqual(callsA, [["session", "agent-a"], ["text", "chat-a"]]);
    assert.deepEqual(callsB, [["session", "agent-b"], ["text", "chat-b"], ["done"]]);
    assert.equal(process.env.NETCATTY_CLI_CHAT_SESSION_ID, original);
    await exited;
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
});

test("an already cancelled Cursor turn never starts a worker", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await runCursorWorkerTurn({ signal: controller.signal, emitter: {}, resumeSessionId: "old" },
    class { constructor() { throw new Error("must not start"); } });
  assert.deepEqual(result, { sessionId: "old" });
});

test("Cursor worker startup errors reach the existing chat error path", async () => {
  const errors = [];
  const result = await runCursorWorkerTurn({ emitter: { emitError: (error) => errors.push(error) } },
    class { constructor() { throw new Error("worker unavailable"); } });
  assert.deepEqual(errors, ["worker unavailable"]);
  assert.deepEqual(result, { sessionId: null });
});
