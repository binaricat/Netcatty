"use strict";

const { runCursorTurnInProcess } = require("./cursorDriver.cjs");

const controller = new AbortController();
const emitter = {};
for (const method of [
  "text", "reasoning", "reasoningEnd", "toolCall", "toolResult",
  "sessionId", "emitDone", "emitError",
]) {
  emitter[method] = (...args) => process.parentPort.postMessage({ type: "event", method, args });
}

let started = false;
process.parentPort.on("message", ({ data }) => {
  if (data?.type === "abort") controller.abort();
  if (data?.type === "start" && !started) {
    started = true;
    void runCursorTurnInProcess({ ...data.params, emitter, signal: controller.signal }).then(
      (result) => process.parentPort.postMessage({ type: "result", result }),
      (error) => process.parentPort.postMessage({ type: "error", message: error?.message || String(error) }),
    );
  }
});
