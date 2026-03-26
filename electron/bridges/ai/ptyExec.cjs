/**
 * PTY and SSH channel command execution.
 *
 * Provides a unified `execViaPty` that works for both MCP server bridge
 * (tracking in activePtyExecs for cancellation) and Catty Agent
 * (stripping MCP markers from output).
 *
 * Also provides `execViaChannel` for SSH exec channel fallback.
 */
"use strict";

const crypto = require("crypto");
const { stripAnsi } = require("./shellUtils.cjs");
const { classifyLocalShellType } = require("../../../lib/localShell.cjs");

function detectShellKind(shellPath, platform = process.platform) {
  return classifyLocalShellType(shellPath, platform);
}

function subscribeToPtyData(ptyStream, onData) {
  if (typeof ptyStream?.onData === "function") {
    const disposable = ptyStream.onData((data) => onData(data));
    return () => {
      try {
        disposable?.dispose?.();
      } catch {
        // Ignore cleanup failures
      }
    };
  }

  if (typeof ptyStream?.on === "function" && typeof ptyStream?.removeListener === "function") {
    ptyStream.on("data", onData);
    return () => {
      try {
        ptyStream.removeListener("data", onData);
      } catch {
        // Ignore cleanup failures
      }
    };
  }

  throw new Error("PTY stream does not support data subscriptions");
}

function hasExpectedPromptSuffix(text, expectedPrompt) {
  if (!expectedPrompt) return false;
  const normalizedText = stripAnsi(String(text || "")).replace(/\r/g, "");
  const normalizedPrompt = stripAnsi(String(expectedPrompt || "")).replace(/\r/g, "");
  return !!normalizedPrompt && normalizedText.endsWith(normalizedPrompt);
}

function escapePosixSingleQuoted(text) {
  return String(text || "").replace(/'/g, "'\\''");
}

function escapePowerShellSingleQuoted(text) {
  return String(text || "").replace(/'/g, "''");
}

function escapeFishSingleQuoted(text) {
  return String(text || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function escapeCmdForNestedShell(text) {
  return String(text || "").replace(/"/g, '""').replace(/%/g, "%%");
}

function buildWrappedCommand(command, shellKind, marker) {
  switch (shellKind) {
    case "powershell": {
      // __NCMCP_ prefix ensures the echo line is buffered/filtered even if
      // the PTY delivers it in small chunks (the marker must appear early).
      const psPager = "$env:PAGER='cat'; $env:SYSTEMD_PAGER=''; $env:GIT_PAGER='cat'; $env:LESS=''; ";
      const psEscaped = escapePowerShellSingleQuoted(command);
      return (
        `$${marker}=0; $${marker}_cmd='${psEscaped}'; Write-Host '> ${psEscaped}'; & { Write-Output '${marker}_S'; ${psPager}$LASTEXITCODE=$null; try { Invoke-Expression $${marker}_cmd; $${marker}_rc = if ($LASTEXITCODE -ne $null) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 } } catch { $${marker}_rc = 1 }; Write-Output "${marker}_E:$${marker}_rc" }\r\n`
      );
    }

    case "cmd": {
      const cmdEscaped = escapeCmdForNestedShell(command);
      return (
        `set "${marker}=0" & set "${marker}_CMD=${cmdEscaped}" & call <nul set /p "=^> %%${marker}_CMD%%" & echo( & (echo ${marker}_S & set "PAGER=cat" & set "SYSTEMD_PAGER=" & set "GIT_PAGER=cat" & set "LESS=" & call cmd /d /s /c "%%${marker}_CMD%%" & call echo ${marker}_E:^%errorlevel^%)\r\n`
      );
    }

    case "fish":
      // set __NCMCP_... at the start ensures early marker presence in echo.
      return (
        `set ${marker} 0; function __ncmcp_int --on-signal INT; printf '%s\\n' '${marker}_E:130'; functions -e __ncmcp_int; end; ` +
        // Clear the current terminal row before the user-visible echo.
        `set -l ${marker}_cmd '${escapeFishSingleQuoted(command)}'; printf '\\r\\033[2K> %s\\n' '${escapeFishSingleQuoted(command)}'; ` +
        `begin; set -gx PAGER cat; set -gx SYSTEMD_PAGER ''; set -gx GIT_PAGER cat; set -gx LESS ''; ` +
        `printf '%s\\n' '${marker}_S'; eval -- \$${marker}_cmd; set __NCMCP_rc $status; ` +
        `functions -e __ncmcp_int; printf '%s\\n' '${marker}_E:'\$__NCMCP_rc; end\n`
      );

    case "posix":
    default: {
      // Single-line compound command with early marker & visible command echo.
      //
      // Layout: __NCMCP_xxx=0; printf echo; { ... MARKER_S; eval command; MARKER_E; }
      //
      // Key design decisions:
      //
      // 1) __NCMCP_xxx=0 at the VERY START ensures the PTY echo line
      //    contains __NCMCP_ in its first few bytes. This is critical:
      //    preload.cjs filters chunks by buffering incomplete lines that
      //    contain __NCMCP_. Without this prefix, the first chunk of a
      //    long echo line might not contain the marker and would leak
      //    through to the terminal as garbage.
      //
      // 2) printf clears the current row and outputs "> command\n"
      //    (no marker) → visible to user without prompt residue.
      //
      // 3) The user command is executed via eval on a quoted string. This
      //    keeps shell syntax errors inside the eval call so the wrapper
      //    can still emit the end marker and return a non-zero exit code.
      //
      // 4) Single-line { ... } is parsed fully before execution, so SIGINT
      //    cannot cause bash to flush the end marker from the input buffer.
      //    trap ':' INT lets child processes receive SIGINT normally while
      //    preventing the shell from aborting the compound command.
      const noPager = "PAGER=cat SYSTEMD_PAGER= GIT_PAGER=cat LESS= ";
      const escaped = escapePosixSingleQuoted(command);
      return (
        `${marker}=0; ${marker}_cmd='${escaped}'; printf '\\r\\033[2K> %s\\n' '${escaped}'; { printf '%s\\n' '${marker}_S'; trap ':' INT; ${noPager}eval "$${marker}_cmd"; __NCMCP_rc=$?; trap - INT; printf '%s\\n' '${marker}_E:'\"$__NCMCP_rc\"; (exit $__NCMCP_rc); }\n`
      );
    }
  }
}

/**
 * Execute command through a terminal PTY stream.
 * The user sees the command typed and output in their terminal.
 * Uses a unique marker to detect when the command finishes and capture the exit code.
 *
 * @param {object} ptyStream - The PTY stream to write to
 * @param {string} command - The command to execute
 * @param {object} [options]
 * @param {boolean} [options.stripMarkers=false] - Strip leaked MCP markers from output
 * @param {Map} [options.trackForCancellation] - Map to register this execution in for cancellation
 * @param {number} [options.timeoutMs=60000] - Command timeout in milliseconds
 * @param {string} [options.chatSessionId] - Chat session ID for scoped cancellation
 * @param {AbortSignal} [options.abortSignal] - AbortSignal to cancel execution
 * @param {string} [options.expectedPrompt] - Last observed idle prompt for exact fallback matching
 */
function execViaPty(ptyStream, command, options) {
  const {
    stripMarkers = false,
    trackForCancellation = null,
    timeoutMs = 60000,
    shellKind,
    chatSessionId,
    abortSignal,
    expectedPrompt,
  } = options || {};

  const marker = `__NCMCP_${Date.now().toString(36)}_${crypto.randomBytes(16).toString('hex')}__`;
  const resolvedShellKind = shellKind || "posix";

  // Fast-path: already aborted before we even start
  if (abortSignal?.aborted) {
    return Promise.resolve({ ok: false, stdout: "", stderr: "", exitCode: -1, error: "Cancelled" });
  }

  return new Promise((resolve) => {
    let output = "";
    let foundStart = false;
    let timeoutId = null;
    let promptFallbackTimer = null;
    let finished = false;
    let unsubscribe = null;
    const cleanupFns = [];

    // Buffer for incomplete line data when searching for start marker.
    // SSH channels can split data at arbitrary byte boundaries, so the
    // start marker may arrive across two chunks.  We keep the content
    // after the last \n (i.e. the current incomplete line) and prepend
    // it to the next chunk so indexOf can match the full marker.
    let pendingStart = "";

    const onData = (data) => {
      const text = data.toString();

      if (!foundStart) {
        const combined = pendingStart + text;
        pendingStart = "";
        const startMarker = marker + "_S";
        let matched = false;
        let pos = 0;
        while (pos < combined.length) {
          const idx = combined.indexOf(startMarker, pos);
          if (idx === -1) break;
          if (idx === 0 || combined[idx - 1] === '\n' || combined[idx - 1] === '\r') {
            foundStart = true;
            matched = true;
            const afterMarker = combined.slice(idx);
            const nlIdx = afterMarker.indexOf("\n");
            if (nlIdx !== -1) {
              output += afterMarker.slice(nlIdx + 1);
            }
            break;
          }
          pos = idx + 1;
        }
        if (!matched) {
          // Keep the last incomplete line for cross-chunk matching
          const lastNl = combined.lastIndexOf("\n");
          pendingStart = lastNl === -1 ? combined : combined.slice(lastNl + 1);
        }
        if (foundStart) {
          schedulePromptFallback();
          checkEnd();
        }
        return;
      }

      output += text;
      schedulePromptFallback();
      checkEnd();
    };

    function clearPromptFallback() {
      if (promptFallbackTimer) {
        clearTimeout(promptFallbackTimer);
        promptFallbackTimer = null;
      }
    }

    function schedulePromptFallback() {
      clearPromptFallback();
      if (!hasExpectedPromptSuffix(output, expectedPrompt)) return;

      // Fallback for shells that visibly return to the same idle prompt but
      // never emit the wrapped end marker line.
      promptFallbackTimer = setTimeout(() => {
        if (!hasExpectedPromptSuffix(output, expectedPrompt)) return;
        finish(output, null, null);
      }, 250);
    }

    function checkEnd() {
      // Look for the end marker at a line boundary (actual printf output),
      // not inside the echo of the printf command argument.
      const endPattern = marker + "_E:";
      let searchFrom = 0;
      while (searchFrom < output.length) {
        const endIdx = output.indexOf(endPattern, searchFrom);
        if (endIdx === -1) return;

        // Accept if at start of output, or preceded by \n or \r (line boundary)
        if (endIdx === 0 || output[endIdx - 1] === '\n' || output[endIdx - 1] === '\r') {
          const afterEnd = output.slice(endIdx + endPattern.length);
          const codeMatch = afterEnd.match(/^(\d+)/);
          const exitCode = codeMatch ? parseInt(codeMatch[1], 10) : null;

          const stdout = output.slice(0, endIdx);
          finish(stdout, exitCode);
          return;
        }
        searchFrom = endIdx + 1;
      }
    }

    function finish(stdout, exitCode, error) {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutId);
      clearPromptFallback();
      unsubscribe?.();
      for (const fn of cleanupFns) { try { fn(); } catch { /* ignore */ } }
      if (trackForCancellation) {
        trackForCancellation.delete(marker);
      }

      let cleaned = stripAnsi(stdout || "").replace(/\r/g, "");
      if (stripMarkers) {
        cleaned = cleaned.replace(/^[^\r\n]*__NCMCP_[^\r\n]*[\r\n]*/gm, "");
      }
      const normalizedPrompt = stripAnsi(String(expectedPrompt || "")).replace(/\r/g, "");
      if (normalizedPrompt && cleaned.endsWith(normalizedPrompt)) {
        cleaned = cleaned.slice(0, cleaned.length - normalizedPrompt.length);
      }
      cleaned = cleaned.trim();
      if (error) {
        resolve({ ok: false, stdout: cleaned, stderr: "", exitCode: exitCode ?? -1, error });
      } else {
        resolve({
          ok: exitCode === 0 || exitCode === null,
          stdout: cleaned,
          stderr: "",
          exitCode: exitCode ?? 0,
        });
      }
    }

    timeoutId = setTimeout(() => {
      // Send Ctrl+C to kill the timed-out command
      if (typeof ptyStream.write === "function") ptyStream.write("\x03");
      const timeoutSec = Math.round(timeoutMs / 1000);
      finish(output, -1, `Command timed out (${timeoutSec}s)`);
    }, timeoutMs);

    unsubscribe = subscribeToPtyData(ptyStream, onData);

    // Register for cancellation if tracking map provided
    if (trackForCancellation) {
      trackForCancellation.set(marker, {
        ptyStream,
        chatSessionId: chatSessionId || null,
        cancel: () => {
          if (typeof ptyStream.write === "function") ptyStream.write("\x03");
          finish(output, -1, "Cancelled");
        },
        cleanup: () => {
          clearTimeout(timeoutId);
          unsubscribe?.();
        },
      });
    }

    // Stream close/error detection — resolve immediately instead of waiting for timeout
    if (typeof ptyStream.on === "function") {
      const onClose = () => finish(output, null, "Stream closed unexpectedly");
      const onError = (err) => finish(output, -1, `Stream error: ${err?.message || err}`);
      ptyStream.on("close", onClose);
      ptyStream.on("end", onClose);
      ptyStream.on("error", onError);
      cleanupFns.push(() => {
        try { ptyStream.removeListener("close", onClose); } catch { /* */ }
        try { ptyStream.removeListener("end", onClose); } catch { /* */ }
        try { ptyStream.removeListener("error", onError); } catch { /* */ }
      });
    }
    // node-pty uses onExit instead of close/end
    if (typeof ptyStream.onExit === "function") {
      const disposable = ptyStream.onExit(() => finish(output, null, "Process exited"));
      cleanupFns.push(() => { try { disposable?.dispose?.(); } catch { /* */ } });
    }

    // AbortSignal handling — send Ctrl+C and resolve when aborted
    if (abortSignal) {
      const onAbort = () => {
        if (typeof ptyStream.write === "function") ptyStream.write("\x03");
        finish(output, -1, "Cancelled");
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
      cleanupFns.push(() => abortSignal.removeEventListener("abort", onAbort));
    }

    // Markers are filtered from terminal display by preload.cjs (MCP_MARKER_RE).
    ptyStream.write(buildWrappedCommand(command, resolvedShellKind, marker));
  });
}

/**
 * Fallback: execute via a separate SSH exec channel (invisible to terminal).
 *
 * @param {object} sshClient - SSH client with .exec() method
 * @param {string} command - The command to execute
 * @param {object} [options]
 * @param {number} [options.timeoutMs=60000] - Command timeout in milliseconds
 */
function execViaChannel(sshClient, command, options) {
  const {
    timeoutMs = 60000,
    trackForCancellation = null,
    chatSessionId,
  } = options || {};

  return new Promise((resolve) => {
    sshClient.exec(command, (err, execStream) => {
      if (err) {
        resolve({ ok: false, error: err.message });
        return;
      }
      if (!execStream) {
        resolve({ ok: false, error: 'Failed to create exec stream', exitCode: 1 });
        return;
      }
      const marker = `__NCMCP_CH_${Date.now().toString(36)}_${crypto.randomBytes(16).toString('hex')}__`;
      let stdout = "";
      let stderr = "";
      let finished = false;
      const finish = (result) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeoutId);
        if (trackForCancellation) {
          trackForCancellation.delete(marker);
        }
        resolve(result);
      };
      const timeoutId = setTimeout(() => {
        try { execStream.close(); } catch { /* ignore */ }
        const timeoutSec = Math.round(timeoutMs / 1000);
        finish({ ok: false, stdout, stderr, exitCode: -1, error: `Command timed out (${timeoutSec}s)` });
      }, timeoutMs);
      if (trackForCancellation) {
        trackForCancellation.set(marker, {
          chatSessionId: chatSessionId || null,
          cancel: () => {
            try { execStream.close(); } catch { /* ignore */ }
            finish({ ok: false, stdout, stderr, exitCode: -1, error: "Cancelled" });
          },
          cleanup: () => {
            clearTimeout(timeoutId);
            try { execStream.close(); } catch { /* ignore */ }
          },
        });
      }
      execStream.on("data", (data) => { stdout += data.toString(); });
      execStream.stderr.on("data", (data) => { stderr += data.toString(); });
      execStream.on("close", (code) => {
        // code is null when SSH disconnects or process is signal-terminated
        if (code == null) {
          finish({ ok: false, stdout, stderr, exitCode: -1, error: "Command terminated unexpectedly (connection lost or signal)" });
        } else {
          finish({ ok: code === 0, stdout, stderr, exitCode: code });
        }
      });
    });
  });
}

/**
 * Execute command on a raw serial port (no shell wrapping).
 *
 * Used for network devices (Cisco IOS, Huawei VRP, etc.) and embedded systems
 * that do not run a standard POSIX/PowerShell/CMD shell.
 *
 * The command is sent as-is followed by CR. Completion is detected via idle
 * timeout (no new data for `idleMs` milliseconds). The idle timer does NOT
 * start until the first data chunk arrives, so slow devices won't time out
 * before producing any output.
 *
 * Exit code is always `null` because vendor CLIs do not expose exit codes.
 *
 * @param {object} serialPort - The SerialPort instance with .write() and .on("data")
 * @param {string} command - The raw command to send
 * @param {object} [options]
 * @param {number} [options.timeoutMs=60000] - Overall timeout
 * @param {number} [options.idleMs=3000] - Idle timeout to detect command completion
 * @param {Map} [options.trackForCancellation] - Map for cancellation tracking
 * @param {string} [options.chatSessionId] - Chat session ID for scoped cancellation
 * @param {AbortSignal} [options.abortSignal] - AbortSignal to cancel execution
 */
function execViaRawPty(serialPort, command, options) {
  const {
    timeoutMs = 60000,
    idleMs = 3000,
    trackForCancellation = null,
    chatSessionId,
    abortSignal,
  } = options || {};

  // Simple incrementing key for the cancellation map (no markers sent to device)
  const cancelKey = `__NCRAW_${Date.now().toString(36)}_${(++execViaRawPty._seq).toString(36)}`;

  if (abortSignal?.aborted) {
    return Promise.resolve({ ok: false, stdout: "", stderr: "", exitCode: null, error: "Cancelled" });
  }

  return new Promise((resolve) => {
    let output = "";
    let finished = false;
    let overallTimer = null;
    let idleTimer = null;
    const cleanupFns = [];

    function safeWrite(data) {
      try {
        if (typeof serialPort.write === "function") serialPort.write(data);
      } catch { /* serial port may already be closed */ }
    }

    // finish signature differs from execViaPty intentionally: no exitCode param
    // because vendor CLIs have no exit code concept (always null).
    function finish(stdout, error) {
      if (finished) return;
      finished = true;
      clearTimeout(overallTimer);
      clearTimeout(idleTimer);
      for (const fn of cleanupFns) { try { fn(); } catch { /* ignore */ } }
      if (trackForCancellation) {
        trackForCancellation.delete(cancelKey);
      }

      let cleaned = stripAnsi(stdout || "").replace(/\r/g, "");

      // Strip echoed command from the beginning of output.
      // Network devices typically echo back the typed command on the first line,
      // often prefixed by the device prompt (e.g. "Router#show version").
      // Only strip when the first line is a close match to avoid removing
      // legitimate output on devices that don't echo.
      const lines = cleaned.split("\n");
      if (lines.length > 1) {
        const firstLine = lines[0].trim();
        const cmdTrimmed = command.trim();
        if (cmdTrimmed && (firstLine === cmdTrimmed || firstLine.endsWith(cmdTrimmed))) {
          lines.shift();
        }
      }
      cleaned = lines.join("\n").trim();

      if (error) {
        resolve({ ok: false, stdout: cleaned, stderr: "", exitCode: null, error });
      } else {
        resolve({ ok: true, stdout: cleaned, stderr: "", exitCode: null });
      }
    }

    // Track data chunks to distinguish echo phase from real output.
    // The first 1-2 chunks are typically the echoed command + prompt.
    // Use a longer idle timeout during this phase so that commands like
    // ping/traceroute/copy that stay quiet after the echo aren't truncated.
    let chunkCount = 0;
    const ECHO_PHASE_CHUNKS = 2;

    function resetIdleTimer() {
      clearTimeout(idleTimer);
      // During echo phase (first few chunks), use 2× idleMs to avoid
      // truncating commands that produce output after a delay.
      const effectiveIdle = chunkCount <= ECHO_PHASE_CHUNKS ? idleMs * 2 : idleMs;
      idleTimer = setTimeout(() => {
        finish(output, null);
      }, effectiveIdle);
    }

    let noResponseTimer = null;

    // Cap output to prevent unbounded accumulation on noisy serial consoles
    // (e.g. devices that continuously emit syslog/debug messages). Once the cap
    // is reached, stop resetting the idle timer so the function can resolve.
    const MAX_OUTPUT_BYTES = 512 * 1024; // 512 KB

    const onData = (data) => {
      // Use latin1 to match the terminal display decoder in terminalBridge.cjs.
      const chunk = data.toString("latin1");
      chunkCount++;
      // Cancel the no-response fallback on first data
      if (noResponseTimer) {
        clearTimeout(noResponseTimer);
        noResponseTimer = null;
      }
      if (output.length < MAX_OUTPUT_BYTES) {
        output += chunk;
        // Only reset idle timer while accumulating — once capped, let it fire
        // so noisy sessions don't hang until the overall timeout.
        resetIdleTimer();
      }
    };

    // Subscribe to serial port data
    if (typeof serialPort.on === "function") {
      serialPort.on("data", onData);
      cleanupFns.push(() => {
        try { serialPort.removeListener("data", onData); } catch { /* ignore */ }
      });

      // Error / close detection
      const onError = (err) => finish(output, `Serial port error: ${err?.message || err}`);
      const onClose = () => finish(output, "Serial port closed unexpectedly");
      serialPort.on("error", onError);
      serialPort.on("close", onClose);
      cleanupFns.push(() => {
        try { serialPort.removeListener("error", onError); } catch { /* */ }
        try { serialPort.removeListener("close", onClose); } catch { /* */ }
      });
    }

    // Overall timeout
    overallTimer = setTimeout(() => {
      safeWrite("\x03");
      const timeoutSec = Math.round(timeoutMs / 1000);
      finish(output, `Command timed out (${timeoutSec}s)`);
    }, timeoutMs);

    // Cancellation tracking
    if (trackForCancellation) {
      trackForCancellation.set(cancelKey, {
        chatSessionId: chatSessionId || null,
        cancel: () => {
          safeWrite("\x03");
          finish(output, "Cancelled");
        },
        cleanup: () => {
          clearTimeout(overallTimer);
          clearTimeout(idleTimer);
        },
      });
    }

    // AbortSignal handling
    if (abortSignal) {
      const onAbort = () => {
        safeWrite("\x03");
        finish(output, "Cancelled");
      };
      abortSignal.addEventListener("abort", onAbort, { once: true });
      cleanupFns.push(() => abortSignal.removeEventListener("abort", onAbort));
    }

    // Send the raw command followed by CR (network devices expect \r).
    safeWrite(command + "\r");

    // Start a "no-response" fallback timer. If the device produces no output at
    // all (e.g. silent mode-changing commands like "enable", "configure terminal",
    // or devices with echo disabled), the idle timer never starts because onData
    // never fires. This fallback resolves successfully to avoid waiting for the
    // full overall timeout. Uses min(idleMs * 4, timeoutMs / 4) to balance between
    // not waiting too long for silent commands and not truncating slow operations.
    // Cleared on first data in onData.
    const noResponseMs = Math.min(idleMs * 4, Math.floor(timeoutMs / 4));
    noResponseTimer = setTimeout(() => {
      // Resolve with ok:true but include a hint that no output was received,
      // so the AI knows the command may still be running or produced no output.
      finish(output || "(no output received — command may have completed silently or may still be running)", null);
    }, noResponseMs);
    cleanupFns.push(() => clearTimeout(noResponseTimer));
  });
}
execViaRawPty._seq = 0;

module.exports = {
  execViaPty,
  execViaChannel,
  execViaRawPty,
  detectShellKind,
  stripAnsi,
};
