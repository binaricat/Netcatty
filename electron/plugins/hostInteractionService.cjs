"use strict";

const { createHmac, randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createDefinitionValidator } = require("./contractValidator.cjs");
const { TerminalSelectionAuthority } = require("./terminalSelectionAuthority.cjs");
const { PluginRpcError, RPC_ERRORS } = require("./rpcRouter.cjs");
const schema = require("./generated/plugin-contract.schema.json");
const LIMITS = schema.$defs.HostInteractionLimits.const;
const HOST_INTERACTION_FEATURE = schema.$defs.HostInteractionFeature.const;
const validateRequest = createDefinitionValidator("HostInteractionRequest");
const validateResponse = createDefinitionValidator("HostInteractionResponse");
const validateResult = createDefinitionValidator("HostInteractionResult");
const validateSingleLineInput = createDefinitionValidator("HostSingleLineInputText");
const validateOpenFile = createDefinitionValidator("HostOpenFileRequest");
const validateSaveFile = createDefinitionValidator("HostSaveFileRequest");
const validateReadFileHandle = createDefinitionValidator("HostFileHandleReadRequest");
const validateWriteFileHandle = createDefinitionValidator("HostFileHandleWriteRequest");
const validateCloseFileHandle = createDefinitionValidator("HostFileHandleCloseRequest");
const PROMPT_CHANNEL = "netcatty:plugins:host-interaction";

const INLINE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILE_HANDLES_PER_RUNTIME = 16;
const MAX_FILE_HANDLES_TOTAL = 64;

function tryLoadElectronDialog() {
  try {
    return require("electron")?.dialog ?? null;
  } catch {
    return null;
  }
}

function fail(code, message) { return new PluginRpcError(RPC_ERRORS[code], message); }
function assertTextBytes(text, limit = LIMITS.textBytes) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > limit || text.includes("\0")) {
    throw fail("resourceExhausted", "Host interaction text exceeds its limit");
  }
  return text;
}
function assertInteractionRequest(params) {
  if (!validateRequest(params)) throw fail("invalidArgument", "Host interaction request is invalid");
  if (Buffer.byteLength(JSON.stringify(params)) > LIMITS.requestBytes) {
    throw fail("resourceExhausted", "Host interaction request exceeds its limit");
  }
  if (params.kind === "input") assertTextBytes(params.initialValue ?? "", LIMITS.textBytes);
  if (params.kind === "clipboard.write") assertTextBytes(params.text, LIMITS.clipboardBytes);
  if (params.kind === "terminal.input.propose" && Buffer.byteLength(params.text, "utf8") > LIMITS.textBytes) throw fail("resourceExhausted", "Terminal input draft exceeds its limit");
  if (params.kind === "quickPick" && new Set(params.items.map((item) => item.id)).size !== params.items.length) {
    throw fail("invalidArgument", "Host interaction choice IDs must be unique");
  }
  return Object.freeze(structuredClone(params));
}
function interactionAuthorization(params, terminalTarget) {
  if (params.kind === "terminal.selection.read" || params.kind === "terminal.input.propose") {
    if (!terminalTarget) throw fail("failedPrecondition", "A host-selected terminal is required");
    return { permission: params.kind, resources: [terminalTarget.resource],
      reason: params.kind === "terminal.selection.read" ? "Preview and explicitly share the selected terminal text" : "Open an editable host draft without sending terminal input", operationId: params.kind, allowedScopes: ["once"], deferDecision: true };
  }
  if (params.kind === "network.stream.confirm" || params.kind === "network.stream.tlsConfirm") {
    return {
      permission: "network.stream",
      resources: [params.endpoint],
      reason: params.kind === "network.stream.tlsConfirm"
        ? "Review an untrusted TLS certificate before continuing"
        : `Confirm byte stream connection to ${params.endpoint}`,
      operationId: `ui:${params.kind}`,
      deferDecision: true,
    };
  }
  const permission = params.kind === "clipboard.read" ? "clipboard.read"
    : params.kind === "clipboard.write" ? "clipboard.write" : "ui.interact";
  return {
    permission,
    resources: [permission.startsWith("clipboard.") ? "clipboard:text" : "*"],
    reason: permission.startsWith("clipboard.") ? "Explicitly share or replace clipboard text" : "Show a host input or choice dialog",
    operationId: `ui:${params.kind}`,
    deferDecision: true,
    ...(permission.startsWith("clipboard.") ? { allowedScopes: ["once"] } : {}),
  };
}

class PluginHostInteractionService {
  constructor(options) {
    this.database = options.database;
    this.permissionEngine = options.permissionEngine;
    this.quotaManager = options.quotaManager;
    this.clipboard = options.clipboard;
    this.dialog = options.dialog ?? tryLoadElectronDialog();
    this.getWindow = options.getWindow ?? (() => null);
    this.isLocked = options.isLocked ?? (() => true);
    this.clock = options.clock ?? Date.now;
    this.timeoutMs = Math.min(options.timeoutMs ?? LIMITS.timeoutMs, LIMITS.timeoutMs);
    this.key = randomBytes(32);
    this.pending = new Map();
    this.fileHandles = new Map();
    this.terminalSelection = new TerminalSelectionAuthority({database: this.database, getWindow: this.getWindow, getManager: options.getTerminalWorkerManager, clock: this.clock});
    this.terminalInvalidation = this.terminalSelection.onDidInvalidate(() => {
      for (const entry of [...this.pending.values()]) if (entry.terminalTarget && !this.#terminalCurrent(entry)) {
        this.#finish(entry, null, fail("cancelled", "Selected terminal connection changed"));
      }
    });
    this.rates = new Map();
    this.admissions = new WeakMap();
    this.admissionGuards = new Map();
    this.admissionRevision = 0;
    this.focusRestoreMs = Math.min(options.focusRestoreMs ?? 1_000, 1_000);
    this.owner = null;
    this.ownerGeneration = 0;
    this.ownerCleanup = null;
    this.closed = false;
    this.revocation = this.permissionEngine.onDidRevoke((event) => this.releasePlugin(event.pluginId));
    this.unsubscribeLock = options.subscribeLock?.((state) => { if (state.locked) this.cancelAll(); });
  }

  #terminalCurrent(entry) {
    if (!this.terminalSelection.isCurrent(entry.terminalTarget)) return false;
    if (entry.params.kind === "terminal.input.propose") {
      try { this.terminalSelection.resolve(entry.params.handle, entry.context); } catch { return false; }
    }
    return true;
  }

  registerRpcCapabilities(registry) {
    const fileAuth = (operation) => ({
      permission: "ui.interact",
      resources: ["*"],
      reason: operation === "open"
        ? "Open a user-selected file via native file dialog"
        : operation === "save"
          ? "Save a file via native save dialog"
          : "Access a user-selected file handle",
      operationId: `ui:file:${operation}`,
      deferDecision: true,
    });
    registry.registerRequest("ui.openFile", (params, context) => this.openFile(params, context), {
      metadata: { capability: "ui", mutating: false },
      validateParams: (params) => {
        const normalized = params === undefined || params === null ? {} : params;
        if (!validateOpenFile(normalized)) throw fail("invalidArgument", "Open file parameters are invalid");
        return Object.freeze(structuredClone(normalized));
      },
      authorization: () => fileAuth("open"),
    });
    registry.registerRequest("ui.saveFile", (params, context) => this.saveFile(params, context), {
      metadata: { capability: "ui", mutating: true },
      validateParams: (params) => {
        const normalized = params === undefined || params === null ? {} : params;
        if (!validateSaveFile(normalized)) throw fail("invalidArgument", "Save file parameters are invalid");
        return Object.freeze(structuredClone(normalized));
      },
      authorization: () => fileAuth("save"),
    });
    registry.registerRequest("ui.readFileHandle", (params, context) => this.readFileHandle(params, context), {
      metadata: { capability: "ui", mutating: false },
      validateParams: (params) => {
        if (!validateReadFileHandle(params)) throw fail("invalidArgument", "File handle read parameters are invalid");
        return Object.freeze(structuredClone(params));
      },
      authorization: () => fileAuth("readHandle"),
    });
    registry.registerRequest("ui.writeFileHandle", (params, context) => this.writeFileHandle(params, context), {
      metadata: { capability: "ui", mutating: true },
      validateParams: (params) => {
        if (!validateWriteFileHandle(params)) throw fail("invalidArgument", "File handle write parameters are invalid");
        return Object.freeze(structuredClone(params));
      },
      authorization: () => fileAuth("writeHandle"),
    });
    registry.registerRequest("ui.closeFileHandle", (params, context) => this.closeFileHandle(params, context), {
      metadata: { capability: "ui", mutating: true },
      validateParams: (params) => {
        if (!validateCloseFileHandle(params)) throw fail("invalidArgument", "File handle close parameters are invalid");
        return Object.freeze(structuredClone(params));
      },
      authorization: () => fileAuth("closeHandle"),
    });
    registry.registerRequest("ui.interact", (params, context) => this.request(params, context), {
      metadata: { capability: "ui", mutating: true },
      validateParams: assertInteractionRequest,
      authorization: (params, context) => {
        const admission = this.admitRequest(params, context);
        return interactionAuthorization(params, admission.terminalTarget);
      },
    });
  }

  #assertFileDialogPermission(context) {
    const mode = this.permissionEngine.getMode?.(context, "ui.interact") ?? "allow";
    if (mode === "deny") throw fail("permissionDenied", "Plugin permission is disabled");
  }

  #allocateFileHandle(context, filePath) {
    const runtimeCount = [...this.fileHandles.values()].filter((h) => h.runtimeId === context.runtimeId).length;
    if (runtimeCount >= MAX_FILE_HANDLES_PER_RUNTIME || this.fileHandles.size >= MAX_FILE_HANDLES_TOTAL) {
      throw fail("resourceExhausted", "Too many open file handles");
    }
    const id = randomUUID();
    const handle = {
      id,
      pluginId: context.pluginId,
      runtimeId: context.runtimeId,
      sourceOwner: context.sourceOwner,
      filePath,
      name: path.basename(filePath),
      stagingPath: null,
      stagingBytes: 0,
      createdAt: this.clock(),
    };
    this.fileHandles.set(id, handle);
    return handle;
  }

  #getFileHandle(handleId, context) {
    const handle = this.fileHandles.get(handleId);
    if (!handle || handle.pluginId !== context.pluginId || handle.runtimeId !== context.runtimeId
      || handle.sourceOwner !== context.sourceOwner) {
      throw fail("permissionDenied", "File handle is invalid or closed");
    }
    return handle;
  }

  async #disposeFileHandle(handle) {
    if (!handle) return;
    this.fileHandles.delete(handle.id);
    if (handle.stagingPath) {
      const temp = handle.stagingPath;
      handle.stagingPath = null;
      handle.stagingBytes = 0;
      await fs.unlink(temp).catch(() => {});
    }
  }

  async openFile(params, context) {
    await context.assertActive();
    this.#assertFileDialogPermission(context);
    if (this.closed || this.isLocked()) {
      throw fail("unavailable", "Host file dialogs require an unlocked window");
    }
    if (typeof this.dialog?.showOpenDialog !== "function") {
      throw fail("unavailable", "Native file dialog is unavailable");
    }
    const window = this.getWindow();
    const dialogOptions = {
      title: params.title ?? "Open File",
      properties: ["openFile"],
      ...(params.filters?.length ? { filters: params.filters } : {}),
    };
    const picked = window && !window.isDestroyed?.()
      ? await this.dialog.showOpenDialog(window, dialogOptions)
      : await this.dialog.showOpenDialog(dialogOptions);
    await context.assertActive();
    if (this.closed || this.isLocked()) {
      throw fail("cancelled", "Host locked during file selection");
    }
    if (!picked || picked.canceled || !Array.isArray(picked.filePaths) || picked.filePaths.length === 0) {
      return { cancelled: true };
    }
    const filePath = picked.filePaths[0];
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      throw fail("invalidArgument", "Selected path is not a regular file");
    }
    const maxBytes = Math.min(params.maxBytes ?? LIMITS.fileMaxBytes, LIMITS.fileMaxBytes);
    if (stat.size > maxBytes) {
      throw fail("resourceExhausted", `Selected file exceeds the ${maxBytes} byte limit`);
    }
    const handle = this.#allocateFileHandle(context, filePath);
    this.database?.recordSecurityAudit?.(context.pluginId, "ui.file.open", { size: stat.size });
    const encoding = params.readAs === "utf8" ? "utf8" : "base64";
    if (stat.size <= INLINE_FILE_BYTES) {
      const raw = await fs.readFile(filePath);
      await context.assertActive();
      this.quotaManager?.chargeBytes?.(context.runtimeId, "ui", raw.byteLength);
      return {
        cancelled: false,
        name: handle.name,
        size: raw.byteLength,
        handleId: handle.id,
        streamed: false,
        encoding,
        data: encoding === "utf8" ? raw.toString("utf8") : raw.toString("base64"),
      };
    }
    return {
      cancelled: false,
      name: handle.name,
      size: stat.size,
      handleId: handle.id,
      streamed: true,
      encoding,
    };
  }

  async saveFile(params, context) {
    await context.assertActive();
    this.#assertFileDialogPermission(context);
    if (this.closed || this.isLocked()) {
      throw fail("unavailable", "Host file dialogs require an unlocked window");
    }
    if (typeof this.dialog?.showSaveDialog !== "function") {
      throw fail("unavailable", "Native save dialog is unavailable");
    }
    const window = this.getWindow();
    const dialogOptions = {
      title: params.title ?? "Save File",
      ...(params.defaultName ? { defaultPath: params.defaultName } : {}),
      ...(params.filters?.length ? { filters: params.filters } : {}),
    };
    const picked = window && !window.isDestroyed?.()
      ? await this.dialog.showSaveDialog(window, dialogOptions)
      : await this.dialog.showSaveDialog(dialogOptions);
    await context.assertActive();
    if (this.closed || this.isLocked()) {
      throw fail("cancelled", "Host locked during save dialog");
    }
    if (!picked || picked.canceled || typeof picked.filePath !== "string" || picked.filePath.length === 0) {
      return { cancelled: true };
    }
    const handle = this.#allocateFileHandle(context, picked.filePath);
    if (params.deferredWrite === true || params.data === undefined) {
      this.database?.recordSecurityAudit?.(context.pluginId, "ui.file.save", { deferred: true });
      return { cancelled: false, name: handle.name, size: 0, handleId: handle.id };
    }
    const buf = Buffer.from(params.data, params.encoding === "base64" ? "base64" : "utf8");
    if (buf.byteLength > LIMITS.fileMaxBytes) {
      await this.#disposeFileHandle(handle);
      throw fail("resourceExhausted", "File payload exceeds the maximum size limit");
    }
    this.quotaManager?.chargeBytes?.(context.runtimeId, "ui", buf.byteLength);
    const tempPath = `${handle.filePath}.netcatty-tmp-${randomUUID()}`;
    try {
      await fs.writeFile(tempPath, buf);
      await context.assertActive();
      await fs.rename(tempPath, handle.filePath);
    } catch (error) {
      await fs.unlink(tempPath).catch(() => {});
      throw error;
    }
    this.database?.recordSecurityAudit?.(context.pluginId, "ui.file.save", { size: buf.byteLength });
    return { cancelled: false, name: handle.name, size: buf.byteLength, handleId: handle.id };
  }

  async readFileHandle(params, context) {
    await context.assertActive();
    this.#assertFileDialogPermission(context);
    if (this.closed || this.isLocked()) throw fail("unavailable", "Host is locked");
    const handle = this.#getFileHandle(params.handleId, context);
    const stat = await fs.stat(handle.filePath);
    if (!stat.isFile()) throw fail("unavailable", "File handle target is no longer a regular file");
    if (stat.size > LIMITS.fileMaxBytes) throw fail("resourceExhausted", "File exceeds the maximum size limit");
    const offset = params.offset ?? 0;
    const length = Math.min(params.length ?? INLINE_FILE_BYTES, 4 * 1024 * 1024);
    const remaining = Math.max(0, stat.size - offset);
    const toRead = Math.min(length, remaining);
    const encoding = params.encoding === "utf8" ? "utf8" : "base64";
    if (toRead === 0) {
      return { data: "", encoding, bytesRead: 0, totalSize: stat.size, eof: true };
    }
    const fd = await fs.open(handle.filePath, "r");
    try {
      const buffer = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await fd.read(buffer, 0, toRead, offset);
      await context.assertActive();
      const slice = buffer.subarray(0, bytesRead);
      this.quotaManager?.chargeBytes?.(context.runtimeId, "ui", bytesRead);
      return {
        data: encoding === "utf8" ? slice.toString("utf8") : slice.toString("base64"),
        encoding,
        bytesRead,
        totalSize: stat.size,
        eof: offset + bytesRead >= stat.size,
      };
    } finally {
      await fd.close().catch(() => {});
    }
  }

  async writeFileHandle(params, context) {
    await context.assertActive();
    this.#assertFileDialogPermission(context);
    if (this.closed || this.isLocked()) throw fail("unavailable", "Host is locked");
    const handle = this.#getFileHandle(params.handleId, context);
    const buf = Buffer.from(params.data, params.encoding === "base64" ? "base64" : "utf8");
    const mode = params.mode ?? "replace";
    const commit = params.commit !== false;
    if (mode === "replace") {
      if (handle.stagingPath) {
        await fs.unlink(handle.stagingPath).catch(() => {});
        handle.stagingPath = null;
        handle.stagingBytes = 0;
      }
      if (buf.byteLength > LIMITS.fileMaxBytes) {
        throw fail("resourceExhausted", "File write exceeds the maximum size limit");
      }
      handle.stagingPath = `${handle.filePath}.netcatty-tmp-${randomUUID()}`;
      handle.stagingBytes = buf.byteLength;
      this.quotaManager?.chargeBytes?.(context.runtimeId, "ui", buf.byteLength);
      await fs.writeFile(handle.stagingPath, buf);
    } else {
      if (!handle.stagingPath) {
        throw fail("failedPrecondition", "Append write requires an open replace transaction");
      }
      if (handle.stagingBytes + buf.byteLength > LIMITS.fileMaxBytes) {
        const temp = handle.stagingPath;
        handle.stagingPath = null;
        handle.stagingBytes = 0;
        await fs.unlink(temp).catch(() => {});
        throw fail("resourceExhausted", "File write exceeds the maximum size limit");
      }
      this.quotaManager?.chargeBytes?.(context.runtimeId, "ui", buf.byteLength);
      await fs.appendFile(handle.stagingPath, buf);
      handle.stagingBytes += buf.byteLength;
    }
    const totalSize = handle.stagingBytes;
    if (commit) {
      await context.assertActive();
      const temp = handle.stagingPath;
      handle.stagingPath = null;
      handle.stagingBytes = 0;
      try {
        await fs.rename(temp, handle.filePath);
      } catch (error) {
        await fs.unlink(temp).catch(() => {});
        throw error;
      }
      this.database?.recordSecurityAudit?.(context.pluginId, "ui.file.writeHandle", { size: totalSize });
    }
    return { bytesWritten: buf.byteLength, totalSize, committed: commit };
  }

  async closeFileHandle(params, context) {
    await context.assertActive();
    const handle = this.fileHandles.get(params.handleId);
    if (handle && handle.pluginId === context.pluginId && handle.runtimeId === context.runtimeId
      && handle.sourceOwner === context.sourceOwner) {
      await this.#disposeFileHandle(handle);
    }
    return null;
  }

  admitRequest(params, context) {
    const sender = this.#admit(params, context);
    let guard = this.admissionGuards.get(context.runtimeId);
    if (!guard) { guard = { active: true }; this.admissionGuards.set(context.runtimeId, guard); }
    const terminalTarget = params.kind === "terminal.selection.read" ? this.terminalSelection.capture(sender, context)
      : params.kind === "terminal.input.propose" ? this.terminalSelection.resolve(params.handle, context) : undefined;
    const admission = { sender, runtimeId: context.runtimeId, revision: this.admissionRevision, guard, terminalTarget };
    this.admissions.set(params, admission);
    return admission;
  }

  setReady(sender, ready) {
    const window = this.getWindow();
    if (!sender || window?.webContents !== sender || sender.isDestroyed?.()) {
      throw fail("permissionDenied", "Host interaction window is not the owner");
    }
    if (typeof ready !== "boolean") throw fail("invalidArgument", "Host interaction readiness is invalid");
    if (!ready) { this.releaseWindow(sender); return true; }
    if (this.closed) throw fail("unavailable", "Host interactions are unavailable");
    if (this.owner === sender) return true;
    if (this.owner) this.releaseWindow(this.owner);
    this.owner = sender;
    this.ownerGeneration++;
    const close = () => this.releaseWindow(sender);
    // A native permission dialog can temporarily blur its parent. Already
    // displayed interactions still cancel immediately; pre-prompt admission
    // can only resume once this same owner actually regains focus.
    const blur = () => this.cancelAll(false);
    const hide = () => this.cancelAll();
    const navigate = (details, _url, isInPlace, isMainFrame) => {
      const main = details?.isMainFrame ?? isMainFrame;
      const sameDocument = details?.isSameDocument ?? isInPlace;
      if (main !== false && sameDocument !== true) close();
    };
    sender.once?.("destroyed", close);
    sender.on?.("did-start-navigation", navigate);
    sender.on?.("render-process-gone", close);
    window.on?.("blur", blur);
    window.on?.("hide", hide);
    this.ownerCleanup = () => {
      sender.removeListener?.("destroyed", close);
      sender.removeListener?.("did-start-navigation", navigate);
      sender.removeListener?.("render-process-gone", close);
      window.removeListener?.("blur", blur);
      window.removeListener?.("hide", hide);
    };
    return true;
  }

  #assertWindow(sender = this.owner) {
    const window = this.getWindow();
    if (this.closed || this.isLocked() || !sender || sender !== this.owner
      || window?.webContents !== sender || window.isDestroyed?.()
      || sender.isDestroyed?.() || window.isVisible?.() === false || window.isFocused?.() !== true) {
      throw fail("unavailable", "Host interactions require the focused unlocked main window");
    }
    return sender;
  }

  #token(entry) {
    const nonce = randomBytes(24).toString("base64url");
    const binding = JSON.stringify([
      nonce, entry.id, entry.context.pluginId, entry.context.pluginVersion,
      entry.context.runtimeId, entry.sender.id, entry.params.kind, entry.phase, entry.expiresAt, entry.terminalTarget?.resource ?? null,
    ]);
    return `${nonce}.${createHmac("sha256", this.key).update(binding).digest("base64url")}`;
  }

  #present(entry) {
    entry.actionToken = this.#token(entry);
    entry.sender.send(PROMPT_CHANNEL, {
      requestId: entry.id, actionToken: entry.actionToken,
      pluginId: entry.context.pluginId, pluginVersion: entry.context.pluginVersion,
      expiresAt: entry.expiresAt, phase: entry.phase, request: entry.params,
      permissionMode: entry.permissionMode,
      ...(entry.terminalTarget ? { terminalSessionId: entry.terminalTarget.sessionId, terminalRendererId: entry.terminalTarget.rendererId, terminalLabel: entry.terminalTarget.label } : {}),
      ...(entry.previewText === undefined ? {} : { previewText: entry.previewText }),
      ...(this.vaultService?.isRequest(entry.params) ? this.vaultService.describePrompt(entry) : {}),
      ...(entry.reviewedDraft === undefined ? {} : { reviewedDraft: entry.reviewedDraft }),
    });
  }

  #finish(entry, result, error) {
    if (this.pending.get(entry.id) !== entry) return false;
    this.pending.delete(entry.id);
    entry.terminalWatch?.dispose();
    entry.terminalWatch = null;
    // A delivered stream outlives its request; cancelled/invalid results must
    // tear down pending SSH authentication and any late-arriving connection.
    const deliveredStream = !error && result?.handleId && validateResult(result);
    if (deliveredStream) entry.streamDelivered = true;
    if (!deliveredStream) { entry.controller.abort(); entry.disposeResult?.(); }
    entry.disposeResult = null;
    entry.actionToken = null;
    entry.previewText = undefined;
    clearTimeout(entry.timer);
    entry.context.signal?.removeEventListener("abort", entry.onAbort);
    try { entry.sender.send(PROMPT_CHANNEL, { requestId: entry.id, closed: true }); } catch {}
    if (error) entry.reject(error);
    else if (!validateResult(result)) entry.reject(fail("internal", "Host interaction result is invalid"));
    else entry.resolve(result);
    return true;
  }

  #audit(entry, action) {
    // Fixed metadata only. Never record title, choices, user input, clipboard
    // bytes, action token or a hash derived from user content.
    try {
      this.database.recordSecurityAudit(entry.context.pluginId, "ui.interaction", { kind: entry.params.kind, action });
    } catch {
      throw fail("unavailable", "Host interaction audit is unavailable");
    }
  }

  #admit(params, context) {
    const sender = this.#assertWindow();
    if ((params.kind === "clipboard.read" && typeof this.clipboard?.readText !== "function")
      || (params.kind === "clipboard.write" && typeof this.clipboard?.writeText !== "function")) {
      throw fail("unavailable", "Host clipboard text is unavailable");
    }
    const now = this.clock();
    const rate = this.rates.get(context.runtimeId);
    const nextRate = !rate || now - rate.startedAt >= 60_000 ? { startedAt: now, count: 0 } : rate;
    if (nextRate.count >= LIMITS.requestsPerMinute || this.pending.size >= LIMITS.pendingTotal
      || [...this.pending.values()].some((entry) => entry.context.runtimeId === context.runtimeId || entry.sender === sender)) {
      throw fail("resourceExhausted", "Host interaction limit reached");
    }
    nextRate.count++;
    this.rates.set(context.runtimeId, nextRate);
    this.quotaManager.chargeBytes(context.runtimeId, "ui", Buffer.byteLength(JSON.stringify(params)));
    return sender;
  }

  async request(params, context) {
    await context.assertActive();
    const admission = this.admissions.get(params);
    this.admissions.delete(params);
    let sender;
    if (admission?.runtimeId === context.runtimeId) {
      const deadline = Date.now() + this.focusRestoreMs;
      for (;;) {
        context.signal?.throwIfAborted();
        if (!admission.guard.active || admission.revision !== this.admissionRevision || admission.sender !== this.owner) {
          throw fail("cancelled", "Host interaction admission was revoked");
        }
        const window = this.getWindow();
        if (this.closed || this.isLocked() || window?.webContents !== admission.sender
          || window.isDestroyed?.() || admission.sender.isDestroyed?.() || window.isVisible?.() === false) {
          throw fail("unavailable", "Host interaction owner is unavailable");
        }
        if (window.isFocused?.() === true) break;
        if (Date.now() >= deadline) throw fail("unavailable", "Host interactions require the focused unlocked main window");
        await new Promise((resolve) => setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now()))));
      }
      await context.assertActive();
      if (!admission.guard.active || admission.revision !== this.admissionRevision) throw fail("cancelled", "Host interaction admission was revoked");
      sender = this.#assertWindow(admission.sender);
    } else sender = this.#admit(params, context);
    if (this.pending.size >= LIMITS.pendingTotal || [...this.pending.values()].some((entry) => entry.context.runtimeId === context.runtimeId || entry.sender === sender)) {
      throw fail("resourceExhausted", "Host interaction limit reached");
    }
    const terminalTarget = admission?.terminalTarget ?? (params.kind === "terminal.selection.read"
      ? this.terminalSelection.capture(sender, context) : params.kind === "terminal.input.propose"
        ? this.terminalSelection.resolve(params.handle, context) : undefined);
    if (terminalTarget) this.terminalSelection.assertCurrent(terminalTarget);
    if (params.kind === "terminal.input.propose") this.terminalSelection.resolve(params.handle, context);
    const authorization = context.authorization ?? interactionAuthorization(params, terminalTarget);
    const permissionMode = this.permissionEngine.getMode?.(context, authorization.permission) ?? "ask";
    if (permissionMode === "deny") throw fail("permissionDenied", "Plugin permission is disabled");
    // These actions need no target/data-input UI. The main process still owns
    // admission, quotas, audit and precise operation/resource validation.
    if (permissionMode === "allow" && params.kind.startsWith("clipboard.")) {
      await context.assertActive(); this.#assertWindow(sender);
      const entry = { context, params };
      this.#audit(entry, "completed");
      if (params.kind === "clipboard.write") { this.clipboard.writeText(params.text); return { cancelled: false, value: true }; }
      const text = assertTextBytes(this.clipboard.readText(), LIMITS.clipboardBytes);
      this.quotaManager.chargeBytes(context.runtimeId, "clipboard", Buffer.byteLength(text));
      await context.assertActive();
      return { cancelled: false, value: text };
    }
    const now = this.clock();
    const initialPhase = this.vaultService?.isRequest(params)
      ? (this.vaultService.initialPhase?.(params, context) ?? "request")
      : "request";
    return new Promise((resolve, reject) => {
      const entry = {
        id: randomUUID(), context, params, sender, resolve, reject, terminalTarget, permissionMode, controller: new AbortController(),
        expiresAt: now + this.timeoutMs, phase: initialPhase, actionToken: null, terminalWatch: null,
      };
      entry.onAbort = () => this.#finish(entry, null, fail("cancelled", "Host interaction was cancelled"));
      entry.timer = setTimeout(() => this.#finish(entry, null, fail("deadlineExceeded", "Host interaction expired")), this.timeoutMs);
      entry.timer.unref?.();
      this.pending.set(entry.id, entry);
      if (terminalTarget) entry.terminalWatch = this.terminalSelection.watch();
      context.signal?.addEventListener("abort", entry.onAbort, { once: true });
      if (context.signal?.aborted) { entry.onAbort(); return; }
      try {
        if (params.kind === "clipboard.read") {
          entry.previewText = assertTextBytes(this.clipboard.readText(), LIMITS.clipboardBytes);
          this.quotaManager.chargeBytes(context.runtimeId, "clipboard", Buffer.byteLength(entry.previewText));
          entry.phase = "preview";
        }
        this.#present(entry);
      } catch { this.#finish(entry, null, fail("unavailable", "Host interaction window is unavailable")); }
    });
  }

  async respond(sender, response, nativeOptions) {
    this.#assertWindow(sender);
    if (!validateResponse(response)) throw fail("invalidArgument", "Host interaction response is invalid");
    const entry = this.pending.get(response.requestId);
    if (!entry || entry.sender !== sender || !entry.actionToken || this.clock() >= entry.expiresAt) return false;
    const expected = Buffer.from(entry.actionToken);
    const supplied = Buffer.from(response.actionToken);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return false;
    // Consume before the first asynchronous boundary. Duplicate and old-phase
    // replies cannot race the same native action.
    entry.actionToken = null;
    try {
      await entry.context.assertActive();
      this.#assertWindow(sender);
      if (this.pending.get(entry.id) !== entry) return false;
      if (entry.terminalTarget) this.terminalSelection.assertCurrent(entry.terminalTarget);
      if (entry.params.kind === "terminal.input.propose") this.terminalSelection.resolve(entry.params.handle, entry.context);
      if (response.action === "cancel") {
        this.#audit(entry, "cancelled");
        return this.#finish(entry, { cancelled: true });
      }
      if (entry.params.kind === "network.stream.confirm" || entry.params.kind === "network.stream.tlsConfirm") {
        if (response.action !== "submit") throw fail("invalidArgument", "Stream confirmation requires a submit action");
        this.#audit(entry, entry.params.kind === "network.stream.tlsConfirm" ? "tls-cert-confirmed" : "stream-confirmed");
        return this.#finish(entry, {
          cancelled: false,
          approved: true,
          remember: response.remember === true,
        });
      }
      if (this.vaultService?.isRequest(entry.params)) {
        const outcome = await this.vaultService.respond(entry, response, nativeOptions);
        await entry.context.assertActive();
        this.#assertWindow(sender);
        if (this.pending.get(entry.id) !== entry) { entry.disposeResult?.(); return false; }
        if (outcome.result) {
          this.#audit(entry, "completed");
          return this.#finish(entry, outcome.result);
        }
        this.#audit(entry, outcome.phase === "commit" ? "action-confirmed" : "action-claimed");
        entry.phase = outcome.phase;
        if (outcome.reviewedDraft !== undefined) entry.reviewedDraft = outcome.reviewedDraft;
        if (entry.phase === "executing") {
          entry.actionToken = this.#token(entry);
          return { completionToken: entry.actionToken };
        }
        this.#present(entry);
        return true;
      }
      if (entry.params.kind === "terminal.selection.read" && entry.phase === "request") {
        if (response.action !== "preview") throw fail("invalidArgument", "Terminal sharing requires a preview action");
        const text = assertTextBytes(response.value, LIMITS.textBytes);
        if (!text.length) throw fail("failedPrecondition", "Select terminal text before requesting a share");
        this.#audit(entry, "preview-confirmed");
        this.quotaManager.chargeBytes(entry.context.runtimeId, "terminal", Buffer.byteLength(text));
        if (entry.permissionMode === "allow") {
          this.#audit(entry, "completed");
          return this.#finish(entry, { cancelled: false, value: Object.freeze({ text,
            ...this.terminalSelection.issue(entry.terminalTarget, entry.context) }) });
        }
        entry.previewText = text; entry.phase = "preview"; this.#present(entry); return true;
      }
      if (entry.params.kind === "clipboard.read" && entry.phase === "request") {
        if (response.action !== "preview") throw fail("invalidArgument", "Clipboard sharing requires a preview action");
        this.#audit(entry, "preview-confirmed");
        let rawText;
        try { rawText = this.clipboard.readText(); }
        catch { throw fail("unavailable", "Host clipboard text is unavailable"); }
        const text = assertTextBytes(rawText, LIMITS.clipboardBytes);
        this.quotaManager.chargeBytes(entry.context.runtimeId, "clipboard", Buffer.byteLength(text));
        entry.previewText = text;
        entry.phase = "preview";
        try { this.#present(entry); }
        catch { throw fail("unavailable", "Host interaction window is unavailable"); }
        return true;
      }
      if (response.action !== "submit") throw fail("invalidArgument", "Host interaction action is invalid");
      let value;
      if (entry.params.kind === "input") {
        if (!validateSingleLineInput(response.value)) throw fail("invalidArgument", "Host input must be a single line");
        value = assertTextBytes(response.value, LIMITS.textBytes);
      }
      else if (entry.params.kind === "quickPick") {
        if (!entry.params.items.some((item) => item.id === response.value)) throw fail("invalidArgument", "Host interaction choice is invalid");
        value = response.value;
      } else if (entry.params.kind === "terminal.selection.read") {
        if (entry.phase !== "preview" || typeof entry.previewText !== "string") throw fail("failedPrecondition", "Terminal selection was not previewed");
      } else if (entry.params.kind === "clipboard.read") value = entry.previewText;
      else value = true;
      this.#audit(entry, entry.params.kind === "terminal.input.propose" ? "draft-reviewed" : entry.params.kind === "clipboard.write" ? "copy-confirmed" : "share-confirmed");
      if (entry.params.kind === "terminal.selection.read") {
        value = Object.freeze({ text: entry.previewText, ...this.terminalSelection.issue(entry.terminalTarget, entry.context) });
      }
      if (entry.params.kind === "clipboard.write") {
        try { this.clipboard.writeText(entry.params.text); }
        catch { throw fail("unavailable", "Host clipboard write failed"); }
      }
      return this.#finish(entry, { cancelled: false, value });
    } catch (error) {
      if (!this.#finish(entry, null, error)) entry.disposeResult?.();
      throw error;
    }
  }

  setTerminalTarget(sender, target) { return this.terminalSelection.setTarget(sender, target); }

  releaseWindow(sender) {
    if (this.owner !== sender) return;
    this.terminalSelection.releaseWindow(sender);
    this.admissionRevision++;
    this.ownerGeneration++;
    this.vaultService?.clearSelections();
    this.owner = null;
    this.ownerCleanup?.(); this.ownerCleanup = null;
    for (const entry of [...this.pending.values()]) {
      if (entry.sender === sender) this.#finish(entry, null, fail("cancelled", "Host interaction window closed"));
    }
  }
  releasePlugin(pluginId) {
    this.terminalSelection.releasePlugin(pluginId);
    this.admissionRevision++;
    this.vaultService?.releasePlugin(pluginId);
    for (const handle of [...this.fileHandles.values()]) {
      if (handle.pluginId === pluginId) void this.#disposeFileHandle(handle);
    }
    for (const entry of [...this.pending.values()]) {
      if (entry.context.pluginId === pluginId) this.#finish(entry, null, fail("cancelled", "Plugin access was revoked"));
    }
  }
  releaseRuntime(runtimeId) {
    this.terminalSelection.releaseRuntime(runtimeId);
    this.cancelRuntimeRequests(runtimeId, "Plugin runtime stopped");
    this.rates.delete(runtimeId);
    this.vaultService?.releaseRuntime(runtimeId);
    for (const handle of [...this.fileHandles.values()]) {
      if (handle.runtimeId === runtimeId) void this.#disposeFileHandle(handle);
    }
  }
  cancelRuntimeRequests(runtimeId, reason = "Host command finished") {
    const guard = this.admissionGuards.get(runtimeId);
    if (guard) guard.active = false;
    this.admissionGuards.delete(runtimeId);
    for (const entry of [...this.pending.values()]) {
      if (entry.context.runtimeId === runtimeId) this.#finish(entry, null, fail("cancelled", reason));
    }
  }
  cancelAll(invalidateAdmission = true) {
    if (invalidateAdmission) {
      this.admissionRevision++;
      this.terminalSelection.clearHandles();
      this.vaultService?.clearSelections();
    }
    for (const entry of [...this.pending.values()]) this.#finish(entry, null, fail("cancelled", "Host interaction was cancelled"));
  }
  shutdown() {
    if (this.closed) return;
    this.closed = true;
    if (this.owner) this.releaseWindow(this.owner);
    this.cancelAll(); this.rates.clear(); this.admissionGuards.clear();
    for (const handle of [...this.fileHandles.values()]) void this.#disposeFileHandle(handle);
    this.fileHandles.clear();
    this.revocation.dispose(); this.unsubscribeLock?.();
    this.terminalInvalidation.dispose(); this.terminalSelection.shutdown();
    this.key.fill(0);
    this.vaultService?.shutdown();
  }
}

module.exports = { HOST_INTERACTION_FEATURE, LIMITS, PROMPT_CHANNEL, PluginHostInteractionService, assertInteractionRequest, interactionAuthorization };
