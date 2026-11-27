"use strict";

const DEFAULT_FORCE_EXIT_MS = 500;
const DEFAULT_PARENT_POLL_INTERVAL_MS = 5000;
const STREAM_DISCONNECT_ERROR_CODES = new Set([
  "EPIPE",
  "ECONNRESET",
  "EOF",
  "ERR_STREAM_DESTROYED",
  "ERR_STREAM_WRITE_AFTER_END",
]);
const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/**
 * Manages graceful shutdown for stdio-based MCP server processes so they exit
 * promptly when the MCP client disconnects (stdin EOF/close, stdout broken
 * pipe/close, transport close, termination signal, or dead parent on Windows)
 * instead of staying alive indefinitely behind an open TCP bridge socket.
 */
function createMcpStdioLifecycle({
  stdin = process.stdin,
  stdout = process.stdout,
  proc = process,
  onShutdown = () => {},
  onLog = () => {},
  exit = (code) => proc.exit(code),
  forceExitMs = DEFAULT_FORCE_EXIT_MS,
  watchParentPid = proc.platform === "win32",
  parentPollIntervalMs = DEFAULT_PARENT_POLL_INTERVAL_MS,
} = {}) {
  const initialPpid = Number(proc?.ppid);
  let attached = false;
  let shuttingDown = false;
  let shutdownPromise = null;
  let forceExitTimer = null;
  let parentPollTimer = null;
  const signalHandlers = [];

  function isParentGone() {
    if (!Number.isInteger(initialPpid) || initialPpid <= 1) return false;
    try {
      proc.kill(initialPpid, 0);
      return false;
    } catch (err) {
      return err?.code === "ESRCH";
    }
  }

  function clearTimers() {
    if (parentPollTimer) {
      clearInterval(parentPollTimer);
      parentPollTimer = null;
    }
    if (forceExitTimer) {
      clearTimeout(forceExitTimer);
      forceExitTimer = null;
    }
  }

  const onStdinEnd = () => {
    void shutdown("stdin_end");
  };
  const onStdinClose = () => {
    void shutdown("stdin_close");
  };
  const onStdinError = (err) => {
    const code = err?.code;
    const exitCode = STREAM_DISCONNECT_ERROR_CODES.has(code) ? 0 : 1;
    void shutdown(`stdin_error:${code || "unknown"}`, { exitCode });
  };
  const onStdoutClose = () => {
    void shutdown("stdout_close");
  };
  const onStdoutError = (err) => {
    const code = err?.code;
    const exitCode = STREAM_DISCONNECT_ERROR_CODES.has(code) ? 0 : 1;
    void shutdown(`stdout_error:${code || "unknown"}`, { exitCode });
  };

  function detach() {
    if (!attached) return;
    attached = false;
    stdin?.off?.("end", onStdinEnd);
    stdin?.off?.("close", onStdinClose);
    stdin?.off?.("error", onStdinError);
    stdout?.off?.("close", onStdoutClose);
    stdout?.off?.("error", onStdoutError);
    for (const { signal, handler } of signalHandlers.splice(0)) {
      proc?.off?.(signal, handler);
    }
    if (parentPollTimer) {
      clearInterval(parentPollTimer);
      parentPollTimer = null;
    }
  }

  function shutdown(reason = "shutdown", { exitCode = 0 } = {}) {
    if (shuttingDown) return shutdownPromise;
    shuttingDown = true;
    onLog("Shutting down MCP server", { reason, exitCode });
    detach();

    let exited = false;
    const finishExit = () => {
      if (exited) return;
      exited = true;
      clearTimers();
      exit(exitCode);
    };

    forceExitTimer = setTimeout(finishExit, forceExitMs);
    forceExitTimer.unref?.();

    shutdownPromise = Promise.resolve()
      .then(() => onShutdown(reason))
      .catch((err) => {
        onLog("Error during MCP server shutdown", {
          reason,
          message: err?.message || String(err),
        });
      })
      .finally(() => {
        finishExit();
      });

    return shutdownPromise;
  }

  function attach() {
    if (attached || shuttingDown) return;
    attached = true;

    stdin?.on?.("end", onStdinEnd);
    stdin?.on?.("close", onStdinClose);
    stdin?.on?.("error", onStdinError);
    stdout?.on?.("close", onStdoutClose);
    stdout?.on?.("error", onStdoutError);

    for (const signal of SHUTDOWN_SIGNALS) {
      const handler = () => {
        void shutdown(`signal:${signal}`);
      };
      try {
        proc?.on?.(signal, handler);
        signalHandlers.push({ signal, handler });
      } catch {
        // Ignore unsupported signals on constrained platforms.
      }
    }

    if (stdin?.readableEnded || stdin?.destroyed) {
      void shutdown("stdin_already_closed");
      return;
    }

    if (stdout?.writableEnded || stdout?.destroyed) {
      void shutdown("stdout_already_closed");
      return;
    }

    if (watchParentPid && Number.isInteger(initialPpid) && initialPpid > 1) {
      if (isParentGone()) {
        void shutdown("parent_exited");
        return;
      }
      parentPollTimer = setInterval(() => {
        if (isParentGone()) {
          void shutdown("parent_exited");
        }
      }, parentPollIntervalMs);
      parentPollTimer.unref?.();
    }
  }

  function bindTransport(transport) {
    if (!transport) return;
    const previousOnClose = transport.onclose;
    transport.onclose = () => {
      try {
        previousOnClose?.();
      } finally {
        void shutdown("transport_close");
      }
    };
  }

  return {
    attach,
    detach,
    bindTransport,
    shutdown,
    isShuttingDown: () => shuttingDown,
  };
}

module.exports = {
  createMcpStdioLifecycle,
  DEFAULT_FORCE_EXIT_MS,
  DEFAULT_PARENT_POLL_INTERVAL_MS,
};
