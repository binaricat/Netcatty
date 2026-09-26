"use strict";

const { StringDecoder } = require("node:string_decoder");
const { invalidateSshTransport } = require("./sshTransportInvalidation.cjs");

const DEFAULT_SSH_EXEC_OPEN_TIMEOUT_MS = 15_000;
const DEFAULT_SSH_EXEC_RUN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_SSH_EXEC_MAX_OUTPUT_BYTES = 64 * 1024;

function terminateSshExecStream(stream) {
  if (!stream) return;
  // Teardown can race with a final transport error after normal listeners have
  // been removed. Keep that late event from becoming an uncaught main-process
  // exception; the stream is terminal and will be collected with this listener.
  try { stream.once?.("error", () => {}); } catch { /* ignore */ }
  try { stream.stderr?.once?.("error", () => {}); } catch { /* ignore */ }
  // Best-effort: ask the server to KILL the exec'd process before tearing the
  // channel down. Servers that do not answer "signal" requests simply ignore
  // it, so this only ever helps — some sshd builds otherwise leave the remote
  // command running after the client gives up (#3187).
  try { stream.signal?.("KILL"); } catch { /* ignore */ }
  try { stream.close?.(); } catch { /* ignore */ }
  try { stream.end?.(); } catch { /* ignore */ }
  try { stream.destroy?.(); } catch { /* ignore */ }
}

function createAbortError(signal) {
  const reason = signal?.reason;
  const error = reason instanceof Error ? reason : new Error("SSH command was aborted");
  if (!error.code) error.code = "ABORT_ERR";
  return error;
}

function openBoundedSshExecStream(
  sshClient,
  command,
  execOptions = {},
  options = {},
) {
  if (!sshClient || typeof sshClient.exec !== "function") {
    return Promise.reject(new Error("SSH exec unavailable"));
  }
  const signal = options.signal || null;
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  const openingTimeoutMs = Math.max(
    1,
    Number(options.openingTimeoutMs) || DEFAULT_SSH_EXEC_OPEN_TIMEOUT_MS,
  );

  return new Promise((resolve, reject) => {
    let settled = false;
    let openingTimer = null;
    const cleanup = () => {
      if (openingTimer) clearTimeoutFn(openingTimer);
      openingTimer = null;
      signal?.removeEventListener?.("abort", onAbort);
    };
    const finish = (error, stream, { invalidateTransport = false } = {}) => {
      if (settled) {
        if (stream) terminateSshExecStream(stream);
        return false;
      }
      settled = true;
      cleanup();
      if (error && stream) terminateSshExecStream(stream);
      if (invalidateTransport) invalidateSshTransport(sshClient);
      if (error) reject(error);
      else if (!stream) reject(new Error("Failed to create SSH exec stream"));
      else resolve(stream);
      return true;
    };
    const onAbort = () => finish(createAbortError(signal), null, {
      invalidateTransport: true,
    });

    if (signal?.aborted) {
      finish(createAbortError(signal));
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    // Correctness deadlines must stay referenced until settlement. Otherwise
    // Node may exit while the SSH callback and this promise are still pending.
    openingTimer = setTimeoutFn(() => {
      const error = new Error(`SSH exec channel open timed out after ${openingTimeoutMs} ms`);
      error.code = "SSH_EXEC_OPEN_TIMEOUT";
      finish(error, null, { invalidateTransport: true });
    }, openingTimeoutMs);

    try {
      sshClient.exec(command, execOptions, (error, stream) => finish(error, stream));
    } catch (error) {
      finish(error);
    }
  });
}

function openBoundedSshExecStreamCallback(
  sshClient,
  command,
  execOptions,
  callback,
  options = {},
) {
  void openBoundedSshExecStream(sshClient, command, execOptions, options).then(
    (stream) => callback(null, stream),
    (error) => callback(error),
  );
}

function executeBoundedSshCommand(sshClient, command, options = {}) {
  if (!sshClient || typeof sshClient.exec !== "function") {
    return Promise.reject(new Error("SSH exec unavailable"));
  }
  const signal = options.signal || null;
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  const openingTimeoutMs = Math.max(1, Number(options.openingTimeoutMs) || DEFAULT_SSH_EXEC_OPEN_TIMEOUT_MS);
  const runTimeoutMs = Math.max(1, Number(options.runTimeoutMs) || DEFAULT_SSH_EXEC_RUN_TIMEOUT_MS);
  const maxOutputBytes = Math.max(1, Number(options.maxOutputBytes) || DEFAULT_SSH_EXEC_MAX_OUTPUT_BYTES);
  const invalidateOnOpenTimeout = options.invalidateOnOpenTimeout !== false;

  return new Promise((resolve, reject) => {
    let settled = false;
    let streamRef = null;
    let openingTimer = null;
    let runTimer = null;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let decodersEnded = false;
    let cleanupStreamListeners = () => {};

    const cleanup = () => {
      if (openingTimer) clearTimeoutFn(openingTimer);
      if (runTimer) clearTimeoutFn(runTimer);
      openingTimer = null;
      runTimer = null;
      cleanupStreamListeners();
      cleanupStreamListeners = () => {};
      signal?.removeEventListener?.("abort", onAbort);
    };
    const finish = (error, code = null, { terminate = false, invalidateTransport = false } = {}) => {
      if (settled) return false;
      settled = true;
      cleanup();
      if (terminate) terminateSshExecStream(streamRef);
      if (invalidateTransport) invalidateSshTransport(sshClient);
      if (error) reject(error);
      else {
        if (!decodersEnded) {
          decodersEnded = true;
          stdout += stdoutDecoder.end();
          stderr += stderrDecoder.end();
        }
        resolve({ stdout, stderr, code });
      }
      return true;
    };
    const onAbort = () => finish(createAbortError(signal), null, {
      terminate: true,
      // Before the callback arrives ssh2 owns an uncancellable channel-open
      // request. Closing the physical transport is the only public cleanup.
      invalidateTransport: !streamRef && options.invalidateTransportOnAbort !== false,
    });
    const append = (target, chunk) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = Math.max(0, maxOutputBytes - outputBytes);
      if (remaining > 0) {
        const accepted = buffer.length <= remaining ? buffer : buffer.subarray(0, remaining);
        if (target === "stdout") stdout += stdoutDecoder.write(accepted);
        else stderr += stderrDecoder.write(accepted);
        outputBytes += accepted.length;
      }
      if (buffer.length > remaining) {
        const error = new Error(`SSH command output exceeded ${maxOutputBytes} bytes`);
        error.code = "SSH_EXEC_OUTPUT_LIMIT";
        finish(error, null, { terminate: true });
      }
    };

    if (signal?.aborted) {
      finish(createAbortError(signal));
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    openingTimer = setTimeoutFn(() => {
      const error = new Error(`SSH exec channel open timed out after ${openingTimeoutMs} ms`);
      error.code = "SSH_EXEC_OPEN_TIMEOUT";
      finish(error, null, { terminate: true, invalidateTransport: invalidateOnOpenTimeout });
    }, openingTimeoutMs);

    try {
      sshClient.exec(command, (error, stream) => {
        if (openingTimer) clearTimeoutFn(openingTimer);
        openingTimer = null;
        if (settled) {
          terminateSshExecStream(stream);
          return;
        }
        if (error || !stream) {
          if (stream) terminateSshExecStream(stream);
          finish(error || new Error("Failed to create SSH exec stream"));
          return;
        }
        streamRef = stream;
        const onStdout = (chunk) => append("stdout", chunk);
        const onStderr = (chunk) => append("stderr", chunk);
        const onClose = (code) => finish(null, code);
        const onError = (streamError) => finish(
          streamError instanceof Error ? streamError : new Error(String(streamError || "SSH exec failed")),
          null,
          { terminate: true },
        );
        // A well-behaved sshd closes the channel right after the command
        // exits, and the ssh2 client answers that CHANNEL_CLOSE, so the
        // channel never outlives the command on a direct connection.
        // Some relays (JumpServer-style) open a full downstream SSH
        // connection per exec channel but never propagate CHANNEL_CLOSE
        // back upstream — the client then keeps the channel (and the
        // relay's downstream session) open until the run timeout, leaking
        // one `sshd: user@notty` pair per auxiliary command (#3459). The
        // command is complete once the remote reports its exit status and
        // both output streams have hit EOF, so settle at that point and
        // hang the channel up ourselves instead of waiting for the run
        // timeout. Waiting for both guards against servers that report
        // exit-status while a background child still holds the pipe.
        let exitSeen = false;
        let exitCode = null;
        let stdoutEnded = false;
        let stderrEnded = !stream.stderr;
        const maybeFinishAfterEof = () => {
          if (exitSeen && stdoutEnded && stderrEnded) {
            finish(null, exitCode, { terminate: true });
          }
        };
        const onExit = (code) => {
          exitSeen = true;
          if (typeof code === "number") exitCode = code;
          maybeFinishAfterEof();
        };
        const onStdoutEnd = () => {
          stdoutEnded = true;
          maybeFinishAfterEof();
        };
        const onStderrEnd = () => {
          stderrEnded = true;
          maybeFinishAfterEof();
        };
        cleanupStreamListeners = () => {
          stream.removeListener?.("data", onStdout);
          stream.removeListener?.("close", onClose);
          stream.removeListener?.("error", onError);
          stream.removeListener?.("exit", onExit);
          stream.removeListener?.("end", onStdoutEnd);
          stream.stderr?.removeListener?.("data", onStderr);
          stream.stderr?.removeListener?.("error", onError);
          stream.stderr?.removeListener?.("end", onStderrEnd);
        };
        stream.on("data", onStdout);
        stream.on("close", onClose);
        stream.on("error", onError);
        stream.on("exit", onExit);
        stream.on("end", onStdoutEnd);
        stream.stderr?.on?.("data", onStderr);
        stream.stderr?.on?.("error", onError);
        stream.stderr?.on?.("end", onStderrEnd);
        runTimer = setTimeoutFn(() => {
          const timeoutError = new Error(`SSH command execution timed out after ${runTimeoutMs} ms`);
          timeoutError.code = "SSH_EXEC_RUN_TIMEOUT";
          finish(timeoutError, null, { terminate: true });
        }, runTimeoutMs);
        try { options.onStream?.(stream); } catch (streamError) {
          finish(streamError, null, { terminate: true });
          return;
        }
        if (signal?.aborted) onAbort();
      });
    } catch (error) {
      finish(error, null, { terminate: true });
    }
  });
}

module.exports = {
  DEFAULT_SSH_EXEC_OPEN_TIMEOUT_MS,
  DEFAULT_SSH_EXEC_RUN_TIMEOUT_MS,
  DEFAULT_SSH_EXEC_MAX_OUTPUT_BYTES,
  executeBoundedSshCommand,
  openBoundedSshExecStream,
  openBoundedSshExecStreamCallback,
  terminateSshExecStream,
};
