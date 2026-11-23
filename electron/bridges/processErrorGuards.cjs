function isNonFatalNetworkError(err) {
  if (!err) return false;
  // Any error with an ssh2 `level` property is a connection/auth-level error,
  // never a reason to kill the entire multi-session app.
  if (err.level) return true;

  const candidates = [err, err.cause].filter(Boolean);
  for (const candidate of candidates) {
    const code = candidate.code;
    // Common TCP/DNS/routing errors that can surface from Node.js sockets
    // without an ssh2 `level` (e.g. proxy sockets, raw net.connect calls).
    switch (code) {
      case "ECONNRESET":
      case "ECONNREFUSED":
      case "ECONNABORTED":
      case "ETIMEDOUT":
      case "ENOTFOUND":
      case "EHOSTUNREACH":
      case "EHOSTDOWN":
      case "ENETUNREACH":
      case "ENETDOWN":
      case "EADDRNOTAVAIL":
      case "EPROTO":
      case "EPERM":
        return true;
      default:
        break;
    }

    // Chromium/Electron networking often rejects with a message like
    // "net::ERR_NETWORK_CHANGED" but without a useful `code` property.
    // These are transport failures for background fetch/update/sync work,
    // not reasons to kill the whole app.
    const message = String(candidate.message || "");
    if (/net::ERR_(?:NETWORK_[A-Z_]+|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|CONNECTION_[A-Z_]+|ADDRESS_[A-Z_]+|SSL_[A-Z_]+|CERT_[A-Z_]+|PROXY_[A-Z_]+|TUNNEL_[A-Z_]+|SOCKS_[A-Z_]+)/.test(message)) {
      return true;
    }
  }

  return false;
}

function isBenignStreamError(err) {
  const code = err?.code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED";
}

function classifyProcessError(err, options = {}) {
  const runtimeStarted = options.runtimeStarted === true;

  if (isBenignStreamError(err)) {
    return {
      action: "ignore",
      reason: "benign stream teardown",
    };
  }

  if (isNonFatalNetworkError(err)) {
    return {
      action: "suppress",
      reason: "non-fatal network error",
    };
  }

  if (runtimeStarted) {
    return {
      action: "suppress",
      reason: "runtime error after startup",
    };
  }

  return {
    action: "fatal",
    reason: "startup error before app became usable",
  };
}

/**
 * Wrap the console sink used for diagnostics so a broken sink cannot feed
 * itself.
 *
 * The only lines these guards cannot safely write are the ones about the sink
 * they write through: a torn-down stdio pipe reports EPIPE asynchronously and a
 * closed writer throws EIO synchronously, and both are delivered straight back
 * to the process-level handlers, which log again — an unbounded feedback loop
 * that pins a core, buffers every failed write in memory, and leaves the
 * process unable to answer anything else. Once the sink reports a failure its
 * diagnostics are dropped; because this listener also consumes the stream
 * `error` event before the process guards see it, the first failure is handed
 * to `options.onError` so the caller (`captureError` in the main process,
 * `report` in the terminal worker) can still persist it.
 */
function createDiagnosticLogger(log, options = {}) {
  const streams = (options.streams || []).filter(
    (stream) => typeof stream?.on === "function"
      && typeof stream?.removeListener === "function",
  );
  const onError = typeof options.onError === "function" ? options.onError : null;
  let sinkFailed = false;
  let sinkErrorReported = false;
  const onSinkError = (err) => {
    // Latch before reporting: anything the reporter logs is already unwritable.
    sinkFailed = true;
    if (sinkErrorReported) return;
    sinkErrorReported = true;
    if (!onError) return;
    try {
      onError(err);
    } catch {
      // A failing reporter must not escape the stream's error listener.
    }
  };
  for (const stream of streams) {
    // Holding an `error` listener also keeps a failed write on the diagnostics
    // stream from being rethrown as an uncaught exception, which is how the
    // loop used to restart.
    stream.on("error", onSinkError);
  }

  const guarded = (...args) => {
    if (sinkFailed) return;
    try {
      log(...args);
    } catch {
      sinkFailed = true;
    }
  };
  guarded.dispose = () => {
    for (const stream of streams) stream.removeListener("error", onSinkError);
  };
  return guarded;
}

function createProcessErrorController(options = {}) {
  const captureError = typeof options.captureError === "function" ? options.captureError : () => {};
  const onFatalError = typeof options.onFatalError === "function"
    ? options.onFatalError
    : (err) => { throw err; };
  const logError = typeof options.logError === "function" ? options.logError : (...args) => console.error(...args);
  const logWarn = typeof options.logWarn === "function" ? options.logWarn : (...args) => console.warn(...args);

  let hasShownMainWindow = false;
  let pendingMainWindowStartupCount = 0;

  const isRuntimeProtectionActive = () => (
    hasShownMainWindow && pendingMainWindowStartupCount === 0
  );

  const beginMainWindowStartup = () => {
    pendingMainWindowStartupCount += 1;
  };

  const completeMainWindowStartup = ({ windowShown = false } = {}) => {
    if (pendingMainWindowStartupCount > 0) {
      pendingMainWindowStartupCount -= 1;
    }
    if (windowShown) {
      hasShownMainWindow = true;
    }
  };

  const handleUncaughtException = (err) => {
    const decision = classifyProcessError(err, {
      runtimeStarted: isRuntimeProtectionActive(),
      origin: "uncaughtException",
    });

    if (decision.action === "ignore") {
      logWarn("Ignored process error:", decision.reason, err?.code || err?.message || err);
      return;
    }

    if (decision.action === "suppress") {
      if (!err?.__fromUnhandledRejection) {
        captureError("uncaughtException", err);
      }
      logError(`Suppressed uncaught exception (${decision.reason}):`, err);
      return;
    }

    if (!err?.__fromUnhandledRejection) {
      captureError("uncaughtException", err);
    }
    onFatalError(err, {
      origin: "uncaughtException",
      decision,
      reason: err,
    });
  };

  const handleUnhandledRejection = (reason) => {
    const decision = classifyProcessError(reason, {
      runtimeStarted: isRuntimeProtectionActive(),
      origin: "unhandledRejection",
    });

    if (decision.action === "ignore") {
      return;
    }

    if (decision.action === "suppress") {
      captureError("unhandledRejection", reason);
      logError(`Suppressed unhandled rejection (${decision.reason}):`, reason);
      return;
    }

    captureError("unhandledRejection", reason);
    const err = reason instanceof Error ? reason : new Error(String(reason));
    err.__fromUnhandledRejection = true;
    onFatalError(err, {
      origin: "unhandledRejection",
      decision,
      reason,
    });
  };

  return {
    beginMainWindowStartup,
    completeMainWindowStartup,
    handleUncaughtException,
    handleUnhandledRejection,
    isRuntimeProtectionActive,
  };
}

function installProcessErrorHandlers(processObject, controller) {
  if (!processObject?.on || !processObject?.removeListener) {
    throw new Error("A process-like EventEmitter is required");
  }
  if (!controller?.handleUncaughtException || !controller?.handleUnhandledRejection) {
    throw new Error("A process error controller is required");
  }

  processObject.on("uncaughtException", controller.handleUncaughtException);
  processObject.on("unhandledRejection", controller.handleUnhandledRejection);

  return () => {
    processObject.removeListener("uncaughtException", controller.handleUncaughtException);
    processObject.removeListener("unhandledRejection", controller.handleUnhandledRejection);
  };
}

module.exports = {
  classifyProcessError,
  createDiagnosticLogger,
  createProcessErrorController,
  installProcessErrorHandlers,
  isBenignStreamError,
  isNonFatalNetworkError,
};
