"use strict";

const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { mcpEnvPairsToObject } = require("./injectMcp.cjs");
const {
  buildOpenCodeSkillsPermissionRules,
} = require("./netcattySkillsOpenCodePermissions.cjs");

const OPENCODE_IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const DEFAULT_OPENCODE_PORT = 4096;

function resolveUsableOpenCodeBinPath(binPath, env) {
  const candidates = [];
  if (binPath) candidates.push(String(binPath));
  if (env?.OPENCODE_BIN) candidates.push(String(env.OPENCODE_BIN));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {}
  }
  return undefined;
}

function isOpenCodeImageAttachment(attachment) {
  return Boolean(
    attachment &&
    OPENCODE_IMAGE_MEDIA_TYPES.has(String(attachment.mediaType || "").toLowerCase()) &&
    attachment.filePath,
  );
}

function parseOpenCodeModel(model) {
  const raw = String(model || "").trim();
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) return undefined;
  return {
    providerID: raw.slice(0, slash),
    modelID: raw.slice(slash + 1),
  };
}

function toOpenCodeMcpConfig(injectedMcpServers) {
  const mcp = {};
  for (const cfg of injectedMcpServers || []) {
    if (!cfg || !cfg.name) continue;
    mcp[cfg.name] = {
      type: "local",
      command: [cfg.command, ...(cfg.args || [])],
      environment: mcpEnvPairsToObject(cfg.env),
      enabled: true,
    };
  }
  return mcp;
}

function buildOpenCodeConfig({ model, injectedMcpServers, toolIntegrationMode, skillsPathAllowlist } = {}) {
  const allowBash = toolIntegrationMode === "skills";
  const permission = {
    edit: "deny",
    bash: allowBash ? "allow" : "deny",
    webfetch: "deny",
    external_directory: "deny",
  };
  if (allowBash && Array.isArray(skillsPathAllowlist) && skillsPathAllowlist.length > 0) {
    Object.assign(permission, buildOpenCodeSkillsPermissionRules(skillsPathAllowlist));
  }
  const config = {
    share: "disabled",
    autoupdate: false,
    permission,
    mcp: toOpenCodeMcpConfig(injectedMcpServers),
  };
  if (model) config.model = model;
  return config;
}

function buildOpenCodePromptParts(prompt, attachments) {
  const parts = [{ type: "text", text: String(prompt || "") }];
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    if (!isOpenCodeImageAttachment(attachment)) continue;
    parts.push({
      type: "file",
      mime: String(attachment.mediaType).toLowerCase(),
      filename: attachment.filename,
      url: pathToFileURL(attachment.filePath).href,
    });
  }
  return parts;
}

function extractOpenCodeErrorMessage(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  return String(
    error.data?.message ||
    error.message ||
    error.name ||
    "",
  );
}

function getOpenCodeResultError(result) {
  if (!result || typeof result !== "object") return null;
  return result.error || null;
}

function getOpenCodeEventPayload(event) {
  if (event?.payload && typeof event.payload === "object") return event.payload;
  if (event?.type && event?.properties) return event;
  return null;
}

function getOpenCodeSessionIdFromEvent(event) {
  const properties = getOpenCodeEventPayload(event)?.properties;
  return properties?.sessionID
    || properties?.sessionId
    || properties?.part?.sessionID
    || properties?.part?.sessionId
    || properties?.info?.sessionID
    || properties?.info?.sessionId
    || properties?.info?.id
    || null;
}

function getOpenCodePartId(part) {
  return part?.id || part?.partID || part?.partId || null;
}

function rememberOpenCodePartType(state, part) {
  const partId = getOpenCodePartId(part);
  if (!partId || !part?.type) return;
  state.partTypes = state.partTypes || new Map();
  state.partTypes.set(partId, part.type);
}

function rememberOpenCodeMessageRole(state, info) {
  if (!info || typeof info !== "object") return;
  const messageId = info.id;
  const role = info.role;
  if (!messageId || !role) return;
  state.messageRoles = state.messageRoles || new Map();
  state.messageRoles.set(messageId, role);
}

function getOpenCodeMessageId(source) {
  if (!source || typeof source !== "object") return null;
  return source.messageID
    || source.messageId
    || source.part?.messageID
    || source.part?.messageId
    || null;
}

function shouldEmitOpenCodeAssistantPart(state, source) {
  const messageId = getOpenCodeMessageId(source);
  if (!messageId) return true;
  const role = state.messageRoles?.get(messageId);
  if (!role) return true;
  return role === "assistant";
}

function forgetOpenCodeMessageRole(state, messageId) {
  if (!messageId) return;
  state.messageRoles?.delete(messageId);
}

function getOpenCodeDeltaKind(properties, state) {
  const partId = properties?.partID || properties?.partId || null;
  const knownType = partId && state.partTypes?.get(partId);
  if (knownType === "reasoning" || knownType === "text") return knownType;
  const field = String(properties?.field || "").toLowerCase();
  if (field.includes("reason") || field.includes("thinking")) return "reasoning";
  if (field === "text" || field === "content" || field.endsWith(".text") || field.endsWith(".content")) return "text";
  return null;
}

function emitOpenCodePartChunk({ emitter, state, partId, kind, text, isDelta }) {
  if (typeof text !== "string" || text.length === 0) return false;
  let chunk = text;
  if (partId) {
    state.partOffsets = state.partOffsets || new Map();
    const emittedLength = state.partOffsets.get(partId) || 0;
    if (isDelta) {
      state.partOffsets.set(partId, emittedLength + text.length);
    } else {
      chunk = text.slice(emittedLength);
      state.partOffsets.set(partId, Math.max(emittedLength, text.length));
    }
  }
  if (!chunk) return false;
  if (kind === "reasoning") {
    emitter.reasoning(chunk);
    state.reasoningOpen = true;
  } else {
    emitter.text(chunk);
  }
  return true;
}

function translateOpenCodeEvent(event, emitter, state = {}) {
  const payload = getOpenCodeEventPayload(event);
  if (!payload || typeof payload !== "object") return { idle: false, error: false, content: false };

  if (payload.type === "message.updated") {
    rememberOpenCodeMessageRole(state, payload.properties?.info);
    return { idle: false, error: false, content: false };
  }

  if (payload.type === "message.removed") {
    forgetOpenCodeMessageRole(state, payload.properties?.messageID || payload.properties?.messageId);
    return { idle: false, error: false, content: false };
  }

  if (payload.type === "message.part.updated") {
    const part = payload.properties?.part;
    if (!part || typeof part !== "object") return { idle: false, error: false, content: false };
    if (!shouldEmitOpenCodeAssistantPart(state, part)) {
      return { idle: false, error: false, content: false };
    }
    rememberOpenCodePartType(state, part);

    if (part.type === "text") {
      const delta = payload.properties?.delta;
      if (emitOpenCodePartChunk({
        emitter,
        state,
        partId: getOpenCodePartId(part),
        kind: "text",
        text: typeof delta === "string" ? delta : part.text,
        isDelta: typeof delta === "string",
      })) {
        return { idle: false, error: false, content: true };
      }
      return { idle: false, error: false, content: false };
    }

    if (part.type === "reasoning") {
      const delta = payload.properties?.delta;
      if (emitOpenCodePartChunk({
        emitter,
        state,
        partId: getOpenCodePartId(part),
        kind: "reasoning",
        text: typeof delta === "string" ? delta : part.text,
        isDelta: typeof delta === "string",
      })) {
        return { idle: false, error: false, content: true };
      }
      return { idle: false, error: false, content: false };
    }

    if (part.type === "tool") {
      if (state.reasoningOpen) {
        emitter.reasoningEnd?.();
        state.reasoningOpen = false;
      }
      const callId = part.callID || part.id || "";
      const toolName = part.tool || "tool";
      const input = part.state?.input || {};
      if (part.state?.status === "running" || part.state?.status === "pending") {
        state.toolCalls = state.toolCalls || new Set();
        if (!state.toolCalls.has(callId)) {
          state.toolCalls.add(callId);
          emitter.toolCall(toolName, input, callId);
        }
      } else if (part.state?.status === "completed") {
        state.toolCalls = state.toolCalls || new Set();
        if (!state.toolCalls.has(callId)) {
          state.toolCalls.add(callId);
          emitter.toolCall(toolName, input, callId);
        }
        state.toolResults = state.toolResults || new Set();
        if (!state.toolResults.has(callId)) {
          state.toolResults.add(callId);
          emitter.toolResult(callId, part.state.output || "", toolName);
        }
      } else if (part.state?.status === "error") {
        emitter.emitError(part.state.error || "OpenCode tool failed");
        return { idle: false, error: true, content: false };
      }
    }
    return { idle: false, error: false, content: part.type === "tool" };
  }

  if (payload.type === "message.part.delta") {
    const properties = payload.properties || {};
    if (!shouldEmitOpenCodeAssistantPart(state, properties)) {
      return { idle: false, error: false, content: false };
    }
    const delta = typeof properties.delta === "string" ? properties.delta : "";
    const kind = getOpenCodeDeltaKind(properties, state);
    if (!delta || !kind) return { idle: false, error: false, content: false };
    if (emitOpenCodePartChunk({
      emitter,
      state,
      partId: properties.partID || properties.partId || null,
      kind,
      text: delta,
      isDelta: true,
    })) {
      return { idle: false, error: false, content: true };
    }
    return { idle: false, error: false, content: false };
  }

  if (payload.type === "session.error") {
    emitter.emitError(extractOpenCodeErrorMessage(payload.properties?.error) || "OpenCode session failed");
    return { idle: false, error: true, content: false };
  }

  if (payload.type === "session.idle") {
    if (state.reasoningOpen) {
      emitter.reasoningEnd?.();
      state.reasoningOpen = false;
    }
    emitter.status("OpenCode session idle");
    return { idle: true, error: false, content: false };
  }

  if (payload.type === "session.status" && payload.properties?.status?.type) {
    emitter.status(`OpenCode session ${payload.properties.status.type}`);
  }

  return { idle: false, error: false, content: false };
}

function classifyOpenCodeSpawnError(error) {
  const code = error && error.code;
  const msg = String((error && error.message) || error || "");
  return {
    isSpawnEnoent: code === "ENOENT" || /ENOENT/i.test(msg) || /not found/i.test(msg),
    message: msg,
  };
}

function shellQuotePosix(value) {
  return `"${String(value).replace(/(["\\$`])/g, "\\$1")}"`;
}

function createOpenCodeShim(binPath, options = {}) {
  if (!binPath) return null;
  const platform = options.platform || process.platform;
  const tempDirBridge = options.tempDirBridge || require("../../tempDirBridge.cjs");
  const getTempFilePath = options.getTempFilePath || tempDirBridge.getTempFilePath;
  const shimParent = getTempFilePath("opencode-sdk-shim");
  const uniqueId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const shimRoot = path.join(shimParent, uniqueId);
  fs.mkdirSync(shimRoot, { recursive: true });
  const shimName = platform === "win32" ? "opencode.cmd" : "opencode";
  const shimPath = path.join(shimRoot, shimName);
  if (platform === "win32") {
    fs.writeFileSync(shimPath, `@echo off\r\n"${binPath}" %*\r\n`);
  } else {
    fs.writeFileSync(shimPath, `#!/bin/sh\nexec ${shellQuotePosix(binPath)} "$@"\n`);
    fs.chmodSync(shimPath, 0o755);
  }
  return {
    dir: shimRoot,
    path: shimPath,
    cleanup() {
      try { fs.rmSync(shimRoot, { recursive: true, force: true }); } catch {}
      try { fs.rmdirSync(shimParent); } catch {}
    },
  };
}

function createOpenCodeProcessEnv(env, binPath, options = {}) {
  const next = { ...(env || {}) };
  let shim = null;
  const explicitBinPath = binPath ? resolveUsableOpenCodeBinPath(binPath, null) : undefined;
  const envBinPath = explicitBinPath ? undefined : resolveUsableOpenCodeBinPath(null, next);

  if (explicitBinPath) {
    shim = createOpenCodeShim(explicitBinPath, options);
    next.OPENCODE_BIN = explicitBinPath;
    next.PATH = [shim?.dir || path.dirname(explicitBinPath), next.PATH || process.env.PATH || ""]
      .filter(Boolean)
      .join(path.delimiter);
  } else if (envBinPath) {
    next.OPENCODE_BIN = envBinPath;
  } else if (binPath || next.OPENCODE_BIN) {
    delete next.OPENCODE_BIN;
  }

  return {
    env: next,
    cleanup() {
      shim?.cleanup?.();
    },
  };
}

function withOpenCodeProcessEnv(env, binPath, fn) {
  const previous = {};
  const { env: next, cleanup } = createOpenCodeProcessEnv(env, binPath);
  const restore = () => {
    for (const key of Object.keys(next)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    cleanup();
  };
  for (const [key, value] of Object.entries(next)) {
    previous[key] = process.env[key];
    process.env[key] = String(value);
  }
  try {
    return fn();
  } catch (error) {
    throw error;
  } finally {
    restore();
  }
}

function getAvailablePort(host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port === DEFAULT_OPENCODE_PORT ? getAvailablePort(host) : port);
      });
    });
  });
}

async function withOpenCodeServerPort(options = {}) {
  if (options.port != null) return options;
  return { ...options, port: await getAvailablePort(options.hostname || "127.0.0.1") };
}

async function createDefaultOpenCode(options, env, binPath) {
  let sdk;
  try { sdk = await import("@opencode-ai/sdk"); } catch {
    throw new Error("OpenCode SDK not installed. Run: npm install @opencode-ai/sdk");
  }

  const { env: nextEnv, cleanup: cleanupShim } = createOpenCodeProcessEnv(env, binPath);
  const previous = {};
  for (const [key, value] of Object.entries(nextEnv)) {
    previous[key] = process.env[key];
    process.env[key] = String(value);
  }

  const restoreEnv = () => {
    if (restoreEnv.done) return;
    restoreEnv.done = true;
    for (const key of Object.keys(nextEnv)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    cleanupShim();
  };

  try {
    const opencode = await sdk.createOpencode(options);
    const originalClose = opencode.server?.close?.bind(opencode.server);
    if (typeof originalClose === "function") {
      opencode.server.close = () => {
        try { originalClose(); } catch {}
        restoreEnv();
      };
    } else {
      restoreEnv();
    }
    return opencode;
  } catch (error) {
    restoreEnv();
    throw error;
  }
}

function createAbortWait(signal) {
  if (!signal) return { promise: new Promise(() => {}), dispose() {} };
  if (signal.aborted) return { promise: Promise.resolve(), dispose() {} };
  let resolveAbort;
  const promise = new Promise((resolve) => { resolveAbort = resolve; });
  const onAbort = () => resolveAbort();
  signal.addEventListener("abort", onAbort, { once: true });
  return {
    promise,
    dispose() {
      signal.removeEventListener("abort", onAbort);
    },
  };
}

function createStopWait() {
  let stopped = false;
  let resolveStop;
  const promise = new Promise((resolve) => { resolveStop = resolve; });
  return {
    promise,
    get stopped() { return stopped; },
    stop() {
      if (stopped) return;
      stopped = true;
      resolveStop();
    },
  };
}

async function runOpenCodeTurn({
  prompt, systemPrompt, attachments, cwd, model, injectedMcpServers, toolIntegrationMode,
  skillsPathAllowlist, resumeSessionId, env, binPath, emitter, abortController, openCodeFactory,
}) {
  const config = buildOpenCodeConfig({ model, injectedMcpServers, toolIntegrationMode, skillsPathAllowlist });
  let opencode = null;
  let sessionId = resumeSessionId || null;
  let hasContent = false;
  let failed = false;
  let abortSent = false;
  let removeAbortListener = null;
  const state = { reasoningOpen: false };
  const directoryQuery = cwd ? { directory: cwd } : undefined;

  try {
    const factory = openCodeFactory || ((options) => createDefaultOpenCode(options, env, binPath));
    opencode = await factory(await withOpenCodeServerPort({ config, signal: abortController?.signal }));
    const { client } = opencode;
    const abortOpenCode = async () => {
      if (abortSent) return;
      abortSent = true;
      if (sessionId) {
        try { await client.session.abort({ path: { id: sessionId }, query: directoryQuery }); } catch {}
      }
      try { opencode?.server?.close?.(); } catch {}
    };
    if (abortController?.signal) {
      const onAbort = () => { void abortOpenCode(); };
      abortController.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => abortController.signal.removeEventListener("abort", onAbort);
    }
    const events = await client.global.event({ signal: abortController?.signal });

    if (!sessionId) {
      const created = await client.session.create({
        body: { title: "Netcatty OpenCode" },
        query: directoryQuery,
      });
      sessionId = created?.data?.id || created?.id || null;
    }
    if (!sessionId) throw new Error("OpenCode did not create a session");
    emitter.sessionId(sessionId);

    const stopEventLoopWait = createStopWait();
    const eventLoop = (async () => {
      const iterator = events.stream?.[Symbol.asyncIterator]?.();
      if (!iterator) return;
      const abortWait = createAbortWait(abortController?.signal);
      try {
        while (true) {
          const nextEvent = iterator.next();
          const raced = await Promise.race([
            nextEvent.then(
              (value) => ({ type: "event", value }),
              (error) => ({ type: "error", error }),
            ),
            abortWait.promise.then(() => ({ type: "abort" })),
            stopEventLoopWait.promise.then(() => ({ type: "stop" })),
          ]);
          if (raced.type === "abort") break;
          if (raced.type === "stop") break;
          if (raced.type === "error") throw raced.error;
          const { value: event, done } = raced.value;
          if (done) break;
          if (abortController?.signal?.aborted) break;
          const eventSessionId = getOpenCodeSessionIdFromEvent(event);
          if (eventSessionId && eventSessionId !== sessionId) continue;
          const result = translateOpenCodeEvent(event, emitter, state);
          if (result.content) hasContent = true;
          if (result.error) {
            failed = true;
            break;
          }
          if (result.idle) break;
        }
      } finally {
        abortWait.dispose();
        if (abortController?.signal?.aborted || stopEventLoopWait.stopped) {
          try { void iterator.return?.(); } catch {}
        }
      }
    })();

    const body = {
      parts: buildOpenCodePromptParts(prompt, attachments),
    };
    if (systemPrompt) body.system = String(systemPrompt);
    const parsedModel = parseOpenCodeModel(model);
    if (parsedModel) body.model = parsedModel;

    const promptAbortWait = createAbortWait(abortController?.signal);
    const promptResult = await Promise.race([
      client.session.promptAsync({
        path: { id: sessionId },
        query: directoryQuery,
        body,
        signal: abortController?.signal,
        throwOnError: true,
      }).then(
        (result) => {
          const error = getOpenCodeResultError(result);
          return error ? { type: "error", error } : { type: "prompt" };
        },
        (error) => ({ type: "error", error }),
      ),
      promptAbortWait.promise.then(() => ({ type: "abort" })),
    ]);
    promptAbortWait.dispose();
    if (promptResult.type === "error") {
      failed = true;
      await abortOpenCode();
      stopEventLoopWait.stop();
      await eventLoop.catch(() => {});
      throw promptResult.error;
    }

    if (promptResult.type === "abort") {
      await abortOpenCode();
    } else {
      await eventLoop;
    }

    if (abortController?.signal?.aborted) {
      await abortOpenCode();
    }

    if (!hasContent && !failed && !abortController?.signal?.aborted) {
      emitter.emitError("OpenCode returned an empty response. Run `opencode` in a terminal to configure authentication and models.");
      return { sessionId };
    }
    if (!failed && !abortController?.signal?.aborted) emitter.emitDone();
    return { sessionId };
  } catch (error) {
    const classified = classifyOpenCodeSpawnError(error);
    if (classified.isSpawnEnoent) {
      emitter.emitError("OpenCode CLI not found or not runnable. Install OpenCode and ensure `opencode` is on PATH, or set a custom path in Settings.");
    } else {
      emitter.emitError(extractOpenCodeErrorMessage(error) || classified.message || "OpenCode turn failed");
    }
    return { sessionId };
  } finally {
    removeAbortListener?.();
    try { opencode?.server?.close?.(); } catch {}
  }
}

function mapOpenCodeModels(response) {
  const providers = Array.isArray(response?.providers) ? response.providers : [];
  const models = [];
  for (const provider of providers) {
    const providerId = provider?.id || provider?.providerID;
    if (!providerId || !provider?.models || typeof provider.models !== "object") continue;
    for (const [modelId, info] of Object.entries(provider.models)) {
      models.push({
        id: `${providerId}/${modelId}`,
        name: `${provider.name || providerId} ${info?.name || modelId}`,
      });
    }
  }
  return models;
}

function getOpenCodeDefaultModelId(response) {
  const value = response?.default;
  if (!value) return null;
  if (typeof value === "string") return value.includes("/") ? value : null;
  if (typeof value !== "object") return null;
  if (typeof value.model === "string" && value.model.includes("/")) return value.model;
  if (typeof value.providerID === "string" && typeof value.modelID === "string") {
    return `${value.providerID}/${value.modelID}`;
  }
  if (typeof value.provider === "string" && typeof value.model === "string") {
    return `${value.provider}/${value.model}`;
  }
  for (const [providerId, modelId] of Object.entries(value)) {
    if (typeof modelId === "string" && providerId && modelId) {
      return modelId.includes("/") ? modelId : `${providerId}/${modelId}`;
    }
    if (modelId && typeof modelId === "object" && typeof modelId.modelID === "string") {
      const nestedProvider = typeof modelId.providerID === "string" ? modelId.providerID : providerId;
      return `${nestedProvider}/${modelId.modelID}`;
    }
  }
  return null;
}

async function listOpenCodeModels({ env, binPath, openCodeFactory } = {}) {
  let opencode = null;
  try {
    const factory = openCodeFactory || ((options) => createDefaultOpenCode(options, env, binPath));
    opencode = await factory(await withOpenCodeServerPort({ config: { autoupdate: false }, timeout: 10000 }));
    const response = await opencode.client.config.providers();
    if (response?.error) {
      throw new Error(extractOpenCodeErrorMessage(response.error) || "OpenCode providers unavailable");
    }
    const data = response?.data || response;
    return {
      currentModelId: getOpenCodeDefaultModelId(data),
      models: mapOpenCodeModels(data),
    };
  } catch {
    return { currentModelId: null, models: [] };
  } finally {
    try { opencode?.server?.close?.(); } catch {}
  }
}

module.exports = {
  buildOpenCodeConfig,
  buildOpenCodePromptParts,
  classifyOpenCodeSpawnError,
  createOpenCodeProcessEnv,
  withOpenCodeProcessEnv,
  listOpenCodeModels,
  mapOpenCodeModels,
  parseOpenCodeModel,
  resolveUsableOpenCodeBinPath,
  runOpenCodeTurn,
  toOpenCodeMcpConfig,
  translateOpenCodeEvent,
};
