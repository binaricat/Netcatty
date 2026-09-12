"use strict";

const { parentPort, workerData } = require("node:worker_threads");
const { runCursorTurnInProcess } = require("./cursorDriver.cjs");

const controller = new AbortController();
const emitter = {};
for (const method of [
  "text", "reasoning", "reasoningEnd", "toolCall", "toolResult",
  "sessionId", "emitDone", "emitError",
]) {
  emitter[method] = (...args) => parentPort.postMessage({ type: "event", method, args });
}

parentPort.on("message", (message) => {
  if (message?.type === "abort") controller.abort();
});

async function main() {
  try {
    const result = await runCursorTurnInProcess({
      ...workerData,
      emitter,
      signal: controller.signal,
    });
    parentPort.postMessage({ type: "result", result });
  } catch (error) {
    parentPort.postMessage({ type: "error", message: error?.message || String(error) });
  } finally {
    parentPort.close();
  }
}

void main();
