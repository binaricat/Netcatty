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
  } = options || {};

  const marker = `__NCMCP_${Date.now().toString(36)}_${crypto.randomBytes(16).toString('hex')}__`;

  return new Promise((resolve) => {
    let output = "";
    let foundStart = false;
    let timeoutId = null;
    let finished = false;

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
      ptyStream.removeListener("data", onData);
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
      ptyStream.removeListener("data", onData);
      if (trackForCancellation) {
        trackForCancellation.delete(marker);
      }
      // Send Ctrl+C to kill the timed-out command
      if (typeof ptyStream.write === "function") ptyStream.write("\x03");
      const cleaned = stripAnsi(output).trim();
      const timeoutSec = Math.round(timeoutMs / 1000);
      resolve({ ok: false, stdout: cleaned, stderr: "", exitCode: -1, error: `Command timed out (${timeoutSec}s)` });
    }, timeoutMs);

    ptyStream.on("data", onData);

    // Register for cancellation if tracking map provided
    if (trackForCancellation) {
      trackForCancellation.set(marker, {
        ptyStream,
        cleanup: () => { clearTimeout(timeoutId); ptyStream.removeListener("data", onData); },
      });
    }

    // Markers are filtered from terminal display by preload.cjs (MCP_MARKER_RE).
    const noPager = "PAGER=cat SYSTEMD_PAGER= GIT_PAGER=cat LESS= ";
    ptyStream.write(
      `printf '${marker}_S\\n';${noPager}${command}\n` +
      `__nc=$?;printf '${marker}_E:'$__nc'\\n';(exit $__nc)\n`
    );
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
  const { timeoutMs = 60000 } = options || {};

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
      let stdout = "";
      let stderr = "";
      let finished = false;
      const timeoutId = setTimeout(() => {
        if (finished) return;
        finished = true;
        try { execStream.close(); } catch { /* ignore */ }
        const timeoutSec = Math.round(timeoutMs / 1000);
        resolve({ ok: false, stdout, stderr, exitCode: -1, error: `Command timed out (${timeoutSec}s)` });
      }, timeoutMs);
      execStream.on("data", (data) => { stdout += data.toString(); });
      execStream.stderr.on("data", (data) => { stderr += data.toString(); });
      execStream.on("close", (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeoutId);
        // code is null when SSH disconnects or process is signal-terminated
        if (code == null) {
          resolve({ ok: false, stdout, stderr, exitCode: -1, error: "Command terminated unexpectedly (connection lost or signal)" });
        } else {
          resolve({ ok: code === 0, stdout, stderr, exitCode: code });
        }
      });
    });
  });
}

module.exports = {
  execViaPty,
  execViaChannel,
  stripAnsi,
};
