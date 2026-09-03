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
const { StringDecoder } = require("node:string_decoder");
const { invalidateSshTransport } = require("../sshTransportInvalidation.cjs");
const {
  createStatefulDecoder,
  detectShellKind,
  subscribeToPtyData,
  hasExpectedPromptSuffix,
  resolveEffectiveShellKind,
  buildPendingInputClearPrefix,
  buildWrappedCommand,
  findEndMarker,
  normalizePtyOutput,
  appendBoundedOutput,
  consumeVisibleText,
  stripAnsi,
} = require("./ptyExecHelpers.cjs");
const {
  extractTrailingIdlePrompt,
  markSessionPtyPromptMarkerEnded,
  registerSessionPtyPromptMarker,
} = require("./shellUtils.cjs");

const DEFAULT_FOREGROUND_PTY_CAPTURE_CHARS = 1024 * 1024;

function stripJobMarkerLines(text, marker) {
  return text.replace(
    new RegExp(`^([^\r\n]*?)${marker}[^\r\n]*[\r\n]*`, "gm"),
    "$1",
  );
}

function startPtyJob(ptyStream, command, options) {
  const {
    stripMarkers = false,
    trackForCancellation = null,
    timeoutMs = 60000,
    shellKind,
    loginShellHint,
    activeShellHint,
    observedShellHint,
    chatSessionId,
    abortSignal,
    expectedPrompt,
    inputLineKnownEmpty = false,
    typedInput = false,
    echoCommand,
    maxBufferedChars = 0,
    normalizeFinalOutput = true,
    enforceWallTimeout = false,
    promptTrackingSession,
  } = options || {};

  const marker = `__NCMCP_${Date.now().toString(36)}_${crypto.randomBytes(16).toString('hex')}__`;
  const resolvedShellKind = resolveEffectiveShellKind(shellKind, expectedPrompt, {
    loginShellHint,
    activeShellHint,
  });
  const isCmdToPowerShell = loginShellHint === "cmd" && (
    resolvedShellKind === "powershell"
    || observedShellHint === "powershell"
  );
  const hasAmbiguousShellTransition = Boolean(
    observedShellHint
    && (
      resolvedShellKind !== observedShellHint
      || (loginShellHint && loginShellHint !== observedShellHint)
    ),
  );
  // This transition identifies the reporter's Windows startup-command path,
  // but it does not reveal the configured PSReadLine edit mode. If terminal
  // input followed the prompt, no clear-key sequence is portable across
  // Windows/Emacs/Vi; fail without writing instead of corrupting either line.
  if (!inputLineKnownEmpty && (isCmdToPowerShell || hasAmbiguousShellTransition)) {
    const error = "Terminal has pending input; submit or clear it before running an agent command";
    const result = {
      ok: false,
      stdout: "",
      stderr: "",
      exitCode: -1,
      error,
      outputBaseOffset: 0,
      totalOutputChars: 0,
      outputTruncated: false,
    };
    return {
      marker,
      cancel: () => {},
      getSnapshot: () => ({
        stdout: "",
        outputBaseOffset: 0,
        totalOutputChars: 0,
        outputTruncated: false,
        status: "finished",
        foundStart: false,
      }),
      resultPromise: Promise.resolve(result),
    };
  }
  const captureLimitChars = maxBufferedChars > 0
    ? maxBufferedChars
    : DEFAULT_FOREGROUND_PTY_CAPTURE_CHARS;
  const CANCEL_RETRY_MS = 5000;
  const CANCEL_WALL_TIMEOUT_MS = 30000;

  let output = "";
  let foundStart = false;
  let preStartOutput = "";
  let visibleOutput = "";
  let visibleOutputOffset = 0;
  // Monotonic high-water mark for the visible byte stream. Increases on every
  // append; never decreases when CR redraws collapse visibleOutput. Used as
  // the polling nextOffset so callers' offsets stay monotonic.
  let visibleHighWatermark = 0;
  let visibleCarry = "";
  let timeoutId = null;
  let wallTimeoutId = null;
  let startupTimeoutId = null;
  let promptFallbackTimer = null;
  let endMarkerWaitTimer = null;
  let cancelRetryTimerId = null;
  // Track one-shot timers scheduled inside requestCancel so finish() can
  // clear them when the job exits early; otherwise they keep the Node
  // event loop alive after the resultPromise has already resolved.
  const cancelOneShotTimers = [];
  let cancelRequested = false;
  let finished = false;
  let unsubscribe = null;
  const cleanupFns = [];
  let pendingStart = "";
  let pendingEnd = null;
  let resolveResult;
  const outputDecoder = new StringDecoder("utf8");
  const resultPromise = new Promise((resolve) => {
    resolveResult = resolve;
  });

  function clearPromptFallback() {
    if (promptFallbackTimer) {
      clearTimeout(promptFallbackTimer);
      promptFallbackTimer = null;
    }
  }

  function clearEndMarkerWait() {
    if (endMarkerWaitTimer) {
      clearTimeout(endMarkerWaitTimer);
      endMarkerWaitTimer = null;
    }
  }

  function clearCancelRetryTimer() {
    if (cancelRetryTimerId) {
      clearTimeout(cancelRetryTimerId);
      cancelRetryTimerId = null;
    }
  }

  function clearCancelOneShotTimers() {
    while (cancelOneShotTimers.length) {
      clearTimeout(cancelOneShotTimers.pop());
    }
  }

  function armOutputTimeout() {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      sendInterrupt();
      if (cancelRequested) {
        armOutputTimeout();
        return;
      }
      const timeoutSec = Math.round(timeoutMs / 1000);
      finish(foundStart ? output : preStartOutput, -1, `Command timed out after ${timeoutSec}s without output`);
    }, timeoutMs);
  }

  // Hard wall-clock deadline: opt-in via enforceWallTimeout. Used by callers
  // that have a strict tool-call budget (e.g. MCP terminal_execute, where the
  // model can fall back to terminal_start). Default is off so existing
  // foreground execution paths (Catty Agent) keep their inactivity-based
  // timeout for long-running streaming commands.
  function armWallTimeout() {
    if (!enforceWallTimeout || maxBufferedChars > 0) return;
    wallTimeoutId = setTimeout(() => {
      if (finished) return;
      sendInterrupt();
      const timeoutSec = Math.round(timeoutMs / 1000);
      finish(foundStart ? output : preStartOutput, -1, `Command timed out (${timeoutSec}s)`);
    }, timeoutMs);
  }

  // Bounded startup deadline: we always need a hard limit on how long we
  // wait for the wrapped command's start marker. Otherwise an already-chatty
  // PTY (e.g. a tab running tail -f) would let onData re-arm the inactivity
  // timer forever before _S arrives, hanging the call and the session lock.
  // Foreground execs use the configured timeoutMs as the deadline (matching
  // the pre-PR behavior); background jobs use a fixed 30s since their main
  // timeout is much longer (1 hour) and meant for the actual command.
  const BG_STARTUP_TIMEOUT_MS = 30000;
  function armStartupTimeout() {
    const startupMs = maxBufferedChars > 0 ? BG_STARTUP_TIMEOUT_MS : timeoutMs;
    startupTimeoutId = setTimeout(() => {
      if (finished || foundStart) return;
      sendInterrupt();
      const label = maxBufferedChars > 0 ? "Background job startup" : "Command startup";
      finish(preStartOutput, -1, `${label} timed out — start marker never arrived`);
    }, startupMs);
  }
  function clearStartupTimeout() {
    if (startupTimeoutId) {
      clearTimeout(startupTimeoutId);
      startupTimeoutId = null;
    }
  }

  function sendInterrupt() {
    try {
      if (typeof ptyStream.signal === "function") {
        ptyStream.signal("INT");
      }
    } catch {
      // Ignore signal failures and fall back to ETX.
    }
    try {
      if (typeof ptyStream.write === "function") {
        ptyStream.write("\x03");
      }
    } catch {
      // Ignore PTY write failures during cancellation.
    }
  }

  function requestCancel() {
    if (finished || cancelRequested) return;
    if (pendingEnd) {
      finish(pendingEnd.stdout, pendingEnd.exitCode);
      return;
    }
    cancelRequested = true;
    clearPromptFallback();
    clearCancelRetryTimer();
    // Cancel the startup timer too — otherwise a pre-start cancel resolves
    // as "Background job startup timed out" instead of "Cancelled".
    clearStartupTimeout();
    // For pre-start cancellation on sessions without a known idle prompt,
    // schedule a short fallback to finish the job after Ctrl+C has had time
    // to take effect. Without this, the cancel waits the full forced-cancel
    // window even though the shell may have returned to idle quickly.
    if (!foundStart && !expectedPrompt) {
      const t = setTimeout(() => {
        if (finished || foundStart) return;
        finish(preStartOutput, 130, "Cancelled");
      }, 2000);
      cancelOneShotTimers.push(t);
    }
    sendInterrupt();
    cancelRetryTimerId = setTimeout(function retryCancel() {
      if (finished || !cancelRequested) return;
      sendInterrupt();
      cancelRetryTimerId = setTimeout(retryCancel, CANCEL_RETRY_MS);
    }, CANCEL_RETRY_MS);
    armOutputTimeout();
    const t150 = setTimeout(() => {
      if (!finished) sendInterrupt();
    }, 150);
    cancelOneShotTimers.push(t150);
    // Hard wall-clock deadline for cancellation: if the process ignores
    // Ctrl+C and never redraws the prompt, force-finish after a bounded
    // period so the session is not stuck in "stopping" forever.
    // Mark as "forced" so callers can tell the shell may still be busy.
    const tWall = setTimeout(() => {
      if (!finished) {
        finish(foundStart ? output : preStartOutput, 130, "Cancelled (forced — process may still be running)");
      }
    }, CANCEL_WALL_TIMEOUT_MS);
    cancelOneShotTimers.push(tWall);
  }

  function schedulePromptFallback() {
    clearPromptFallback();
    if (!hasExpectedPromptSuffix(output, expectedPrompt)) return;
    // Background jobs use a much longer delay (30s) so commands that open
    // child shells / REPLs with the same prompt have time to print past
    // their initial prompt and avoid being misdetected as completed.
    // Foreground execs use 250ms to match the pre-PR behavior.
    const delayMs = maxBufferedChars > 0 ? 30000 : 250;
    promptFallbackTimer = setTimeout(() => {
      if (!hasExpectedPromptSuffix(output, expectedPrompt)) return;
      finish(output, null, null);
    }, delayMs);
  }

  function checkEnd() {
    const found = findEndMarker(output, marker, { allowInline: true });
    if (!found) return;
    markSessionPtyPromptMarkerEnded(promptTrackingSession, marker);
    const stdout = output.slice(0, found.endIdx);
    pendingEnd = { stdout, exitCode: found.exitCode };
    clearTimeout(timeoutId);
    timeoutId = null;
    clearTimeout(wallTimeoutId);
    wallTimeoutId = null;
    clearStartupTimeout();
    clearCancelRetryTimer();
    clearCancelOneShotTimers();
    if (!expectedPrompt || extractTrailingIdlePrompt(output)) {
      finish(stdout, found.exitCode);
      return;
    }
    // A terminal often delivers the definitive end marker and the redrawn
    // prompt in separate chunks. Keep the execution lock until that prompt
    // arrives so an immediate follow-up command cannot select its wrapper from
    // a transient marker-only tail. A bounded fallback prevents a permanently
    // changed/custom prompt from holding the lock forever; the last confirmed
    // active-shell hint keeps the next execution from reverting to login cmd.
    if (!endMarkerWaitTimer) {
      endMarkerWaitTimer = setTimeout(() => {
        finish(stdout, found.exitCode);
      }, 30000);
    }
  }

  // Carry buffer for incomplete marker lines split across chunks.
  let visibleMarkerCarry = "";

  // Note: we intentionally do NOT collapse CR redraws in visibleOutput.
  // Doing so makes polling offsets non-monotonic and can drop finalized
  // lines after a CR rewrite. Instead, the buffer stores raw bytes
  // (including \r) and the bounded-buffer cap (256KB) keeps progress-bar
  // accumulation under control. Consumers that want a "collapsed" view
  // can apply CR processing themselves.

  function appendToVisible(text) {
    if (!text) return;
    let boundedInput = text;
    if (boundedInput.length > captureLimitChars) {
      const skipped = boundedInput.length - captureLimitChars;
      boundedInput = boundedInput.slice(-captureLimitChars);
      // A skipped prefix may end inside a control sequence; drop any carry
      // from that prefix and treat offsets as a conservative raw-char count.
      visibleCarry = "";
      visibleOutputOffset += skipped;
      visibleHighWatermark += skipped;
    }
    const normalized = consumeVisibleText(visibleCarry, boundedInput);
    visibleCarry = normalized.carry;
    if (!normalized.visibleText) return;

    let cleanVisible = normalized.visibleText;
    if (maxBufferedChars > 0) {
      // Rejoin with any incomplete line from the previous chunk so marker
      // lines split across PTY data boundaries are matched as a whole.
      cleanVisible = visibleMarkerCarry + cleanVisible;
      visibleMarkerCarry = "";
      // We must withhold any trailing line that *might* be the start of an
      // internal marker line, even if the random marker token isn't fully
      // present yet (the chunk boundary may split the marker mid-token).
      // Detect this by looking for the constant prefix "__NCMCP_" — only
      // user output that *contains an unrelated __NCMCP_ string and ends
      // with a newline* will be preserved through the next strip step.
      const NCMCP_PREFIX = "__NCMCP_";
      const lastNl = cleanVisible.lastIndexOf("\n");
      if (lastNl === -1) {
        if (cleanVisible.includes(NCMCP_PREFIX)) {
          visibleMarkerCarry = cleanVisible;
          return;
        }
      } else if (lastNl < cleanVisible.length - 1) {
        const trailing = cleanVisible.slice(lastNl + 1);
        if (trailing.includes(NCMCP_PREFIX)) {
          visibleMarkerCarry = trailing;
          cleanVisible = cleanVisible.slice(0, lastNl + 1);
        }
      }
      // Strip only this job's specific marker lines so user output that
      // happens to contain "__NCMCP_" (e.g. printf '__NCMCP_demo\n') is
      // preserved.
      cleanVisible = stripJobMarkerLines(cleanVisible, marker);
      if (!cleanVisible) return;
    }
    visibleHighWatermark += cleanVisible.length;
    const next = appendBoundedOutput(visibleOutput, cleanVisible, captureLimitChars);
    visibleOutput = next.text;
    visibleOutputOffset += next.dropped;
  }

  function appendToOutput(text) {
    if (!text) return;
    const next = appendBoundedOutput(output, text, captureLimitChars);
    output = next.text;
    appendToVisible(text);
  }

  function finish(stdout, exitCode, error) {
    if (finished) return;
    finished = true;
    clearTimeout(timeoutId);
    clearTimeout(wallTimeoutId);
    clearStartupTimeout();
    clearPromptFallback();
    clearEndMarkerWait();
    clearCancelRetryTimer();
    // Clear any pending one-shot cancel timers so they do not keep the
    // Node event loop alive after the job has resolved.
    clearCancelOneShotTimers();
    unsubscribe?.();
    for (const fn of cleanupFns) {
      try {
        fn();
      } catch {
        // Ignore cleanup failures
      }
    }
    if (trackForCancellation) {
      trackForCancellation.delete(marker);
    }

    // Flush any incomplete marker carry — if it wasn't this job's marker, append it.
    if (visibleMarkerCarry) {
      const leftover = stripJobMarkerLines(visibleMarkerCarry, marker);
      visibleMarkerCarry = "";
      if (leftover) {
        const next = appendBoundedOutput(visibleOutput, leftover, captureLimitChars);
        visibleOutput = next.text;
        visibleOutputOffset += next.dropped;
      }
    }

    // For background jobs (maxBufferedChars > 0), use the already-stripped
    // visibleOutput so completion offsets are consistent with polling offsets.
    // Re-normalizing from the raw buffer would produce a shorter result because
    // ANSI codes inflate the raw buffer, causing it to truncate earlier.
    let cleaned;
    let outputBaseOffset;
    let totalOutputChars;
    if (maxBufferedChars > 0 && foundStart) {
      // Always strip this job's markers from the visible buffer — it accumulates
      // raw PTY data including the end-marker line that must not leak to callers.
      const strippedVisible = normalizePtyOutput(visibleOutput, {
        stripMarkers: true,
        markerToStrip: marker,
        expectedPrompt,
        trimOutput: normalizeFinalOutput,
        stripPrompt: true,
      });
      cleaned = strippedVisible;
      outputBaseOffset = visibleOutputOffset;
      totalOutputChars = outputBaseOffset + visibleOutput.length;
    } else {
      const visibleStdout = normalizePtyOutput(stdout, {
        stripMarkers,
        markerToStrip: marker,
        expectedPrompt,
        trimOutput: false,
        stripPrompt: true,
      });
      cleaned = normalizeFinalOutput
        ? normalizePtyOutput(stdout, {
          stripMarkers,
          markerToStrip: marker,
          expectedPrompt,
          trimOutput: true,
          stripPrompt: true,
        })
        : visibleStdout;
      outputBaseOffset = foundStart ? visibleOutputOffset : 0;
      totalOutputChars = outputBaseOffset + visibleStdout.length;
    }
    const finalError = (!error && cancelRequested) ? "Cancelled" : error;
    const finalExitCode = finalError === "Cancelled" ? (exitCode ?? 130) : exitCode;
    if (finalError) {
      resolveResult({
        ok: false,
        stdout: cleaned,
        stderr: "",
        exitCode: finalExitCode ?? -1,
        error: finalError,
        outputBaseOffset,
        totalOutputChars,
        outputTruncated: outputBaseOffset > 0,
      });
    } else {
      resolveResult({
        ok: exitCode === 0 || exitCode === null,
        stdout: cleaned,
        stderr: "",
        exitCode: finalExitCode ?? 0,
        outputBaseOffset,
        totalOutputChars,
        outputTruncated: outputBaseOffset > 0,
      });
    }
  }

  function onData(data) {
    const bytes = Buffer.isBuffer(data)
      ? data
      : data instanceof Uint8Array
        ? Buffer.from(data)
        : Buffer.from(String(data ?? ""));
    const text = outputDecoder.write(bytes);
    if (!text) return;
    if (!pendingEnd) armOutputTimeout();

    if (!foundStart) {
      preStartOutput += text;
      const combined = pendingStart + text;
      pendingStart = "";
      const startMarker = marker + "_S";
      let matched = false;

      const lines = combined.split(/\r?\n/);
      const trailingPartial = /[\r\n]$/.test(combined) ? "" : lines.pop() || "";
      for (const line of lines) {
        if (stripAnsi(line).trim() === startMarker) {
          foundStart = true;
          matched = true;
          break;
        }
      }
      pendingStart = trailingPartial;

      if (foundStart) {
        clearStartupTimeout();
        // Use the *last* occurrence of the start marker to skip the echoed
        // wrapper command and capture only output after the real printf line.
        const markerPattern = new RegExp(`${marker}_S[^\n\r]*(?:\r?\n|$)`, "g");
        let boundary = -1;
        let m;
        while ((m = markerPattern.exec(preStartOutput)) !== null) {
          boundary = m.index;
        }
        if (boundary !== -1) {
          const afterBoundary = preStartOutput.slice(boundary);
          const firstNl = afterBoundary.search(/\r?\n/);
          const initialOutput = firstNl === -1 ? "" : afterBoundary.slice(firstNl).replace(/^\r?\n/, "");
          output = "";
          visibleOutput = "";
          visibleOutputOffset = 0;
          visibleCarry = "";
          appendToOutput(initialOutput);
        }
        preStartOutput = "";
        schedulePromptFallback();
        checkEnd();
        return;
      }

      if (!matched) {
        const fallbackEnd = findEndMarker(preStartOutput, marker);
        if (fallbackEnd) {
          let stdout = preStartOutput.slice(0, fallbackEnd.endIdx);
          const lastStartIdx = stdout.lastIndexOf(startMarker);
          if (lastStartIdx !== -1) {
            const nlAfterStart = stdout.indexOf("\n", lastStartIdx);
            if (nlAfterStart !== -1) {
              stdout = stdout.slice(nlAfterStart + 1);
            }
          }
          finish(stdout, fallbackEnd.exitCode);
          return;
        }
      }
      // A noisy PTY before the start marker must not grow without bound. Keep
      // enough tail for marker/prompt detection; the current chunk was already
      // scanned above so dropping its prefix cannot hide a completed marker.
      if (preStartOutput.length > captureLimitChars) {
        preStartOutput = preStartOutput.slice(-captureLimitChars);
      }
      const markerCarryLimit = marker.length + 256;
      if (pendingStart.length > markerCarryLimit) {
        pendingStart = pendingStart.slice(-markerCarryLimit);
      }
      // If we're cancelling a still-queued command and the shell has returned
      // to its idle prompt, finish immediately as Cancelled instead of waiting
      // for the cancel wall-clock timer.
      if (cancelRequested && hasExpectedPromptSuffix(preStartOutput, expectedPrompt)) {
        finish(preStartOutput, 130, "Cancelled");
        return;
      }
      return;
    }

    appendToOutput(text);
    // Parse a completed command before treating a redrawn prompt as a
    // cancellation boundary. The marker and prompt can arrive in one PTY
    // chunk; finishing from the prompt first would expose the internal marker.
    checkEnd();
    if (finished) return;
    if (!cancelRequested) {
      schedulePromptFallback();
    } else if (hasExpectedPromptSuffix(output, expectedPrompt)) {
      finish(
        pendingEnd?.stdout ?? output,
        pendingEnd?.exitCode ?? 130,
        "Cancelled",
      );
      return;
    }
  }

  if (abortSignal?.aborted) {
    finish("", -1, "Cancelled");
    return {
      marker,
      cancel: () => {},
      getSnapshot: () => ({ stdout: "", status: "cancelled", foundStart: false }),
      resultPromise,
    };
  }

  cleanupFns.push(registerSessionPtyPromptMarker(promptTrackingSession, marker));

  armOutputTimeout();
  armWallTimeout();
  armStartupTimeout();

  unsubscribe = subscribeToPtyData(ptyStream, onData);

  const cancel = () => {
    requestCancel();
  };

  if (trackForCancellation) {
    trackForCancellation.set(marker, {
      ptyStream,
      chatSessionId: chatSessionId || null,
      cancel,
      cleanup: () => {
        clearTimeout(timeoutId);
        unsubscribe?.();
      },
    });
  }

  if (typeof ptyStream.on === "function") {
    const onClose = () => pendingEnd
      ? finish(pendingEnd.stdout, pendingEnd.exitCode)
      : finish(foundStart ? output : preStartOutput, null, cancelRequested ? "Cancelled" : "Stream closed unexpectedly");
    const onError = (err) => pendingEnd
      ? finish(pendingEnd.stdout, pendingEnd.exitCode)
      : finish(foundStart ? output : preStartOutput, -1, cancelRequested ? "Cancelled" : `Stream error: ${err?.message || err}`);
    ptyStream.on("close", onClose);
    ptyStream.on("end", onClose);
    ptyStream.on("error", onError);
    cleanupFns.push(() => {
      try { ptyStream.removeListener("close", onClose); } catch {}
      try { ptyStream.removeListener("end", onClose); } catch {}
      try { ptyStream.removeListener("error", onError); } catch {}
    });
  }
  if (typeof ptyStream.onExit === "function") {
    const disposable = ptyStream.onExit(() => pendingEnd
      ? finish(pendingEnd.stdout, pendingEnd.exitCode)
      : finish(foundStart ? output : preStartOutput, null, cancelRequested ? "Cancelled" : "Process exited"));
    cleanupFns.push(() => {
      try {
        disposable?.dispose?.();
      } catch {
        // Ignore cleanup failures
      }
    });
  }

  if (abortSignal) {
    const onAbort = () => {
      requestCancel();
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
    cleanupFns.push(() => abortSignal.removeEventListener("abort", onAbort));
  }

  if (typedInput && typeof echoCommand === "function") {
    try {
      echoCommand(command);
    } catch {
      // Ignore synthetic echo failures.
    }
  }

  const wrapped = buildWrappedCommand(command, resolvedShellKind, marker);
  // A live PowerShell prompt overriding a cmd login hint is the Windows
  // OpenSSH + startup-command shape from #3252. Input tracking already proved
  // this prompt's editable line is untouched, so mode-dependent clear keys are
  // unnecessary. Other PowerShell paths retain the legacy fallback.
  const pendingInputClearPrefix = isCmdToPowerShell
    ? ""
    : buildPendingInputClearPrefix(resolvedShellKind);
  try {
    ptyStream.write(`${pendingInputClearPrefix}${wrapped}`);
  } catch (error) {
    finish("", -1, `Failed to write command: ${error?.message || error}`);
    throw error;
  }

  return {
    marker,
    cancel,
    // Until the start marker arrives, return empty stdout/zero offsets so
    // an early poll cannot advance nextOffset past pre-start PTY noise that
    // gets discarded once the real command begins.
    getSnapshot: () => ({
      stdout: foundStart ? visibleOutput : "",
      outputBaseOffset: foundStart ? visibleOutputOffset : 0,
      totalOutputChars: foundStart ? visibleOutputOffset + visibleOutput.length : 0,
      outputTruncated: foundStart ? visibleOutputOffset > 0 : false,
      status: finished ? "finished" : (cancelRequested ? "stopping" : "running"),
      foundStart,
    }),
    resultPromise,
  };
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
 * @param {string} [options.activeShellHint] - Last shell kind confirmed by an interactive prompt
 * @param {string} [options.observedShellHint] - Last observed shell kind, including while terminal input is pending
 * @param {boolean} [options.inputLineKnownEmpty] - No terminal input has followed the observed prompt
 * @param {boolean} [options.typedInput=false] - Emit synthetic command echo before execution
 * @param {(command: string) => void} [options.echoCommand] - Callback used to display synthetic command echo
 * @param {object} [options.promptTrackingSession] - Session whose prompt tracker should ignore command output lookalikes
 */
function execViaPty(ptyStream, command, options) {
  return startPtyJob(ptyStream, command, options).resultPromise;
}

/**
 * Fallback: execute via a separate SSH exec channel (invisible to terminal).
 *
 * @param {object} sshClient - SSH client with .exec() method
 * @param {string} command - The command to execute
 * @param {object} [options]
 * @param {number} [options.timeoutMs=60000] - Command timeout in milliseconds
 * @param {number} [options.maxOutputBytes=1048576] - Combined stdout/stderr hard limit
 */
function execViaChannel(sshClient, command, options) {
  const {
    timeoutMs = 60000,
    maxOutputBytes = 1024 * 1024,
    trackForCancellation = null,
    chatSessionId,
  } = options || {};
  const outputLimitBytes = Number.isSafeInteger(maxOutputBytes) && maxOutputBytes > 0
    ? maxOutputBytes
    : 1024 * 1024;

  return new Promise((resolve) => {
    // Register a *pending* cancellation marker synchronously, before
    // `sshClient.exec` opens the channel. Without this, a cancel that
    // arrives while we're still waiting on `sshClient.exec`'s callback
    // finds nothing in `activePtyExecs` to act on — the channel then
    // opens, the real marker registers, and the command runs to
    // completion despite the user already cancelling. The pending
    // marker latches `cancelled = true`; when the callback fires we
    // check the latch and short-circuit instead of starting work.
    const pendingMarker = `__NCMCP_CH_PENDING_${Date.now().toString(36)}_${crypto.randomBytes(8).toString('hex')}__`;
    let cancelled = false;
    let settled = false;
    let openingTimer = null;
    let activeMarker = null;
    const settle = (result) => {
      if (settled) return false;
      settled = true;
      clearTimeout(openingTimer);
      if (trackForCancellation) {
        trackForCancellation.delete(pendingMarker);
        if (activeMarker) trackForCancellation.delete(activeMarker);
      }
      resolve(result);
      return true;
    };
    const cancelPending = () => {
      cancelled = true;
      settle({ ok: false, stdout: "", stderr: "", exitCode: -1, error: "Cancelled" });
      invalidateSshTransport(sshClient);
    };
    if (trackForCancellation) {
      trackForCancellation.set(pendingMarker, {
        chatSessionId: chatSessionId || null,
        cancel: cancelPending,
        cleanup: cancelPending,
      });
    }

    openingTimer = setTimeout(() => {
      const timeoutSec = Math.round(timeoutMs / 1000);
      settle({
        ok: false,
        stdout: "",
        stderr: "",
        exitCode: -1,
        error: `Command timed out (${timeoutSec}s) while opening SSH exec channel`,
      });
      invalidateSshTransport(sshClient);
    }, timeoutMs);
    openingTimer.unref?.();

    try {
      sshClient.exec(command, (err, execStream) => {
        if (trackForCancellation) {
          trackForCancellation.delete(pendingMarker);
        }
        clearTimeout(openingTimer);
        if (settled || cancelled) {
          if (execStream) {
            try { execStream.close(); } catch { /* ignore */ }
          }
          if (!settled) cancelPending();
          return;
        }
        if (err) {
          settle({ ok: false, error: err.message });
          return;
        }
        if (!execStream) {
          settle({ ok: false, error: 'Failed to create exec stream', exitCode: 1 });
          return;
        }
        activeMarker = `__NCMCP_CH_${Date.now().toString(36)}_${crypto.randomBytes(16).toString('hex')}__`;
        let stdout = "";
        let stderr = "";
        let outputBytes = 0;
        const stdoutDecoder = new StringDecoder("utf8");
        const stderrDecoder = new StringDecoder("utf8");
        let finished = false;
        let timeoutId = null;
        let cleanupStreamListeners = () => {};
        const finish = (result) => {
          if (finished) return;
          finished = true;
          clearTimeout(timeoutId);
          cleanupStreamListeners();
          settle(result);
        };
        const terminateExecStream = () => {
          try { execStream.close?.(); } catch { /* ignore */ }
          try { execStream.destroy?.(); } catch { /* ignore */ }
        };
        const appendOutput = (target, data) => {
          if (finished) return;
          const chunk = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
          const remaining = Math.max(0, outputLimitBytes - outputBytes);
          if (chunk.length <= remaining) {
            if (target === "stdout") stdout += stdoutDecoder.write(chunk);
            else stderr += stderrDecoder.write(chunk);
            outputBytes += chunk.length;
            return;
          }
          if (remaining > 0) {
            const accepted = chunk.subarray(0, remaining);
            if (target === "stdout") stdout += stdoutDecoder.write(accepted);
            else stderr += stderrDecoder.write(accepted);
            outputBytes += remaining;
          }
          finish({
            ok: false,
            stdout,
            stderr,
            exitCode: -1,
            error: `Command output exceeded the ${outputLimitBytes} byte limit`,
          });
          terminateExecStream();
        };
        timeoutId = setTimeout(() => {
          const timeoutSec = Math.round(timeoutMs / 1000);
          finish({ ok: false, stdout, stderr, exitCode: -1, error: `Command timed out (${timeoutSec}s)` });
          terminateExecStream();
        }, timeoutMs);
        if (trackForCancellation) {
          trackForCancellation.set(activeMarker, {
            chatSessionId: chatSessionId || null,
            cancel: () => {
              finish({ ok: false, stdout, stderr, exitCode: -1, error: "Cancelled" });
              terminateExecStream();
            },
            cleanup: () => {
              clearTimeout(timeoutId);
              terminateExecStream();
            },
          });
        }
        const onStdoutData = (data) => appendOutput("stdout", data);
        const onStderrData = (data) => appendOutput("stderr", data);
        const onClose = (code) => {
          // code is null when SSH disconnects or process is signal-terminated
          if (code == null) {
            finish({ ok: false, stdout, stderr, exitCode: -1, error: "Command terminated unexpectedly (connection lost or signal)" });
          } else {
            finish({ ok: code === 0, stdout, stderr, exitCode: code });
          }
        };
        const onError = (error) => {
          finish({
            ok: false,
            stdout,
            stderr,
            exitCode: -1,
            error: error?.message || String(error || "SSH exec channel failed"),
          });
          terminateExecStream();
        };
        cleanupStreamListeners = () => {
          execStream.removeListener?.("data", onStdoutData);
          execStream.stderr?.removeListener?.("data", onStderrData);
          execStream.stderr?.removeListener?.("error", onError);
          execStream.removeListener?.("close", onClose);
          execStream.removeListener?.("error", onError);
        };
        execStream.on("data", onStdoutData);
        execStream.stderr?.on?.("data", onStderrData);
        execStream.stderr?.on?.("error", onError);
        execStream.on("close", onClose);
        execStream.on("error", onError);
      });
    } catch (err) {
      // Rare path: `sshClient.exec` itself synchronously throws (e.g.
      // because the underlying ssh2 client was destroyed between the
      // session lookup and now). Drop the pending marker so it doesn't
      // leak in `activePtyExecs`, and resolve as a normal failure
      // result instead of letting the Promise reject — the tool layer
      // expects `{ ok, error }` shape, not a thrown error.
      settle({ ok: false, error: err?.message || String(err) });
    }
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
    encoding = "utf8", // Callers should pass the session's resolved encoding
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
    const decoder = createStatefulDecoder(encoding);

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

      // Flush any bytes the decoder is still holding (e.g. the leading
      // half of a multi-byte char that arrived right before finish).
      let tail = "";
      try { tail = decoder.end() || ""; } catch { /* ignore */ }
      const complete = (stdout || "") + tail;
      let cleaned = stripAnsi(complete).replace(/\r/g, "");

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
      // Encoding follows the session: utf8 for SSH PTY streams, whatever the
      // user picked for serial (utf-8/gb18030/...). The decoder is stateful
      // so multi-byte characters split across chunks get stitched back
      // together instead of emitting replacement bytes.
      const chunk = typeof data === "string" ? data : decoder.write(data);
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
  DEFAULT_FOREGROUND_PTY_CAPTURE_CHARS,
  execViaPty,
  startPtyJob,
  execViaChannel,
  execViaRawPty,
  detectShellKind,
  resolveEffectiveShellKind,
  stripAnsi,
};
