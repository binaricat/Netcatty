"use strict";

const path = require("node:path");
function createCursorWorker(options) {
  // Native SDK storage can abort its process during forced cleanup. Keep that
  // failure outside Electron main as well as isolating the chat environment.
  return require("electron").utilityProcess.fork(
    path.join(__dirname, "cursorTurnWorker.cjs"), [],
    { ...options, serviceName: "Netcatty Cursor", stdio: "pipe" },
  );
}

// Each turn gets its own environment and SDK instance. A stalled SDK network
// request cannot retain a main-process environment lock or block another chat.
function runCursorWorkerTurn({ emitter, signal, ...params }, createWorker = createCursorWorker) {
  let sessionId = params.resumeSessionId || null;
  if (signal?.aborted) return Promise.resolve({ sessionId });
  return new Promise((resolve) => {
    let worker;
    let settled = false;
    let spawned = false;
    let stopTimer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const terminate = () => {
      clearTimeout(stopTimer);
      worker.kill();
    };
    const onAbort = () => {
      if (spawned) worker.postMessage({ type: "abort" });
      // Allow run.cancel()/agent.close() first, then contain a stuck startup.
      stopTimer = setTimeout(terminate, 1000);
      finish({ sessionId });
    };
    try {
      worker = createWorker({
        env: params.runtimeEnv || process.env,
      });
    } catch (error) {
      emitter.emitError(error?.message || String(error));
      finish({ sessionId });
      return;
    }
    worker.stdout?.resume();
    worker.stderr?.resume();
    worker.once("spawn", () => {
      spawned = true;
      if (settled) terminate();
      else worker.postMessage({ type: "start", params });
    });
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
    worker.once("error", (type, location) => {
      // The third argument is a full Node diagnostic report and can contain
      // credentials from the environment. Keep it out of persisted chat errors.
      const message = type instanceof Error
        ? type.message
        : [type, location].filter(Boolean).join(": ");
      if (!settled) emitter.emitError(message || "Cursor worker failed.");
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
