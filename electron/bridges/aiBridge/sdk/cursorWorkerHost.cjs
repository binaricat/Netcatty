"use strict";

const path = require("node:path");
const { Worker } = require("node:worker_threads");

// Each turn gets its own environment and SDK instance. A stalled SDK network
// request cannot retain a main-process environment lock or block another chat.
function runCursorWorkerTurn({ emitter, signal, ...params }, WorkerImpl = Worker) {
  let sessionId = params.resumeSessionId || null;
  if (signal?.aborted) return Promise.resolve({ sessionId });
  return new Promise((resolve) => {
    let worker;
    let settled = false;
    let stopTimer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const terminate = () => {
      clearTimeout(stopTimer);
      void worker.terminate().catch(() => {});
    };
    const onAbort = () => {
      worker.postMessage({ type: "abort" });
      // Allow run.cancel()/agent.close() first, then contain a stuck startup.
      stopTimer = setTimeout(terminate, 1000);
      finish({ sessionId });
    };
    try {
      worker = new WorkerImpl(path.join(__dirname, "cursorTurnWorker.cjs"), {
        env: { ...process.env, ...params.runtimeEnv },
        workerData: params,
      });
    } catch (error) {
      emitter.emitError(error?.message || String(error));
      finish({ sessionId });
      return;
    }
    worker.on("message", (message) => {
      if (message?.type === "event") {
        if (settled) return;
        if (message.method === "sessionId") sessionId = message.args[0];
        const handler = emitter[message.method];
        if (typeof handler === "function") handler(...message.args);
      } else if (message?.type === "result" || message?.type === "error") {
        if (!settled && message.type === "error") emitter.emitError(message.message);
        finish(message.result || { sessionId });
        terminate();
      }
    });
    worker.once("error", (error) => {
      if (!settled) emitter.emitError(error.message);
      finish({ sessionId });
      terminate();
    });
    worker.once("exit", (code) => {
      clearTimeout(stopTimer);
      if (!settled) emitter.emitError(`Cursor worker exited before completing (code ${code}).`);
      finish({ sessionId });
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

module.exports = { runCursorWorkerTurn };
