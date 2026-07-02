"use strict";

const vm = require("node:vm");
const { shellPromptPatterns } = require("./shellPromptPatterns.cjs");

function wrapScriptSource(source) {
  const trimmed = String(source || "").trim();
  if (!trimmed) {
    throw new Error("Script content is empty");
  }

  if (/^\(\s*async\s*\(\s*\)\s*=>/m.test(trimmed) || /^\(\s*async\s+function\s*\(\s*\)\s*\{/m.test(trimmed)) {
    return trimmed;
  }

  const hasMainFunction = /\basync\s+function\s+main\s*\(/m.test(trimmed) || /\bfunction\s+main\s*\(/m.test(trimmed);
  if (hasMainFunction) {
    const body = trimmed.replace(/\n\s*;?\s*await\s+main\s*\(\s*\)\s*;?\s*$/m, "").trimEnd();
    const invokeMain = /\basync\s+function\s+main\s*\(/m.test(body)
      ? "await main();"
      : "await Promise.resolve(main());";
    return `(async () => {\n${body}\n${invokeMain}\n})();`;
  }

  return `(async () => {\n${trimmed}\n})();`;
}

function truncateActivityLabel(value, max = 80) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function createScriptRuntime(deps) {
  const {
    sessionId,
    runId,
    appendLog,
    writeToSession,
    getOutputBuffer,
    getScreenSnapshot,
    getSessionMeta,
    showDialog,
    showWaitForTimeoutDialog,
    disconnectSession,
    startSessionLog,
    stopSessionLog,
    onStatusChange,
    isPaused,
    permissionMode = "auto",
    startedAt = Date.now(),
  } = deps;

  let stepIndex = 0;
  let progressMode = "activity";
  let progressLabel;
  let progressCurrent = 0;
  let progressTotal = 0;

  let screenSnapshot = {
    rows: 24,
    cols: 80,
    currentRow: 0,
    lines: [],
  };

  function emitStatus(patch = {}) {
    onStatusChange?.(runId, {
      progressMode,
      progressLabel: progressMode === "determinate" ? progressLabel : undefined,
      progressCurrent: progressMode === "determinate" ? progressCurrent : undefined,
      progressTotal: progressMode === "determinate" ? progressTotal : undefined,
      elapsedMs: Math.max(0, Date.now() - startedAt),
      stepIndex,
      status: "running",
      ...patch,
    });
  }

  function assertWriteAllowed(operation) {
    if (permissionMode !== "observer") return;
    throw new Error(`Observer mode: ${operation} is disabled. Switch to Confirm or Auto mode.`);
  }

  async function trackStep(label) {
    stepIndex += 1;
    const activityLabel = truncateActivityLabel(label);
    emitStatus({
      activityLabel,
      currentStep: activityLabel,
    });
  }

  async function refreshScreenSnapshot() {
    if (typeof getScreenSnapshot === "function") {
      try {
        screenSnapshot = await getScreenSnapshot(sessionId);
      } catch {
        // fall back to output buffer text
      }
    }
    return screenSnapshot;
  }

  async function waitForPromptWithRecovery(timeoutMs = 60000) {
    let stepTracked = false;
    while (true) {
      if (deps.isAborted?.()) {
        throw new Error("Script stopped");
      }
      if (!stepTracked) {
        await trackStep("waitForPrompt");
        stepTracked = true;
      }
      onStatusChange?.(runId, { waitingFor: "shell prompt", status: "running", elapsedMs: Math.max(0, Date.now() - startedAt) });
      try {
        return await getOutputBuffer(sessionId).waitForAny(
          shellPromptPatterns(),
          timeoutMs,
          () => Boolean(deps.isAborted?.()),
          { allowPreservedTailMatch: true },
        );
      } catch (err) {
        if (!String(err?.message || err).includes("timed out")) {
          throw err;
        }
        onStatusChange?.(runId, { status: "paused", waitingFor: "shell prompt", elapsedMs: Math.max(0, Date.now() - startedAt) });
        const action = await showWaitForTimeoutDialog?.("shell prompt", timeoutMs);
        onStatusChange?.(runId, { status: "running" });
        if (action === "retry") {
          continue;
        }
        if (action === "skip") {
          return -1;
        }
        throw new Error("Script stopped by user");
      } finally {
        onStatusChange?.(runId, { waitingFor: undefined, status: "running", elapsedMs: Math.max(0, Date.now() - startedAt) });
      }
    }
  }

  async function waitForAnyWithRecovery(patterns, timeoutMs = 30000) {
    const label = Array.isArray(patterns)
      ? patterns.map((pattern) => (pattern instanceof RegExp ? pattern.source : String(pattern))).join(" | ")
      : String(patterns);
    let stepTracked = false;
    while (true) {
      if (deps.isAborted?.()) {
        throw new Error("Script stopped");
      }
      if (!stepTracked) {
        await trackStep(`waitForAny ${truncateActivityLabel(label, 60)}`);
        stepTracked = true;
      }
      onStatusChange?.(runId, { waitingFor: label, status: "running", elapsedMs: Math.max(0, Date.now() - startedAt) });
      try {
        return await getOutputBuffer(sessionId).waitForAny(
          patterns,
          timeoutMs,
          () => Boolean(deps.isAborted?.()),
        );
      } catch (err) {
        if (!String(err?.message || err).includes("timed out")) {
          throw err;
        }
        onStatusChange?.(runId, { status: "paused", waitingFor: label, elapsedMs: Math.max(0, Date.now() - startedAt) });
        const action = await showWaitForTimeoutDialog?.(label, timeoutMs);
        onStatusChange?.(runId, { status: "running" });
        if (action === "retry") {
          continue;
        }
        if (action === "skip") {
          return -1;
        }
        throw new Error("Script stopped by user");
      } finally {
        onStatusChange?.(runId, { waitingFor: undefined, status: "running", elapsedMs: Math.max(0, Date.now() - startedAt) });
      }
    }
  }

  async function waitForWithRecovery(pattern, timeoutMs = 30000, options = {}) {
    const waitMethod = options.waitMethod || "waitFor";
    const operationLabel = options.operationLabel || waitMethod;
    const patternLabel = pattern instanceof RegExp ? pattern.source : String(pattern);
    let stepTracked = false;
    while (true) {
      if (deps.isAborted?.()) {
        throw new Error("Script stopped");
      }
      if (!stepTracked) {
        await trackStep(`${operationLabel} ${truncateActivityLabel(patternLabel, 60)}`);
        stepTracked = true;
      }
      onStatusChange?.(runId, { waitingFor: patternLabel, status: "running", elapsedMs: Math.max(0, Date.now() - startedAt) });
      try {
        return await getOutputBuffer(sessionId)[waitMethod](
          pattern,
          timeoutMs,
          () => Boolean(deps.isAborted?.()),
        );
      } catch (err) {
        if (!String(err?.message || err).includes("timed out")) {
          throw err;
        }
        onStatusChange?.(runId, { status: "paused", waitingFor: patternLabel, elapsedMs: Math.max(0, Date.now() - startedAt) });
        const action = await showWaitForTimeoutDialog?.(patternLabel, timeoutMs);
        onStatusChange?.(runId, { status: "running" });
        if (action === "retry") {
          continue;
        }
        if (action === "skip") {
          return "";
        }
        throw new Error("Script stopped by user");
      } finally {
        onStatusChange?.(runId, { waitingFor: undefined, status: "running", elapsedMs: Math.max(0, Date.now() - startedAt) });
      }
    }
  }

  const progressApi = {
    start(label, total) {
      progressMode = "determinate";
      progressLabel = truncateActivityLabel(label || "Progress", 60);
      progressTotal = Math.max(1, Number(total) || 1);
      progressCurrent = 0;
      emitStatus({
        progressMode,
        progressLabel,
        progressCurrent,
        progressTotal,
        activityLabel: progressLabel,
      });
    },
    set(current, detail) {
      if (progressMode !== "determinate") return;
      progressCurrent = Math.max(0, Math.min(progressTotal, Number(current) || 0));
      const patch = {
        progressCurrent,
        progressTotal,
        progressLabel,
      };
      if (detail !== undefined && detail !== null && detail !== "") {
        patch.activityLabel = truncateActivityLabel(detail);
      }
      emitStatus(patch);
    },
    step(detail) {
      if (progressMode !== "determinate") return;
      progressCurrent = Math.min(progressTotal, progressCurrent + 1);
      const patch = {
        progressCurrent,
        progressTotal,
        progressLabel,
      };
      if (detail !== undefined && detail !== null && detail !== "") {
        patch.activityLabel = truncateActivityLabel(detail);
      }
      emitStatus(patch);
    },
    done() {
      if (progressMode !== "determinate") return;
      progressCurrent = progressTotal;
      emitStatus({
        progressCurrent,
        progressTotal,
        progressLabel,
      });
      progressMode = "activity";
      progressLabel = undefined;
      progressCurrent = 0;
      progressTotal = 0;
      emitStatus({
        progressMode: "activity",
        progressLabel: undefined,
        progressCurrent: undefined,
        progressTotal: undefined,
      });
    },
  };

  const sessionApi = {
    get connected() {
      const meta = getSessionMeta?.(sessionId);
      return Boolean(meta?.connected);
    },
    get hostname() {
      return getSessionMeta?.(sessionId)?.hostname || "";
    },
    get username() {
      return getSessionMeta?.(sessionId)?.username || "";
    },
    sleep(ms) {
      const delay = Math.max(0, Number(ms) || 0);
      return trackStep(`sleep ${delay}ms`).then(() => interruptibleSleep(delay, deps.isAborted));
    },
    async startLog(path) {
      assertWriteAllowed("session.startLog");
      await trackStep("startLog");
      await startSessionLog?.(sessionId, path);
    },
    async stopLog() {
      await trackStep("stopLog");
      await stopSessionLog?.(sessionId);
    },
    async disconnect() {
      assertWriteAllowed("session.disconnect");
      await trackStep("disconnect");
      await disconnectSession?.(sessionId);
    },
  };

  const screenApi = {
    async send(text) {
      assertWriteAllowed("screen.send");
      await waitIfPaused();
      const payload = String(text ?? "");
      await trackStep(`send: ${truncateActivityLabel(formatScriptInputForLog(payload), 60)}`);
      appendLog(runId, `→ ${formatScriptInputForLog(payload)}`);
      writeToSession(sessionId, payload, { automated: true });
    },
    async sendLine(text) {
      assertWriteAllowed("screen.sendLine");
      await waitIfPaused();
      const line = String(text ?? "");
      await trackStep(`sendLine: ${truncateActivityLabel(line, 60)}`);
      appendLog(runId, `→ ${line}`);
      writeToSession(sessionId, `${line}\r`, { automated: true });
    },
    waitFor(pattern, timeoutMs = 30000) {
      return waitForWithRecovery(pattern, timeoutMs);
    },
    waitForText(text, timeoutMs = 30000) {
      return waitForWithRecovery(text, timeoutMs, {
        waitMethod: "waitForText",
        operationLabel: "waitForText",
      });
    },
    waitForRegex(pattern, timeoutMs = 30000) {
      return waitForWithRecovery(pattern, timeoutMs, {
        waitMethod: "waitForRegex",
        operationLabel: "waitForRegex",
      });
    },
    waitForPrompt(timeoutMs = 60000) {
      return waitForPromptWithRecovery(timeoutMs);
    },
    async waitForAny(patterns, timeoutMs = 30000) {
      return waitForAnyWithRecovery(patterns, timeoutMs);
    },
    async getText(startRow, endRow) {
      await refreshScreenSnapshot();
      const lines = screenSnapshot.lines || [];
      const start = typeof startRow === "number" ? Math.max(0, startRow) : 0;
      const end = typeof endRow === "number" ? Math.min(lines.length - 1, endRow) : lines.length - 1;
      if (lines.length === 0) {
        return getOutputBuffer(sessionId).getText();
      }
      return lines.slice(start, end + 1).join("\n");
    },
    get currentRow() {
      return screenSnapshot.currentRow ?? 0;
    },
    get rows() {
      return screenSnapshot.rows ?? 24;
    },
    get cols() {
      return screenSnapshot.cols ?? 80;
    },
    async clear() {
      assertWriteAllowed("screen.clear");
      await trackStep("clear");
      writeToSession(sessionId, "\x1b[2J\x1b[H", { automated: true });
    },
  };

  const dialogApi = {
    alert(message) {
      return showDialog("alert", String(message ?? ""));
    },
    confirm(message) {
      return showDialog("confirm", String(message ?? ""));
    },
    prompt(message, defaultValue = "") {
      return showDialog("prompt", String(message ?? ""), String(defaultValue ?? ""));
    },
  };

  const nct = {
    session: sessionApi,
    screen: screenApi,
    dialog: dialogApi,
    progress: progressApi,
    version: deps.appVersion || "0.0.0",
    sleep: sessionApi.sleep.bind(sessionApi),
    log(message) {
      stepIndex += 1;
      emitStatus({
        activityLabel: "log",
        currentStep: "log",
      });
      appendLog(runId, String(message ?? ""));
    },
  };

  async function waitIfPaused() {
    while (isPaused?.()) {
      if (deps.isAborted?.()) {
        throw new Error("Script stopped");
      }
      onStatusChange?.(runId, { status: "paused", elapsedMs: Math.max(0, Date.now() - startedAt) });
      await interruptibleSleep(100, deps.isAborted);
    }
    onStatusChange?.(runId, { status: "running", elapsedMs: Math.max(0, Date.now() - startedAt) });
  }

  async function execute(source) {
    if (deps.isAborted?.()) {
      throw new Error("Script stopped");
    }
    const wrapped = wrapScriptSource(source);
    const sandbox = {
      nct,
      console: {
        log: (...args) => {
          appendLog(runId, args.map((arg) => String(arg)).join(" "));
        },
      },
    };
    vm.createContext(sandbox);
    const script = new vm.Script(wrapped, { filename: `script-${runId}.js` });
    const result = script.runInContext(sandbox, { displayErrors: true });
    if (result && typeof result.then === "function") {
      await result;
    }
  }

  return { execute, nct };
}

function interruptibleSleep(ms, isAborted) {
  const delay = Math.max(0, Number(ms) || 0);
  if (!isAborted) {
    return new Promise((resolve) => setTimeout(resolve, delay));
  }
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (isAborted()) {
        clearInterval(timer);
        reject(new Error("Script stopped"));
        return;
      }
      if (Date.now() - startedAt >= delay) {
        clearInterval(timer);
        resolve(undefined);
      }
    }, 50);
  });
}

function formatScriptInputForLog(data) {
  return String(data ?? "")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/\x03/g, "^C")
    .replace(/\x1b/g, "\\e");
}

module.exports = {
  createScriptRuntime,
  wrapScriptSource,
  interruptibleSleep,
  formatScriptInputForLog,
};
