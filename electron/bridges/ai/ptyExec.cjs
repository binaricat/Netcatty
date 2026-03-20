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

function buildWrappedCommand(command, shellKind, marker) {
  switch (shellKind) {
    case "powershell":
      return [
        "$env:PAGER='cat'",
        "$env:SYSTEMD_PAGER=''",
        "$env:GIT_PAGER='cat'",
        "$env:LESS=''",
        `Write-Output '${marker}_S'`,
        "$global:LASTEXITCODE = 0",
        command,
        "$__nc = if ($LASTEXITCODE -ne 0) { [int]$LASTEXITCODE } elseif ($?) { 0 } else { 1 }",
        `Write-Output ("${marker}_E:{0}" -f $__nc)`,
        "",
      ].join("\r\n");

    case "cmd":
      return [
        'set "PAGER=cat"',
        'set "SYSTEMD_PAGER="',
        'set "GIT_PAGER=cat"',
        'set "LESS="',
        `echo ${marker}_S`,
        command,
        `echo ${marker}_E:%errorlevel%`,
        "",
      ].join("\r\n");

    case "fish":
      return [
        "set -gx PAGER cat",
        "set -gx SYSTEMD_PAGER ''",
        "set -gx GIT_PAGER cat",
        "set -gx LESS ''",
        `printf '%s\\n' '${marker}_S'`,
        command,
        "set __nc $status",
        `printf '%s\\n' '${marker}_E:'$__nc`,
        "",
      ].join("\n");

    case "posix":
    default: {
      const noPager = "PAGER=cat SYSTEMD_PAGER= GIT_PAGER=cat LESS= ";
      return (
        `printf '%s\\n' '${marker}_S'\n` +
        `${noPager}${command}\n` +
        `__nc=$?;printf '%s\\n' '${marker}_E:'"$__nc"\n` +
        `(exit $__nc)\n`
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
 */
function execViaPty(ptyStream, command, options) {
  const {
    stripMarkers = false,
    trackForCancellation = null,
    timeoutMs = 60000,
    shellKind,
  } = options || {};

  const marker = `__NCMCP_${Date.now().toString(36)}_${crypto.randomBytes(16).toString('hex')}__`;
  const resolvedShellKind = shellKind || "posix";

  return new Promise((resolve) => {
    let output = "";
    let foundStart = false;
    let timeoutId = null;
    let finished = false;
    let unsubscribe = null;

    const onData = (data) => {
      const text = data.toString();

      if (!foundStart) {
        // Look for the start marker at a line boundary (actual printf output),
        // not inside the echo of the printf command argument.
        const startMarker = marker + "_S";
        let pos = 0;
        while (pos < text.length) {
          const idx = text.indexOf(startMarker, pos);
          if (idx === -1) break;
          // Accept if at start of text, or preceded by \n or \r (line boundary)
          if (idx === 0 || text[idx - 1] === '\n' || text[idx - 1] === '\r') {
            foundStart = true;
            const afterMarker = text.slice(idx);
            const nlIdx = afterMarker.indexOf("\n");
            if (nlIdx !== -1) {
              output += afterMarker.slice(nlIdx + 1);
            }
            break;
          }
          pos = idx + 1;
        }
        if (foundStart) checkEnd();
        return;
      }

      output += text;
      checkEnd();
    };

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

    function finish(stdout, exitCode) {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutId);
      unsubscribe?.();
      if (trackForCancellation) {
        trackForCancellation.delete(marker);
      }

      let cleaned = stripAnsi(stdout || "").trim();
      if (stripMarkers) {
        cleaned = cleaned.replace(/__NCMCP_[^\r\n]*[\r\n]*/g, "").trim();
      }
      resolve({
        ok: exitCode === 0 || exitCode === null,
        stdout: cleaned,
        stderr: "",
        exitCode: exitCode ?? 0,
      });
    }

    timeoutId = setTimeout(() => {
      if (finished) return;
      finished = true;
      unsubscribe?.();
      if (trackForCancellation) {
        trackForCancellation.delete(marker);
      }
      // Send Ctrl+C to kill the timed-out command
      if (typeof ptyStream.write === "function") ptyStream.write("\x03");
      const cleaned = stripAnsi(output).trim();
      const timeoutSec = Math.round(timeoutMs / 1000);
      resolve({ ok: false, stdout: cleaned, stderr: "", exitCode: -1, error: `Command timed out (${timeoutSec}s)` });
    }, timeoutMs);

    unsubscribe = subscribeToPtyData(ptyStream, onData);

    // Register for cancellation if tracking map provided
    if (trackForCancellation) {
      trackForCancellation.set(marker, {
        ptyStream,
        cleanup: () => {
          clearTimeout(timeoutId);
          unsubscribe?.();
        },
      });
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

module.exports = {
  execViaPty,
  execViaChannel,
  detectShellKind,
  stripAnsi,
};
