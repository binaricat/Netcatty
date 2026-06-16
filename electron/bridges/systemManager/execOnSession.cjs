/* eslint-disable no-undef */

const { isSshConnAlive, isTransportExecError } = require("./execConnHealth.cjs");

function createExecOnSessionApi(ctx) {
  with (ctx) {
    /** Serialize remote exec per session to avoid SSH channel storms. */
    const execQueues = new Map();

    function getSession(sessionId) {
      return sessions?.get?.(sessionId) ?? null;
    }

    function enqueueExec(sessionId, task) {
      let state = execQueues.get(sessionId);
      if (!state) {
        state = { running: false, pending: [] };
        execQueues.set(sessionId, state);
      }
      return new Promise((resolve) => {
        state.pending.push({ task, resolve });
        void drainExecQueue(sessionId);
      });
    }

    async function drainExecQueue(sessionId) {
      const state = execQueues.get(sessionId);
      if (!state || state.running) return;
      state.running = true;
      while (state.pending.length > 0) {
        const job = state.pending.shift();
        if (!job) continue;
        try {
          const result = await job.task();
          job.resolve(result);
        } catch (err) {
          job.resolve({ success: false, error: err?.message || String(err) });
        }
      }
      state.running = false;
      if (state.pending.length === 0) {
        execQueues.delete(sessionId);
      }
    }

    async function ensureMoshCompanion(session, sessionId, event) {
      if (session?.type !== "mosh" || typeof ensureMoshStatsConnection !== "function") {
        return;
      }
      if (session.moshStatsConn && isSshConnAlive(session.moshStatsConn)) {
        return;
      }
      if (session.moshStatsConn && !isSshConnAlive(session.moshStatsConn)) {
        session.moshStatsConn = null;
      }
      if (!session.moshStatsConn && !session.moshStatsConnFailed) {
        await ensureMoshStatsConnection(session, sessionId, event?.sender);
      }
    }

    async function resolveExecConnection(session, sessionId, event) {
      if (!session) return null;

      await ensureMoshCompanion(session, sessionId, event);

      const conn = session.conn || session.moshStatsConn;
      if (!conn) return null;

      if (!isSshConnAlive(conn)) {
        if (session.moshStatsConn === conn) {
          session.moshStatsConn = null;
          await ensureMoshCompanion(session, sessionId, event);
          return session.conn || session.moshStatsConn;
        }
        return null;
      }

      return conn;
    }

    function execOnConnection(conn, command, timeoutMs, execOptions = {}) {
      return new Promise((resolve) => {
        let settled = false;
        let activeStream = null;
        const settle = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => {
          settle({ success: false, error: "Command timeout" });
          try { if (activeStream) activeStream.close(); } catch { /* ignore */ }
        }, timeoutMs);

        try {
          conn.exec(command, (err, stream) => {
            if (err) {
              settle({ success: false, error: err.message || String(err) });
              return;
            }
            activeStream = stream;
            let stdout = "";
            let stderr = "";
            stream.on("data", (chunk) => { stdout += chunk.toString(); });
            if (stream.stderr) {
              stream.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
            }
            if (typeof execOptions.stdin === "string") {
              stream.write(execOptions.stdin);
              stream.end();
            }
            stream.on("close", (code) => {
              settle({ success: true, stdout, stderr, code: code ?? 0 });
            });
          });
        } catch (err) {
          settle({ success: false, error: err?.message || String(err) });
        }
      });
    }

    async function execOnSshSession(session, sessionId, command, timeoutMs, event, execOptions = {}, allowCompanionRetry = true) {
      if (session?.type === "et") {
        if (typeof execOnEtSession !== "function") {
          return { success: false, error: "ET command executor unavailable" };
        }
        return execOnEtSession(session, command, timeoutMs, {
          requireTrustedHost: true,
          knownHosts: session.etStatsAuth?.knownHosts,
          stdin: execOptions.stdin,
        });
      }

      const conn = await resolveExecConnection(session, sessionId, event);
      if (!conn) {
        if (session?.type === "mosh" && !session.moshStatsAuth && !session.moshStatsConnFailed) {
          return { success: false, pending: true, error: "Mosh handshake in progress" };
        }
        return { success: false, error: "Session not found or not connected" };
      }

      const result = await execOnConnection(conn, command, timeoutMs, execOptions);
      if (
        allowCompanionRetry
        && !result.success
        && session.moshStatsConn
        && isTransportExecError(result.error)
      ) {
        session.moshStatsConn = null;
        return execOnSshSession(session, sessionId, command, timeoutMs, event, execOptions, false);
      }
      return result;
    }

    async function execOnLocalMachine(command, timeoutMs, execOptions = {}) {
      const { execFile } = require("node:child_process");
      const platform = process.platform;

      if (platform === "win32") {
        return new Promise((resolve) => {
          const child = execFile(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", command],
            { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
            (err, stdout, stderr) => {
              if (err && !stdout) {
                resolve({ success: false, error: err.message || String(err), stdout: "", stderr: String(stderr || "") });
                return;
              }
              resolve({ success: true, stdout: String(stdout || ""), stderr: String(stderr || ""), code: err?.code ?? 0 });
            },
          );
          if (typeof execOptions.stdin === "string") {
            child.stdin?.end(execOptions.stdin);
          }
        });
      }

      return new Promise((resolve) => {
        const child = execFile(
          "sh",
          ["-c", command],
          { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
          (err, stdout, stderr) => {
            if (err && !stdout) {
              resolve({ success: false, error: err.message || String(err), stdout: "", stderr: String(stderr || "") });
              return;
            }
            resolve({ success: true, stdout: String(stdout || ""), stderr: String(stderr || ""), code: err?.code ?? 0 });
          },
        );
        if (typeof execOptions.stdin === "string") {
          child.stdin?.end(execOptions.stdin);
        }
      });
    }

    async function execOnSessionInner(event, sessionId, command, timeoutMs = 8000, execOptions = {}) {
      const session = getSession(sessionId);
      if (!session) {
        execQueues.delete(sessionId);
        return { success: false, error: "Session not found" };
      }

      if (session.protocol === "local" || session.type === "local") {
        return execOnLocalMachine(command, timeoutMs, execOptions);
      }

      if (session.conn || session.type === "mosh" || session.type === "et") {
        return execOnSshSession(session, sessionId, command, timeoutMs, event, execOptions);
      }

      return { success: false, error: "Session not supported for system management" };
    }

    async function execOnSession(event, sessionId, command, timeoutMs = 8000, execOptions = {}) {
      return enqueueExec(sessionId, () => execOnSessionInner(event, sessionId, command, timeoutMs, execOptions));
    }

    function isLocalSession(sessionId) {
      const session = getSession(sessionId);
      return !!(session?.protocol === "local" || session?.type === "local");
    }

    return { execOnSession, execOnLocalMachine, isLocalSession, getSession };
  }
}

module.exports = { createExecOnSessionApi };
