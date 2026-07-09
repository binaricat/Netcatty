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

function normalizeDialogOption(option) {
  if (typeof option === "string") {
    if (!option) {
      throw new Error("Dialog option value is required");
    }
    return {
      label: option,
      value: option,
      description: undefined,
      disabled: false,
    };
  }
  if (!option || typeof option !== "object") {
    throw new Error("Dialog option must be a string or object");
  }
  const value = String(option.value ?? "");
  if (!value) {
    throw new Error("Dialog option value is required");
  }
  return {
    label: String(option.label ?? value),
    value,
    description: option.description == null ? undefined : String(option.description),
    disabled: Boolean(option.disabled),
  };
}

function normalizeChoiceOptions(fieldType, options, defaultValue) {
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error(`Dialog ${fieldType} field requires at least one option`);
  }
  const normalizedOptions = options.map(normalizeDialogOption);
  const seenValues = new Set();
  for (const option of normalizedOptions) {
    if (seenValues.has(option.value)) {
      throw new Error(`Dialog ${fieldType} field option values must be unique: ${option.value}`);
    }
    seenValues.add(option.value);
  }
  const firstEnabled = normalizedOptions.find((option) => !option.disabled);
  if (!firstEnabled) {
    throw new Error(`Dialog ${fieldType} field requires at least one enabled option`);
  }
  const defaultText = defaultValue == null ? undefined : String(defaultValue);
  const selected = normalizedOptions.find((option) => option.value === defaultText && !option.disabled);
  return {
    options: normalizedOptions,
    defaultValue: selected ? selected.value : firstEnabled.value,
  };
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeConditionValue(value, context) {
  const valueType = typeof value;
  if (valueType === "string" || valueType === "boolean") {
    return value;
  }
  if (valueType === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new Error(`${context} must be a string, number, or boolean`);
}

function normalizeDialogCondition(condition, context = "Dialog visibleWhen") {
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
    throw new Error(`${context} must be an object`);
  }
  const field = String(condition.field ?? "").trim();
  if (!field) {
    throw new Error(`${context} field is required`);
  }
  const operators = ["equals", "notEquals", "truthy", "falsy"].filter((operator) => hasOwn(condition, operator));
  if (operators.length !== 1) {
    throw new Error(`${context} requires exactly one condition operator`);
  }
  const operator = operators[0];
  if (operator === "truthy" || operator === "falsy") {
    if (condition[operator] !== true) {
      throw new Error(`${context} ${operator} must be true`);
    }
    return { field, [operator]: true };
  }
  return {
    field,
    [operator]: normalizeConditionValue(condition[operator], `${context} ${operator}`),
  };
}

function matchesNumberStep(value, step, base = 0) {
  const quotient = (value - base) / step;
  return Math.abs(quotient - Math.round(quotient)) < 1e-9;
}

function normalizeDialogField(field, seenNames) {
  if (!field || typeof field !== "object") {
    throw new Error("Dialog form field must be an object");
  }
  const type = String(field.type ?? "");
  if (!["select", "checkbox", "radio", "textarea", "number"].includes(type)) {
    throw new Error(`Unsupported dialog field type: ${type || "unknown"}`);
  }
  const name = String(field.name ?? "").trim();
  if (!name) {
    throw new Error("Dialog form field name is required");
  }
  if (["__proto__", "prototype", "constructor"].includes(name)) {
    throw new Error(`Dialog form field name is reserved: ${name}`);
  }
  if (seenNames.has(name)) {
    throw new Error(`Duplicate dialog form field name: ${name}`);
  }
  seenNames.add(name);

  const base = {
    type,
    name,
    label: String(field.label ?? name),
    description: field.description == null ? undefined : String(field.description),
    required: field.required !== false,
    visibleWhen: field.visibleWhen == null ? undefined : normalizeDialogCondition(field.visibleWhen),
  };

  if (type === "checkbox") {
    return {
      ...base,
      required: field.required === true,
      defaultValue: Boolean(field.defaultValue),
    };
  }

  if (type === "textarea") {
    return {
      ...base,
      placeholder: field.placeholder == null ? undefined : String(field.placeholder),
      defaultValue: field.defaultValue == null ? "" : String(field.defaultValue),
    };
  }

  if (type === "number") {
    const defaultNumber = field.defaultValue === undefined || field.defaultValue === null || field.defaultValue === ""
      ? undefined
      : Number(field.defaultValue);
    if (defaultNumber !== undefined && !Number.isFinite(defaultNumber)) {
      throw new Error(`Dialog number field defaultValue must be a finite number: ${name}`);
    }
    const min = field.min === undefined || field.min === null || field.min === "" ? undefined : Number(field.min);
    const max = field.max === undefined || field.max === null || field.max === "" ? undefined : Number(field.max);
    const step = field.step === undefined || field.step === null || field.step === "" ? undefined : Number(field.step);
    if (min !== undefined && !Number.isFinite(min)) {
      throw new Error(`Dialog number field min must be a finite number: ${name}`);
    }
    if (max !== undefined && !Number.isFinite(max)) {
      throw new Error(`Dialog number field max must be a finite number: ${name}`);
    }
    if (step !== undefined && (!Number.isFinite(step) || step <= 0)) {
      throw new Error(`Dialog number field step must be a positive finite number: ${name}`);
    }
    if (min !== undefined && max !== undefined && min > max) {
      throw new Error(`Dialog number field min cannot be greater than max: ${name}`);
    }
    if (defaultNumber !== undefined && min !== undefined && defaultNumber < min) {
      throw new Error(`Dialog number field defaultValue cannot be less than min: ${name}`);
    }
    if (defaultNumber !== undefined && max !== undefined && defaultNumber > max) {
      throw new Error(`Dialog number field defaultValue cannot be greater than max: ${name}`);
    }
    if (
      defaultNumber !== undefined
      && step !== undefined
      && min !== undefined
      && !matchesNumberStep(defaultNumber, step, min)
    ) {
      throw new Error(`Dialog number field defaultValue must match step from min: ${name}`);
    }
    return {
      ...base,
      placeholder: field.placeholder == null ? undefined : String(field.placeholder),
      defaultValue: defaultNumber,
      min,
      max,
      step,
    };
  }

  const choice = normalizeChoiceOptions(type, field.options, field.defaultValue);
  return {
    ...base,
    options: choice.options,
    defaultValue: choice.defaultValue,
  };
}

function normalizeDialogFormSpec(spec) {
  if (!spec || typeof spec !== "object") {
    throw new Error("Dialog form spec must be an object");
  }
  if (!Array.isArray(spec.fields) || spec.fields.length === 0) {
    throw new Error("Dialog form requires at least one field");
  }
  const seenNames = new Set();
  const fields = spec.fields.map((field) => normalizeDialogField(field, seenNames));
  const fieldIndexByName = new Map(fields.map((field, index) => [field.name, index]));
  for (const [index, field] of fields.entries()) {
    if (field.visibleWhen && !seenNames.has(field.visibleWhen.field)) {
      throw new Error(`Dialog visibleWhen references unknown field: ${field.visibleWhen.field}`);
    }
    const dependencyIndex = field.visibleWhen ? fieldIndexByName.get(field.visibleWhen.field) : undefined;
    if (dependencyIndex !== undefined && dependencyIndex >= index) {
      throw new Error(`Dialog visibleWhen must reference an earlier field: ${field.name}`);
    }
  }
  return {
    title: spec.title == null ? undefined : String(spec.title),
    message: spec.message == null ? "" : String(spec.message),
    submitLabel: spec.submitLabel == null ? undefined : String(spec.submitLabel),
    cancelLabel: spec.cancelLabel == null ? undefined : String(spec.cancelLabel),
    fields,
  };
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

  function assertNotAborted() {
    if (deps.isAborted?.()) {
      throw new Error("Script stopped");
    }
  }

  function abortable(promise) {
    if (typeof deps.isAborted !== "function") {
      return promise;
    }
    assertNotAborted();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        callback(value);
      };
      const timer = setInterval(() => {
        if (!deps.isAborted?.()) return;
        finish(reject, new Error("Script stopped"));
      }, 50);
      Promise.resolve(promise).then(
        (value) => {
          if (deps.isAborted?.()) {
            finish(reject, new Error("Script stopped"));
            return;
          }
          finish(resolve, value);
        },
        (err) => {
          if (deps.isAborted?.()) {
            finish(reject, new Error("Script stopped"));
            return;
          }
          finish(reject, err);
        },
      );
    });
  }

  function markHandled(promise) {
    Promise.resolve(promise).catch(() => {});
    return promise;
  }

  async function ignoreIfStopped(task) {
    try {
      return await task();
    } catch (err) {
      if (deps.isAborted?.() && err?.message === "Script stopped") {
        return undefined;
      }
      throw err;
    }
  }

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
    assertNotAborted();
    stepIndex += 1;
    const activityLabel = truncateActivityLabel(label);
    emitStatus({
      activityLabel,
      currentStep: activityLabel,
    });
  }

  async function refreshScreenSnapshot() {
    assertNotAborted();
    if (typeof getScreenSnapshot === "function") {
      try {
        screenSnapshot = await abortable(getScreenSnapshot(sessionId));
      } catch {
        // fall back to output buffer text
      }
    }
    assertNotAborted();
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
        assertNotAborted();
        const action = await abortable(showWaitForTimeoutDialog?.("shell prompt", timeoutMs));
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
        assertNotAborted();
        const action = await abortable(showWaitForTimeoutDialog?.(label, timeoutMs));
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
        assertNotAborted();
        const action = await abortable(showWaitForTimeoutDialog?.(patternLabel, timeoutMs));
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
      return markHandled(trackStep(`sleep ${delay}ms`).then(() => interruptibleSleep(delay, deps.isAborted)));
    },
    startLog(path) {
      return markHandled(ignoreIfStopped(async () => {
        if (deps.isAborted?.()) return;
        assertWriteAllowed("session.startLog");
        await trackStep("startLog");
        if (deps.isAborted?.()) return;
        await startSessionLog?.(sessionId, path);
      }));
    },
    stopLog() {
      return markHandled((async () => {
        await stopSessionLog?.(sessionId);
      })());
    },
    disconnect() {
      return markHandled(ignoreIfStopped(async () => {
        if (deps.isAborted?.()) return;
        assertWriteAllowed("session.disconnect");
        await trackStep("disconnect");
        if (deps.isAborted?.()) return;
        await disconnectSession?.(sessionId);
      }));
    },
  };

  const screenApi = {
    send(text) {
      return markHandled(ignoreIfStopped(async () => {
        if (deps.isAborted?.()) return;
        assertWriteAllowed("screen.send");
        await waitIfPaused();
        const payload = String(text ?? "");
        await trackStep(`send: ${truncateActivityLabel(formatScriptInputForLog(payload), 60)}`);
        if (deps.isAborted?.()) return;
        appendLog(runId, `→ ${formatScriptInputForLog(payload)}`);
        writeToSession(sessionId, payload, { automated: true });
      }));
    },
    sendLine(text) {
      return markHandled(ignoreIfStopped(async () => {
        if (deps.isAborted?.()) return;
        assertWriteAllowed("screen.sendLine");
        await waitIfPaused();
        const line = String(text ?? "");
        await trackStep(`sendLine: ${truncateActivityLabel(line, 60)}`);
        if (deps.isAborted?.()) return;
        appendLog(runId, `→ ${line}`);
        // Bastion menus can ignore a single "line\r" packet even when
        // stream.write succeeds. Match xterm: body, then Enter (#1960).
        // Consume only pre-send buffer length so prompts that arrive between
        // body and CR stay waitable for the next step.
        const buffer = getOutputBuffer(sessionId);
        const lengthBeforeSend = buffer.getText().length;
        if (line.length > 0) {
          writeToSession(sessionId, line, {
            automated: true,
            invalidateStartupSeed: false,
          });
          await interruptibleSleep(30, deps.isAborted);
          if (deps.isAborted?.()) return;
        }
        writeToSession(sessionId, "\r", {
          automated: true,
          invalidateStartupSeed: false,
        });
        buffer.consumeThroughAbsolute(lengthBeforeSend);
      }));
    },
    waitFor(pattern, timeoutMs = 30000) {
      return markHandled(waitForWithRecovery(pattern, timeoutMs));
    },
    waitForText(text, timeoutMs = 30000) {
      return markHandled(waitForWithRecovery(text, timeoutMs, {
        waitMethod: "waitForText",
        operationLabel: "waitForText",
      }));
    },
    waitForRegex(pattern, timeoutMs = 30000) {
      return markHandled(waitForWithRecovery(pattern, timeoutMs, {
        waitMethod: "waitForRegex",
        operationLabel: "waitForRegex",
      }));
    },
    waitForPrompt(timeoutMs = 60000) {
      return markHandled(waitForPromptWithRecovery(timeoutMs));
    },
    waitForAny(patterns, timeoutMs = 30000) {
      return markHandled(waitForAnyWithRecovery(patterns, timeoutMs));
    },
    getText(startRow, endRow) {
      return markHandled((async () => {
        await refreshScreenSnapshot();
        assertNotAborted();
        const lines = screenSnapshot.lines || [];
        const start = typeof startRow === "number" ? Math.max(0, startRow) : 0;
        const end = typeof endRow === "number" ? Math.min(lines.length - 1, endRow) : lines.length - 1;
        if (lines.length === 0) {
          return getOutputBuffer(sessionId).getText();
        }
        return lines.slice(start, end + 1).join("\n");
      })());
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
    clear() {
      return markHandled(ignoreIfStopped(async () => {
        if (deps.isAborted?.()) return;
        assertWriteAllowed("screen.clear");
        await trackStep("clear");
        if (deps.isAborted?.()) return;
        writeToSession(sessionId, "\x1b[2J\x1b[H", { automated: true });
      }));
    },
  };

  const dialogApi = {
    alert(message) {
      assertNotAborted();
      return markHandled(showDialog("alert", String(message ?? "")));
    },
    confirm(message) {
      assertNotAborted();
      return markHandled(showDialog("confirm", String(message ?? "")));
    },
    prompt(message, defaultValue = "") {
      assertNotAborted();
      return markHandled(showDialog("prompt", String(message ?? ""), String(defaultValue ?? "")));
    },
    form(spec) {
      assertNotAborted();
      const form = normalizeDialogFormSpec(spec);
      return markHandled(showDialog("form", form.message, undefined, { form }));
    },
    select(message, options, defaultValue) {
      return markHandled((async () => {
        const values = await dialogApi.form({
          message,
          fields: [{
            type: "select",
            name: "value",
            label: message,
            options,
            defaultValue,
          }],
        });
        return String(values?.value ?? "");
      })());
    },
    radio(message, options, defaultValue) {
      return markHandled((async () => {
        const values = await dialogApi.form({
          message,
          fields: [{
            type: "radio",
            name: "value",
            label: message,
            options,
            defaultValue,
          }],
        });
        return String(values?.value ?? "");
      })());
    },
    checkbox(message, defaultChecked = false) {
      return markHandled((async () => {
        const values = await dialogApi.form({
          message,
          fields: [{
            type: "checkbox",
            name: "value",
            label: message,
            defaultValue: defaultChecked,
          }],
        });
        return Boolean(values?.value);
      })());
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
      if (deps.isAborted?.()) return;
      assertNotAborted();
      stepIndex += 1;
      emitStatus({
        activityLabel: "log",
        currentStep: "log",
      });
      appendLog(runId, String(message ?? ""));
    },
  };

  async function waitIfPaused() {
    assertNotAborted();
    while (isPaused?.()) {
      assertNotAborted();
      onStatusChange?.(runId, { status: "paused", elapsedMs: Math.max(0, Date.now() - startedAt) });
      await interruptibleSleep(100, deps.isAborted);
    }
    assertNotAborted();
    onStatusChange?.(runId, { status: "running", elapsedMs: Math.max(0, Date.now() - startedAt) });
  }

  async function execute(source) {
    assertNotAborted();
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
      await abortable(result);
    }
    assertNotAborted();
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
  normalizeDialogFormSpec,
};
