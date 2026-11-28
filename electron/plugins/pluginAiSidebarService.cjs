"use strict";

const crypto = require("node:crypto");
const { PluginRpcError, RPC_ERRORS } = require("./rpcRouter.cjs");
const { createDefinitionValidator } = require("./contractValidator.cjs");
const { invalidArgument, freezeJson } = require("./validationUtils.cjs");

const PLUGIN_AI_SIDEBAR_TOOLS_FEATURE = require("./generated/plugin-contract.schema.json").$defs.PluginAISidebarToolsFeature.const;

const ALLOWED_VIEW_LOCATIONS = new Set(["vault-page", "terminal-sidebar"]);
const MAX_TOOLS_PER_PLUGIN = 16;
const MAX_SCHEMA_JSON_BYTES = 16 * 1024;
const MAX_ARGS_JSON_BYTES = 256 * 1024;
const MAX_RESULT_JSON_BYTES = 512 * 1024;
const TOOL_INVOKE_DEADLINE_MS = 45_000;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/u;

const validateRegisterTools = createDefinitionValidator("PluginAIRegisterToolsParams");
const validateSetContext = createDefinitionValidator("PluginAISetContextParams");
const validateOpenSidebar = createDefinitionValidator("PluginAIOpenSidebarParams");
const validateCloseSidebar = createDefinitionValidator("PluginAICloseSidebarParams");

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function buildQualifiedToolName(pluginId, toolName) {
  const hash = crypto.createHash("sha256").update(String(pluginId)).digest("hex").slice(0, 6);
  return `plugin_${hash}_${toolName}`;
}

function assertOwnedView(manifest, viewId, pluginId) {
  if (typeof viewId !== "string" || !viewId.startsWith(`${pluginId}.`) || viewId.length > 256) {
    throw invalidArgument("Plugin view ID is invalid or belongs to another plugin");
  }
  const view = manifest?.contributes?.views?.find((item) => item?.id === viewId) ?? null;
  if (!view) {
    throw new PluginRpcError(RPC_ERRORS.notFound, `Plugin view contribution was not found: ${viewId}`);
  }
  if (!ALLOWED_VIEW_LOCATIONS.has(view.location)) {
    throw invalidArgument(`Plugin AI sidebar is only supported on vault-page and terminal-sidebar views: ${viewId}`);
  }
  return view;
}

function resolveDefaultViewId(manifest, pluginId) {
  const views = manifest?.contributes?.views ?? [];
  const vaultView = views.find((item) => item?.location === "vault-page" && typeof item.id === "string" && item.id.startsWith(`${pluginId}.`));
  if (vaultView) return vaultView.id;
  const sidebarView = views.find((item) => item?.location === "terminal-sidebar" && typeof item.id === "string" && item.id.startsWith(`${pluginId}.`));
  return sidebarView ? sidebarView.id : null;
}

function normalizeInputSchema(schema) {
  if (!isPlainObject(schema)) {
    throw invalidArgument("Plugin AI tool inputSchema must be a JSON Schema object");
  }
  if (schema.type !== undefined && schema.type !== "object") {
    throw invalidArgument("Plugin AI tool inputSchema root type must be \"object\"");
  }
  const normalized = {
    type: "object",
    properties: {},
    ...schema,
  };
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SCHEMA_JSON_BYTES) {
    throw new PluginRpcError(RPC_ERRORS.resourceExhausted, "Plugin AI tool inputSchema exceeds 16 KiB limit");
  }
  return freezeJson(normalized);
}

class PluginAISidebarService {
  constructor(options = {}) {
    this.runtimeSupervisor = options.runtimeSupervisor ?? null;
    this.permissionEngine = options.permissionEngine ?? null;
    this.isLocked = options.isLocked ?? (() => false);
    this.clock = options.clock ?? (() => Date.now());
    this.toolBuckets = new Map(); // `${pluginId}\0${scopeViewId}` -> { pluginId, runtimeId, scopeViewId, tools: [...] }
    this.contexts = new Map(); // `${pluginId}\0${viewId}` -> { pluginId, runtimeId, context }
    this.stateListeners = new Set();
    this.commandListeners = new Set();
    this.registrations = [];

    this.changeSubscription = options.contributionService?.onDidChange?.((event) => {
      if (
        ["plugin-disabled", "runtime-stopped", "runtime-error", "runtime-quarantined"].includes(event?.reason)
        && typeof event.pluginId === "string"
      ) {
        this.clearPlugin(event.pluginId);
      }
    }) ?? null;
    this.revocationSubscription = this.permissionEngine?.onDidRevoke?.((event) => {
      if (typeof event?.pluginId === "string" && (!event.permission || event.permission === "ai.invoke")) {
        this.clearPlugin(event.pluginId);
      }
    }) ?? null;
    this.unsubscribeLock = options.subscribeLock?.((state) => {
      if (state?.locked) this.clearAll();
    }) ?? null;
  }

  registerRpcCapabilities(registry) {
    if (this.registrations.length) {
      throw new Error("Plugin AI sidebar routes are already registered");
    }
    const auth = (reason) => ({
      permission: "ai.invoke",
      resources: ["*"],
      reason,
      deferDecision: true,
    });
    this.registrations.push(
      registry.registerRequest("ai.registerTools", (params, context) => this.registerTools(params, context), {
        metadata: { capability: "plugin-ai-sidebar", mutating: true, permission: "ai.invoke" },
        authorization: auth("Register contextual AI tools for the Catty Agent sidebar"),
      }),
      registry.registerRequest("ai.setContext", (params, context) => this.setContext(params, context), {
        metadata: { capability: "plugin-ai-sidebar", mutating: true, permission: "ai.invoke" },
        authorization: auth("Publish contextual view summary for the Catty Agent sidebar"),
      }),
      registry.registerRequest("ai.openSidebar", (params, context) => this.openSidebar(params, context), {
        metadata: { capability: "plugin-ai-sidebar", mutating: false, permission: "ai.invoke" },
        authorization: auth("Open the Catty Agent contextual sidebar"),
      }),
      registry.registerRequest("ai.closeSidebar", (params, context) => this.closeSidebar(params, context), {
        metadata: { capability: "plugin-ai-sidebar", mutating: false, permission: "ai.invoke" },
        authorization: auth("Close the Catty Agent contextual sidebar"),
      }),
    );
  }

  #requireFeature(context) {
    const required = context?.manifest?.features?.required;
    const optional = context?.manifest?.features?.optional;
    const declared = (Array.isArray(required) && required.includes(PLUGIN_AI_SIDEBAR_TOOLS_FEATURE))
      || (Array.isArray(optional) && optional.includes(PLUGIN_AI_SIDEBAR_TOOLS_FEATURE));
    if (!declared) {
      throw new PluginRpcError(
        RPC_ERRORS.unsupported,
        `Plugin must declare feature "${PLUGIN_AI_SIDEBAR_TOOLS_FEATURE}" to use AI sidebar APIs`,
      );
    }
  }

  registerTools(params, context) {
    if (this.isLocked()) {
      throw new PluginRpcError(RPC_ERRORS.failedPrecondition, "Application is locked");
    }
    this.#requireFeature(context);
    if (!validateRegisterTools(params)) {
      throw invalidArgument("Plugin AI tool registration parameters are invalid");
    }
    const scopeViewId = params.viewId
      ? assertOwnedView(context.manifest, params.viewId, context.pluginId).id
      : "*";
    const bucketKey = `${context.pluginId}\0${scopeViewId}`;

    const seenNames = new Set();
    const normalizedTools = [];
    for (const toolDef of params.tools) {
      if (seenNames.has(toolDef.name)) {
        throw invalidArgument(`Duplicate plugin AI tool name: ${toolDef.name}`);
      }
      seenNames.add(toolDef.name);
      const toolViewId = toolDef.viewId
        ? assertOwnedView(context.manifest, toolDef.viewId, context.pluginId).id
        : (scopeViewId === "*" ? undefined : scopeViewId);
      const description = toolDef.description.trim();
      if (!description) {
        throw invalidArgument(`Plugin AI tool description must not be empty: ${toolDef.name}`);
      }
      normalizedTools.push(freezeJson({
        pluginId: context.pluginId,
        pluginName: context.manifest?.displayName || context.manifest?.name || context.pluginId,
        name: toolDef.name,
        qualifiedName: buildQualifiedToolName(context.pluginId, toolDef.name),
        description,
        inputSchema: normalizeInputSchema(toolDef.inputSchema),
        risk: toolDef.risk === "write" ? "write" : "read",
        ...(toolViewId ? { viewId: toolViewId } : {}),
      }));
    }

    // Enforce global per-plugin cap (<= 16 tools across all buckets) and no name collisions across buckets.
    let otherCount = 0;
    const otherNames = new Set();
    for (const [key, bucket] of this.toolBuckets.entries()) {
      if (key === bucketKey || bucket.pluginId !== context.pluginId) continue;
      otherCount += bucket.tools.length;
      for (const existingTool of bucket.tools) otherNames.add(existingTool.name);
    }
    if (otherCount + normalizedTools.length > MAX_TOOLS_PER_PLUGIN) {
      throw new PluginRpcError(RPC_ERRORS.resourceExhausted, `A plugin may register at most ${MAX_TOOLS_PER_PLUGIN} AI tools`);
    }
    for (const toolDef of normalizedTools) {
      if (otherNames.has(toolDef.name)) {
        throw invalidArgument(`Plugin AI tool name already registered in another scope: ${toolDef.name}`);
      }
    }

    if (normalizedTools.length === 0) {
      if (this.toolBuckets.delete(bucketKey)) {
        this.#emitState();
      }
      return { registered: 0 };
    }

    this.toolBuckets.set(bucketKey, {
      pluginId: context.pluginId,
      runtimeId: context.runtimeId ?? null,
      scopeViewId,
      tools: Object.freeze(normalizedTools),
    });
    this.#emitState();
    return { registered: normalizedTools.length };
  }

  setContext(params, context) {
    if (this.isLocked()) {
      throw new PluginRpcError(RPC_ERRORS.failedPrecondition, "Application is locked");
    }
    this.#requireFeature(context);
    if (!validateSetContext(params)) {
      throw invalidArgument("Plugin AI context parameters are invalid");
    }
    const view = assertOwnedView(context.manifest, params.viewId, context.pluginId);
    const key = `${context.pluginId}\0${view.id}`;
    const title = typeof params.title === "string" ? params.title.trim() : "";
    const subtitle = typeof params.subtitle === "string" ? params.subtitle.trim() : "";
    const summary = typeof params.summary === "string" ? params.summary.trim() : "";
    const suggestedPrompts = Array.isArray(params.suggestedPrompts)
      ? params.suggestedPrompts
          .map((item) => ({
            label: item.label.trim(),
            prompt: item.prompt.trim(),
          }))
          .filter((item) => item.label.length > 0 && item.prompt.length > 0)
      : [];

    if (!title && !subtitle && !summary && suggestedPrompts.length === 0) {
      if (this.contexts.delete(key)) {
        this.#emitState();
      }
      return null;
    }

    const stored = freezeJson({
      pluginId: context.pluginId,
      pluginName: context.manifest?.displayName || context.manifest?.name || context.pluginId,
      viewId: view.id,
      ...(title ? { title } : {}),
      ...(subtitle ? { subtitle } : {}),
      ...(summary ? { summary } : {}),
      ...(suggestedPrompts.length > 0 ? { suggestedPrompts } : {}),
      updatedAt: this.clock(),
    });
    this.contexts.set(key, {
      pluginId: context.pluginId,
      runtimeId: context.runtimeId ?? null,
      context: stored,
    });
    this.#emitState();
    return null;
  }

  openSidebar(params, context) {
    if (this.isLocked()) {
      throw new PluginRpcError(RPC_ERRORS.failedPrecondition, "Application is locked");
    }
    this.#requireFeature(context);
    const normalizedParams = params ?? {};
    if (!validateOpenSidebar(normalizedParams)) {
      throw invalidArgument("Plugin AI openSidebar parameters are invalid");
    }
    const viewId = normalizedParams.viewId
      ? assertOwnedView(context.manifest, normalizedParams.viewId, context.pluginId).id
      : resolveDefaultViewId(context.manifest, context.pluginId);
    if (!viewId) {
      throw invalidArgument("Plugin has no vault-page or terminal-sidebar view to attach the AI sidebar to");
    }
    const prompt = typeof normalizedParams.prompt === "string" ? normalizedParams.prompt.trim() : "";
    if (prompt && CONTROL_CHAR_RE.test(prompt.replace(/[\r\n\t]/g, ""))) {
      throw invalidArgument("Plugin AI sidebar prompt contains invalid control characters");
    }
    this.#emitCommand(freezeJson({
      action: "open",
      pluginId: context.pluginId,
      viewId,
      ...(prompt ? { prompt } : {}),
      ...(normalizedParams.autoSend === true && prompt ? { autoSend: true } : {}),
      timestamp: this.clock(),
    }));
    return null;
  }

  closeSidebar(params, context) {
    if (this.isLocked()) {
      throw new PluginRpcError(RPC_ERRORS.failedPrecondition, "Application is locked");
    }
    this.#requireFeature(context);
    const normalizedParams = params ?? {};
    if (!validateCloseSidebar(normalizedParams)) {
      throw invalidArgument("Plugin AI closeSidebar parameters are invalid");
    }
    const viewId = normalizedParams.viewId
      ? assertOwnedView(context.manifest, normalizedParams.viewId, context.pluginId).id
      : resolveDefaultViewId(context.manifest, context.pluginId);
    if (!viewId) {
      throw invalidArgument("Plugin has no vault-page or terminal-sidebar view to close the AI sidebar for");
    }
    this.#emitCommand(freezeJson({
      action: "close",
      pluginId: context.pluginId,
      viewId,
      timestamp: this.clock(),
    }));
    return null;
  }

  getState() {
    if (this.isLocked()) {
      return freezeJson({ contexts: [], tools: [] });
    }
    const contexts = [...this.contexts.values()]
      .map((entry) => entry.context)
      .sort((a, b) => a.viewId.localeCompare(b.viewId));
    const tools = [...this.toolBuckets.values()]
      .flatMap((bucket) => bucket.tools)
      .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));
    return freezeJson({ contexts, tools });
  }

  async invokeTool(params, options = {}) {
    if (this.isLocked()) {
      throw new PluginRpcError(RPC_ERRORS.failedPrecondition, "Application is locked");
    }
    if (!isPlainObject(params)) {
      throw invalidArgument("Plugin AI tool invocation parameters must be an object");
    }
    const pluginId = typeof params.pluginId === "string" ? params.pluginId : "";
    const toolName = typeof params.toolName === "string" ? params.toolName : "";
    const viewId = typeof params.viewId === "string" && params.viewId ? params.viewId : undefined;
    const chatSessionId = typeof params.chatSessionId === "string" && params.chatSessionId
      ? params.chatSessionId.slice(0, 128)
      : undefined;
    const args = params.args === undefined ? {} : params.args;
    if (!pluginId || !toolName) {
      throw invalidArgument("Plugin AI tool invocation requires pluginId and toolName");
    }
    if (!isPlainObject(args)) {
      throw invalidArgument("Plugin AI tool args must be a plain JSON object");
    }
    const serializedArgs = JSON.stringify(args);
    if (Buffer.byteLength(serializedArgs, "utf8") > MAX_ARGS_JSON_BYTES) {
      throw new PluginRpcError(RPC_ERRORS.resourceExhausted, "Plugin AI tool args exceed 256 KiB limit");
    }

    let matchedTool = null;
    for (const bucket of this.toolBuckets.values()) {
      if (bucket.pluginId !== pluginId) continue;
      for (const candidate of bucket.tools) {
        if (candidate.name !== toolName) continue;
        if (candidate.viewId && viewId && candidate.viewId !== viewId) continue;
        matchedTool = candidate;
        break;
      }
      if (matchedTool) break;
    }
    if (!matchedTool) {
      throw new PluginRpcError(RPC_ERRORS.notFound, `Plugin AI tool is not registered: ${toolName}`);
    }
    if (!this.runtimeSupervisor || typeof this.runtimeSupervisor.request !== "function") {
      throw new PluginRpcError(RPC_ERRORS.unavailable, "Plugin runtime supervisor is unavailable");
    }

    const rawResult = await this.runtimeSupervisor.request(
      pluginId,
      "plugin.ai.invokeTool",
      {
        toolName,
        args,
        ...(viewId ? { viewId } : {}),
        ...(chatSessionId ? { chatSessionId } : {}),
      },
      {
        deadlineMs: Number.isSafeInteger(options.deadlineMs) ? options.deadlineMs : TOOL_INVOKE_DEADLINE_MS,
        signal: options.signal,
      },
    );

    const normalizedResult = rawResult === undefined ? null : rawResult;
    const serializedResult = JSON.stringify(normalizedResult);
    if (serializedResult && Buffer.byteLength(serializedResult, "utf8") > MAX_RESULT_JSON_BYTES) {
      throw new PluginRpcError(RPC_ERRORS.resourceExhausted, "Plugin AI tool result exceeds 512 KiB limit");
    }
    return freezeJson(normalizedResult);
  }

  onDidChangeState(listener) {
    if (typeof listener !== "function") {
      throw new TypeError("Plugin AI sidebar state listener must be a function");
    }
    this.stateListeners.add(listener);
    return Object.freeze({ dispose: () => this.stateListeners.delete(listener) });
  }

  onDidEmitCommand(listener) {
    if (typeof listener !== "function") {
      throw new TypeError("Plugin AI sidebar command listener must be a function");
    }
    this.commandListeners.add(listener);
    return Object.freeze({ dispose: () => this.commandListeners.delete(listener) });
  }

  releaseRuntime(runtimeId) {
    if (typeof runtimeId !== "string" || !runtimeId) return false;
    let changed = false;
    for (const [key, bucket] of [...this.toolBuckets.entries()]) {
      if (bucket.runtimeId === runtimeId) {
        this.toolBuckets.delete(key);
        changed = true;
      }
    }
    for (const [key, entry] of [...this.contexts.entries()]) {
      if (entry.runtimeId === runtimeId) {
        this.contexts.delete(key);
        changed = true;
      }
    }
    if (changed) this.#emitState();
    return changed;
  }

  clearPlugin(pluginId) {
    if (typeof pluginId !== "string" || !pluginId) return false;
    let changed = false;
    for (const [key, bucket] of [...this.toolBuckets.entries()]) {
      if (bucket.pluginId === pluginId) {
        this.toolBuckets.delete(key);
        changed = true;
      }
    }
    for (const [key, entry] of [...this.contexts.entries()]) {
      if (entry.pluginId === pluginId) {
        this.contexts.delete(key);
        changed = true;
      }
    }
    if (changed) this.#emitState();
    return changed;
  }

  clearAll() {
    if (this.toolBuckets.size === 0 && this.contexts.size === 0) return false;
    this.toolBuckets.clear();
    this.contexts.clear();
    this.#emitState();
    return true;
  }

  shutdown() {
    for (const reg of this.registrations.splice(0)) reg.dispose();
    this.changeSubscription?.dispose?.();
    this.revocationSubscription?.dispose?.();
    this.unsubscribeLock?.();
    this.toolBuckets.clear();
    this.contexts.clear();
    this.stateListeners.clear();
    this.commandListeners.clear();
  }

  #emitState() {
    const snapshot = this.getState();
    for (const listener of [...this.stateListeners]) {
      try { listener(snapshot); } catch {}
    }
  }

  #emitCommand(command) {
    for (const listener of [...this.commandListeners]) {
      try { listener(command); } catch {}
    }
  }
}

module.exports = {
  PluginAISidebarService,
  PLUGIN_AI_SIDEBAR_TOOLS_FEATURE,
  buildQualifiedToolName,
  MAX_TOOLS_PER_PLUGIN,
};
