"use strict";

const {
  classifyProcessError,
} = require("../bridges/processErrorGuards.cjs");

/**
 * Terminal worker process error guards.
 *
 * Every terminal, SSH, SFTP, and port-forwarding session shares this
 * utilityProcess, so a single stray async error must never let Node's default
 * `uncaughtException` behavior exit the worker with code 1 — that would
 * disconnect every session at once. This mirrors the main-process guards
 * (`bridges/processErrorGuards.cjs`), but worker policy is stricter: once the
 * worker is running, every process-level error is suppressed. The error is
 * still reported (see `report`) so the main process can record it in the
 * crash log for later diagnosis.
 *
 * Startup errors are NOT suppressed: until `options.isRuntimeStarted()`
 * returns true, every error is fatal and re-thrown so the worker exits.
 * An IPC-retained utilityProcess that swallowed a startup failure
 * would otherwise stay alive without a message listener, leaving every
 * manager request pending forever instead of rejecting/replacing it.
 *
 * Benign stream teardown (EPIPE / ERR_STREAM_DESTROYED) is classified as
 * `ignore` and must NOT call `logError`/`console.error`: writing diagnostics
 * through an already-broken console pipe re-enters this handler and busy-
 * loops (see #4136). A `consoleBroken` latch also no-ops the default
 * console.error path after stdout/stderr emit `error`.
 */
function installTerminalWorkerErrorGuards(options = {}) {
  const processObject = options.processObject || process;
  if (!processObject?.on || !processObject?.removeListener) {
    throw new Error("A process-like EventEmitter is required");
  }
  const report = typeof options.report === "function" ? options.report : () => {};
  let consoleBroken = false;
  const latchConsoleBroken = () => {
    consoleBroken = true;
  };
  for (const stream of [processObject.stdout, processObject.stderr]) {
    if (stream && typeof stream.on === "function") {
      stream.on("error", latchConsoleBroken);
    }
  }
  const logError = typeof options.logError === "function"
    ? options.logError
    : (...args) => {
      if (consoleBroken) return;
      try {
        console.error(...args);
      } catch {
        // Sync write failures must not escalate; async EPIPE arrives via
        // stream `error` and is covered by the consoleBroken latch above.
        consoleBroken = true;
      }
    };
  // Default to runtime semantics only when a caller provides no startup
  // signal; process.cjs always passes one.
  const isRuntimeStarted = typeof options.isRuntimeStarted === "function"
    ? options.isRuntimeStarted
    : () => true;

  const labelFor = (origin) => (
    origin === "unhandledRejection" ? "unhandled rejection" : "uncaught exception"
  );

  const makeHandler = (origin) => (err) => {
    // An error already marked fatal (e.g. a startup unhandled rejection that
    // threw into the uncaughtException path) must exit, not be re-classified.
    if (err?.__terminalWorkerFatalStartupError) {
      throw err;
    }
    // The shared classifier ignores some stream/network errors regardless of
    // startup state. Those are recoverable only after this worker can receive
    // requests; swallowing them during initialization leaves a live dead end.
    const decision = isRuntimeStarted()
      ? classifyProcessError(err, { runtimeStarted: true, origin })
      : { action: "fatal", reason: "startup error before worker became usable" };
    if (decision.action === "fatal") {
      logError(
        `Terminal worker ${labelFor(origin)} (${decision.reason}); exiting:`,
        err,
      );
      try {
        report(origin, err, decision);
      } catch {
        // Error reporting must never be able to escalate into a worker crash.
      }
      // Re-throw so Node's default behavior terminates the worker; the
      // manager observes the exit and can reject or replace the worker.
      const fatal = err instanceof Error ? err : new Error(String(err));
      fatal.__terminalWorkerFatalStartupError = true;
      throw fatal;
    }
    // Never log through a stream that just failed: ignore-classified EPIPE
    // would otherwise call console.error → EPIPE → uncaughtException → loop.
    if (decision.action === "ignore") {
      try {
        report(origin, err, decision);
      } catch {
        // Error reporting must never be able to escalate into a worker crash.
      }
      return;
    }
    logError(
      `Suppressed terminal worker ${labelFor(origin)} (${decision.reason}):`,
      err,
    );
    try {
      report(origin, err, decision);
    } catch {
      // Error reporting must never be able to escalate into a worker crash.
    }
  };

  const handleUncaughtException = makeHandler("uncaughtException");
  const handleUnhandledRejection = makeHandler("unhandledRejection");

  processObject.on("uncaughtException", handleUncaughtException);
  processObject.on("unhandledRejection", handleUnhandledRejection);

  return () => {
    processObject.removeListener("uncaughtException", handleUncaughtException);
    processObject.removeListener("unhandledRejection", handleUnhandledRejection);
    for (const stream of [processObject.stdout, processObject.stderr]) {
      if (stream && typeof stream.removeListener === "function") {
        stream.removeListener("error", latchConsoleBroken);
      }
    }
  };
}

module.exports = {
  installTerminalWorkerErrorGuards,
};
