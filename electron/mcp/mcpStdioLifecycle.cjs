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
const POSIX_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const WIN32_SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"];

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
  const transportBindings = [];

  function safeLog(message, meta) {
    try {
      onLog(message, meta);
    } catch {
      // Logging failures during teardown must never block shutdown.
    }
  }

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

  function unbindTransports() {
    for (const binding of transportBindings.splice(0)) {
      binding.active = false;
      if (binding.transport.onclose === binding.wrapper) {
        binding.transport.onclose = binding.previousOnClose;
      }
    }
  }

  function stopShutdownTriggers({ keepStreamErrorHandlers = false } = {}) {
    if (parentPollTimer) {
      clearInterval(parentPollTimer);
      parentPollTimer = null;
    }
    unbindTransports();
    if (!attached) return;
    stdin?.off?.("end", onStdinEnd);
    stdin?.off?.("close", onStdinClose);
    stdout?.off?.("close", onStdoutClose);
    for (const { signal, handler } of signalHandlers.splice(0)) {
      proc?.off?.(signal, handler);
    }
    if (!keepStreamErrorHandlers) {
      stdin?.off?.("error", onStdinError);
      stdout?.off?.("error", onStdoutError);
      attached = false;
    }
  }

  function detach() {
    stopShutdownTriggers({ keepStreamErrorHandlers: false });
  }

  function shutdown(reason = "shutdown", { exitCode = 0 } = {}) {
    if (shuttingDown) return shutdownPromise;
    shuttingDown = true;
    safeLog("Shutting down MCP server", { reason, exitCode });
    // Keep stdin/stdout error listeners attached while async onShutdown runs so
    // late EPIPE/ECONNRESET events on closing pipes cannot crash with exit 1.
    stopShutdownTriggers({ keepStreamErrorHandlers: true });

    let exited = false;
    const finishExit = () => {
      if (exited) return;
      exited = true;
      clearTimers();
      exit(exitCode);
    };

    forceExitTimer = setTimeout(finishExit, forceExitMs);
    if (exitCode === 0) {
      forceExitTimer.unref?.();
    }

    shutdownPromise = Promise.resolve()
      .then(() => onShutdown(reason))
      .catch((err) => {
        safeLog("Error during MCP server shutdown", {
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

    const signals = proc?.platform === "win32"
      ? WIN32_SHUTDOWN_SIGNALS
      : POSIX_SHUTDOWN_SIGNALS;
    for (const signal of signals) {
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

    // Start observing the underlying stdin pipe without switching to flowing
    // mode or consuming buffered bytes, so immediate/startup EOF fires before
    // StdioServerTransport attaches its data listener.
    if (stdin?.readableFlowing === null && typeof stdin.read === "function") {
      try {
        stdin.read(0);
      } catch {
        // Ignore non-standard stdin implementations.
      }
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
    const binding = {
      transport,
      previousOnClose,
      wrapper: null,
      active: true,
    };
    const wrapper = () => {
      try {
        previousOnClose?.();
      } finally {
        if (binding.active) {
          void shutdown("transport_close");
        }
      }
    };
    binding.wrapper = wrapper;
    transport.onclose = wrapper;
    transportBindings.push(binding);
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
