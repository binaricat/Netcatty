"use strict";

const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { mcpEnvPairsToObject } = require("./injectMcp.cjs");
const {
  buildOpenCodeNativeSkillsPermissionRules,
  buildOpenCodeSkillsPermissionRules,
} = require("./netcattySkillsOpenCodePermissions.cjs");

const OPENCODE_IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const DEFAULT_OPENCODE_PORT = 4096;
/** Best-effort question reject during abort/finally must not hang turn cleanup. */
const OPENCODE_QUESTION_REJECT_TIMEOUT_MS = 2000;

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

function normalizeOpenCodeQuestions(rawQuestions) {
  return (Array.isArray(rawQuestions) ? rawQuestions : []).map((question, index) => {
    const options = Array.isArray(question?.options)
      ? question.options
        .map((option) => ({
          label: String(option?.label || ""),
          description: String(option?.description || ""),
        }))
        .filter((option) => option.label)
      : [];
    return {
      id: String(question?.id || `q${index}`),
      header: String(question?.header || ""),
      question: String(question?.question || ""),
      isOther: Boolean(question?.custom),
      isSecret: false,
      multiple: Boolean(question?.multiple),
      options: options.length > 0 ? options : null,
    };
  });
}

function answersRecordToOpenCodeAnswers(questions, answersRecord) {
  return (Array.isArray(questions) ? questions : []).map((question) => {
    const entry = answersRecord?.[question?.id];
    const answers = entry?.answers;
    return Array.isArray(answers) ? answers.map((value) => String(value)) : [];
  });
}

function normalizeOpenCodeQuestionVersion(version, eventType) {
  if (version === "v2" || version === "v1") return version;
  if (String(eventType || "").includes(".v2.")) return "v2";
  return "v1";
}

function buildOpenCodeQuestionReplyUrl({ baseUrl, requestId, directory, action, sessionId, version } = {}) {
  const root = String(baseUrl || "").replace(/\/?$/, "/");
  const encodedRequestId = encodeURIComponent(String(requestId || ""));
  const path = normalizeOpenCodeQuestionVersion(version) === "v2"
    ? `api/session/${encodeURIComponent(String(sessionId || ""))}/question/${encodedRequestId}/${action}`
    : `question/${encodedRequestId}/${action}`;
  const url = new URL(path, root);
  if (directory) url.searchParams.set("directory", String(directory));
  return url.toString();
}

async function replyOpenCodeQuestionHttp({
  baseUrl, requestId, answers, directory, sessionId, version, fetchImpl,
} = {}) {
  const fetchFn = fetchImpl || fetch;
  const response = await fetchFn(buildOpenCodeQuestionReplyUrl({
    baseUrl,
    requestId,
    directory,
    sessionId,
    version,
    action: "reply",
  }), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answers: Array.isArray(answers) ? answers : [] }),
  });
  if (!response?.ok) {
    const text = typeof response?.text === "function" ? await response.text().catch(() => "") : "";
    throw new Error(text || `OpenCode question reply failed (${response?.status || "unknown"})`);
  }
  return true;
}

async function rejectOpenCodeQuestionHttp({
  baseUrl, requestId, directory, sessionId, version, fetchImpl, signal,
} = {}) {
  const fetchFn = fetchImpl || fetch;
  const response = await fetchFn(buildOpenCodeQuestionReplyUrl({
    baseUrl,
    requestId,
    directory,
    sessionId,
    version,
    action: "reject",
  }), {
    method: "POST",
    signal,
  });
  if (!response?.ok) {
    const text = typeof response?.text === "function" ? await response.text().catch(() => "") : "";
    throw new Error(text || `OpenCode question reject failed (${response?.status || "unknown"})`);
  }
  return true;
}

function createTimeoutSignal(ms) {
  if (typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    try { controller.abort(); } catch { /* ignore */ }
  }, ms);
  if (typeof timer.unref === "function") timer.unref();
  return controller.signal;
}

/** Bound a best-effort promise even if the callee ignores AbortSignal. */
function raceWithTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`timed out after ${ms}ms`));
      }, ms);
      if (typeof timer.unref === "function") timer.unref();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function buildOpenCodeConfig({ model, injectedMcpServers, toolIntegrationMode, skillsPathAllowlist } = {}) {
  const allowBash = toolIntegrationMode === "skills";
  const permission = {
    edit: "deny",
    bash: allowBash ? "allow" : "deny",
    webfetch: "deny",
    // Host UI answers via question.asked → /question/{id}/reply (issue #2585).
    question: "allow",
    // Keep external access locked down, but let OpenCode's native skills
    // (e.g. ~/.opencode/skills, ~/.config/opencode/skills) read their own
    // reference files in every mode (issue #1939).
    ...buildOpenCodeNativeSkillsPermissionRules(),
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
      // question is completed through question.asked + the reply API; emitting a
      // tool-call row leaves a non-interactive spinner (issue #2585).
      if (toolName === "question") {
        return { idle: false, error: false, content: false };
      }
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

  if (payload.type === "question.asked" || payload.type === "question.v2.asked") {
    const properties = payload.properties || {};
    const requestId = properties.id || properties.requestID || properties.requestId || null;
    if (requestId) {
      emitter.questionAsk?.({
        requestId: String(requestId),
        sessionId: properties.sessionID || properties.sessionId || null,
        version: normalizeOpenCodeQuestionVersion(null, payload.type),
        questions: Array.isArray(properties.questions) ? properties.questions : [],
        tool: properties.tool,
      });
    }
    return { idle: false, error: false, content: Boolean(requestId) };
  }

  if (
    payload.type === "question.replied"
    || payload.type === "question.v2.replied"
    || payload.type === "question.rejected"
    || payload.type === "question.v2.rejected"
  ) {
    const properties = payload.properties || {};
    const requestId = properties.requestID || properties.requestId || properties.id || null;
    if (requestId) {
      emitter.questionSettled?.({
        requestId: String(requestId),
        sessionId: properties.sessionID || properties.sessionId || null,
        status: String(payload.type).includes("reject") ? "rejected" : "replied",
      });
    }
    return { idle: false, error: false, content: false };
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

function closeOpenCodeInstance(opencode) {
  try { opencode?.server?.close?.(); } catch {}
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

  // Restore the Electron main-process environment as soon as the child has been
  // spawned. Keeping PATH/OPENCODE_BIN pointed at a temporary shim for the
  // server lifetime (or list-models idle window) can leak into later turns and
  // other spawns; see #2184 review. The on-disk shim stays until close() so a
  // still-running child that re-resolves helpers does not race a deleted path.
  const restoreProcessEnv = () => {
    if (restoreProcessEnv.done) return;
    restoreProcessEnv.done = true;
    for (const key of Object.keys(nextEnv)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  };

  const cleanup = () => {
    if (cleanup.done) return;
    cleanup.done = true;
    restoreProcessEnv();
    cleanupShim();
  };

  try {
    const opencode = await sdk.createOpencode(options);
    restoreProcessEnv();
    const originalClose = opencode.server?.close?.bind(opencode.server);
    if (typeof originalClose === "function") {
      opencode.server.close = () => {
        try { originalClose(); } catch {}
        cleanup();
      };
    } else {
      cleanup();
    }
    return opencode;
  } catch (error) {
    cleanup();
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
  onQuestionAsk, onQuestionSettled, fetchImpl,
}) {
  const config = buildOpenCodeConfig({ model, injectedMcpServers, toolIntegrationMode, skillsPathAllowlist });
  let opencode = null;
  let sessionId = resumeSessionId || null;
  let hasContent = false;
  let failed = false;
  let abortSent = false;
  let removeAbortListener = null;
  let serverUrl = null;
  const directoryQuery = cwd ? { directory: cwd } : undefined;
  const pendingQuestions = new Map(); // requestId -> { sessionId, version }
  const state = { reasoningOpen: false };
  const turnEmitter = {
    ...emitter,
    questionAsk(payload) {
      if (!payload?.requestId) return;
      const requestId = String(payload.requestId);
      const questionSessionId = payload.sessionId || sessionId || null;
      const version = normalizeOpenCodeQuestionVersion(payload.version);
      pendingQuestions.set(requestId, { sessionId: questionSessionId, version });
      onQuestionAsk?.({
        ...payload,
        sessionId: questionSessionId,
        version,
        baseUrl: serverUrl,
        directory: cwd || undefined,
      });
      emitter.questionAsk?.(payload);
    },
    questionSettled(payload) {
      if (payload?.requestId) pendingQuestions.delete(String(payload.requestId));
      onQuestionSettled?.(payload);
      emitter.questionSettled?.(payload);
    },
  };

  const rejectPendingQuestions = async () => {
    if (!serverUrl || pendingQuestions.size === 0) return;
    const pending = Array.from(pendingQuestions.entries());
    pendingQuestions.clear();
    await Promise.all(pending.map(async ([requestId, meta]) => {
      try {
        const signal = createTimeoutSignal(OPENCODE_QUESTION_REJECT_TIMEOUT_MS);
        await raceWithTimeout(
          rejectOpenCodeQuestionHttp({
            baseUrl: serverUrl,
            requestId,
            sessionId: meta?.sessionId || sessionId || undefined,
            version: meta?.version,
            directory: cwd || undefined,
            fetchImpl,
            signal,
          }),
          OPENCODE_QUESTION_REJECT_TIMEOUT_MS,
        );
      } catch { /* best-effort cleanup */ }
      try {
        onQuestionSettled?.({ requestId, sessionId: meta?.sessionId || sessionId, status: "rejected" });
      } catch { /* ignore */ }
    }));
  };

  try {
    const factory = openCodeFactory || ((options) => createDefaultOpenCode(options, env, binPath));
    opencode = await factory(await withOpenCodeServerPort({ config, signal: abortController?.signal }));
    serverUrl = opencode?.server?.url || null;
    const { client } = opencode;
    const abortOpenCode = async () => {
      if (abortSent) return;
      abortSent = true;
      await rejectPendingQuestions();
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
    turnEmitter.sessionId(sessionId);

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
          const result = translateOpenCodeEvent(event, turnEmitter, state);
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
      turnEmitter.emitError("OpenCode returned an empty response. Run `opencode` in a terminal to configure authentication and models.");
      return { sessionId };
    }
    if (!failed && !abortController?.signal?.aborted) turnEmitter.emitDone();
    return { sessionId };
  } catch (error) {
    const classified = classifyOpenCodeSpawnError(error);
    if (classified.isSpawnEnoent) {
      turnEmitter.emitError("OpenCode CLI not found or not runnable. Install OpenCode and ensure `opencode` is on PATH, or set a custom path in Settings.");
    } else {
      turnEmitter.emitError(extractOpenCodeErrorMessage(error) || classified.message || "OpenCode turn failed");
    }
    return { sessionId };
  } finally {
    removeAbortListener?.();
    await rejectPendingQuestions();
    closeOpenCodeInstance(opencode);
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

function emptyOpenCodeModelCatalog() {
  return { currentModelId: null, models: [] };
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error(String(signal?.reason || "aborted"));
}

function whenAborted(signal) {
  if (!signal) return new Promise(() => {});
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(abortError(signal)), { once: true });
  });
}

// Env vars that can change which OpenCode config / provider catalog is visible.
const OPENCODE_CATALOG_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "OPENCODE_BIN",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG_CONTENT",
];

function buildOpenCodeCatalogEnvFingerprint(env) {
  return OPENCODE_CATALOG_ENV_KEYS
    .map((key) => `${key}=${env?.[key] == null ? "" : String(env[key])}`)
    .join("\u0000");
}

function buildOpenCodeListServerKey(binPath, env) {
  const resolvedBin = String(
    resolveUsableOpenCodeBinPath(binPath, env)
    || binPath
    || env?.OPENCODE_BIN
    || "default",
  );
  // Same binary + different HOME/XDG/OpenCode config must not share a catalog
  // server or cache entry (multi-agent / multi-profile setups).
  return `${resolvedBin}\u0000${buildOpenCodeCatalogEnvFingerprint(env)}`;
}

// Shared list-models servers: coalesce concurrent catalog loads for the same
// binary, then tear down after a short idle so idle Netcatty does not keep
// opencode processes around (issue #2184).
const OPENCODE_LIST_SERVER_IDLE_MS = 1500;
const openCodeListServers = new Map();

function clearOpenCodeListServerIdle(entry) {
  if (!entry?.idleTimer) return;
  clearTimeout(entry.idleTimer);
  entry.idleTimer = null;
}

function disposeOpenCodeListServer(key, entry) {
  const current = openCodeListServers.get(key);
  if (current && current !== entry) return;
  openCodeListServers.delete(key);
  clearOpenCodeListServerIdle(entry);
  try { entry?.createAbort?.abort?.(); } catch {}
  closeOpenCodeInstance(entry?.opencode);
  entry.opencode = null;
}

function releaseOpenCodeListServer(key) {
  const entry = openCodeListServers.get(key);
  if (!entry) return;
  entry.refs = Math.max(0, (entry.refs || 0) - 1);
  if (entry.refs > 0) return;

  // Create still in flight with no waiters: abort so the SDK kills the child.
  if (!entry.opencode && entry.createAbort && !entry.createAbort.signal.aborted) {
    try { entry.createAbort.abort(); } catch {}
    disposeOpenCodeListServer(key, entry);
    return;
  }

  clearOpenCodeListServerIdle(entry);
  entry.idleTimer = setTimeout(() => {
    const current = openCodeListServers.get(key);
    if (!current || current !== entry || current.refs > 0) return;
    disposeOpenCodeListServer(key, entry);
  }, OPENCODE_LIST_SERVER_IDLE_MS);
  if (typeof entry.idleTimer.unref === "function") entry.idleTimer.unref();
}

async function acquireOpenCodeListServer({ env, binPath, openCodeFactory, signal } = {}) {
  if (signal?.aborted) throw abortError(signal);

  const key = buildOpenCodeListServerKey(binPath, env);
  let entry = openCodeListServers.get(key);

  if (entry) {
    clearOpenCodeListServerIdle(entry);
  } else {
    const createAbort = new AbortController();
    entry = {
      key,
      refs: 0,
      opencode: null,
      ready: null,
      idleTimer: null,
      createAbort,
    };
    const factory = openCodeFactory || ((options) => createDefaultOpenCode(options, env, binPath));
    entry.ready = (async () => {
      const options = await withOpenCodeServerPort({
        config: { autoupdate: false },
        timeout: 10000,
        signal: createAbort.signal,
      });
      const opencode = await factory(options);
      // If the last waiter cancelled while create was finishing, kill immediately
      // so the process cannot leak outside the pool map.
      if (createAbort.signal.aborted) {
        closeOpenCodeInstance(opencode);
        throw abortError(createAbort.signal);
      }
      entry.opencode = opencode;
      return opencode;
    })().catch((error) => {
      // Drop a failed create immediately so the next list-models can retry.
      disposeOpenCodeListServer(key, entry);
      throw error;
    });
    openCodeListServers.set(key, entry);
  }

  entry.refs += 1;
  try {
    const opencode = await Promise.race([
      entry.ready,
      whenAborted(signal),
    ]);
    if (signal?.aborted) throw abortError(signal);
    return { key, opencode };
  } catch (error) {
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs <= 0) {
      // Last waiter left before ready: abort spawn so the SDK child is killed.
      try { entry.createAbort?.abort?.(); } catch {}
      disposeOpenCodeListServer(key, entry);
    }
    throw error;
  }
}

function resetOpenCodeListServerPool() {
  for (const [key, entry] of openCodeListServers.entries()) {
    disposeOpenCodeListServer(key, entry);
  }
  openCodeListServers.clear();
}

async function listOpenCodeModels({ env, binPath, openCodeFactory, abortController, signal } = {}) {
  const effectiveSignal = signal || abortController?.signal;
  let acquired = null;
  try {
    if (effectiveSignal?.aborted) return emptyOpenCodeModelCatalog();
    acquired = await acquireOpenCodeListServer({
      env,
      binPath,
      openCodeFactory,
      signal: effectiveSignal,
    });
    if (effectiveSignal?.aborted) return emptyOpenCodeModelCatalog();
    const response = await Promise.race([
      acquired.opencode.client.config.providers(),
      whenAborted(effectiveSignal),
    ]);
    if (response?.error) {
      throw new Error(extractOpenCodeErrorMessage(response.error) || "OpenCode providers unavailable");
    }
    const data = response?.data || response;
    return {
      currentModelId: getOpenCodeDefaultModelId(data),
      models: mapOpenCodeModels(data),
    };
  } catch {
    return emptyOpenCodeModelCatalog();
  } finally {
    if (acquired) releaseOpenCodeListServer(acquired.key);
  }
}

module.exports = {
  answersRecordToOpenCodeAnswers,
  buildOpenCodeConfig,
  buildOpenCodePromptParts,
  buildOpenCodeQuestionReplyUrl,
  classifyOpenCodeSpawnError,
  closeOpenCodeInstance,
  createOpenCodeProcessEnv,
  withOpenCodeProcessEnv,
  listOpenCodeModels,
  mapOpenCodeModels,
  normalizeOpenCodeQuestions,
  parseOpenCodeModel,
  rejectOpenCodeQuestionHttp,
  replyOpenCodeQuestionHttp,
  resolveUsableOpenCodeBinPath,
  resetOpenCodeListServerPool,
  runOpenCodeTurn,
  toOpenCodeMcpConfig,
  translateOpenCodeEvent,
  OPENCODE_QUESTION_REJECT_TIMEOUT_MS,
  OPENCODE_LIST_SERVER_IDLE_MS,
};
