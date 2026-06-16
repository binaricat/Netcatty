"use strict";

/**
 * Cursor backend driver — wraps @cursor/sdk.
 *
 * Cursor SDK local agents use Agent.create({ apiKey, model, local:{cwd},
 * mcpServers }) and stream SDKMessage events from run.stream().
 */
const { mcpEnvPairsToObject } = require("./injectMcp.cjs");

const DEFAULT_CURSOR_MODEL = "composer-2.5";

function toCursorMcpServers(injectedMcpServers) {
  const servers = {};
  for (const cfg of injectedMcpServers || []) {
    if (!cfg || !cfg.name || !cfg.command) continue;
    servers[cfg.name] = {
      type: "stdio",
      command: cfg.command,
      args: cfg.args || [],
      env: mcpEnvPairsToObject(cfg.env),
    };
  }
  return servers;
}

function parseCursorModelSelection(model) {
  const raw = String(model || DEFAULT_CURSOR_MODEL).trim() || DEFAULT_CURSOR_MODEL;
  const queryIndex = raw.indexOf("?");
  if (queryIndex < 0) return { id: raw };

  const id = raw.slice(0, queryIndex);
  const search = new URLSearchParams(raw.slice(queryIndex + 1));
  const params = [];
  for (const [paramId, value] of search.entries()) {
    if (paramId && value) params.push({ id: paramId, value });
  }
  return params.length > 0 ? { id, params } : { id };
}

function buildCursorAgentOptions({ apiKey, env, model, cwd, injectedMcpServers }) {
  const effectiveApiKey = apiKey || env?.CURSOR_API_KEY || process.env.CURSOR_API_KEY;
  const options = {
    apiKey: effectiveApiKey,
    model: parseCursorModelSelection(model),
    local: {
      cwd: cwd || process.cwd(),
      autoReview: false,
    },
  };
  const mcpServers = toCursorMcpServers(injectedMcpServers);
  if (Object.keys(mcpServers).length > 0) options.mcpServers = mcpServers;
  return options;
}

function applyTemporaryProcessEnv(env) {
  if (!env || typeof env !== "object") return () => {};
  const previous = new Map();
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    previous.set(key, Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined);
    process.env[key] = value;
  }

  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function withTemporaryProcessEnv(env, fn) {
  const restore = applyTemporaryProcessEnv(env);
  try {
    return await fn();
  } finally {
    restore();
  }
}

function buildCursorSendMessage(prompt, attachments) {
  const images = [];
  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    if (!attachment?.base64Data || !attachment?.mediaType) continue;
    if (!String(attachment.mediaType).toLowerCase().startsWith("image/")) continue;
    images.push({ data: attachment.base64Data, mimeType: attachment.mediaType });
  }
  if (images.length === 0) return String(prompt || "");
  return { text: String(prompt || ""), images };
}

function resultToText(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "number" || typeof result === "boolean") return String(result);
  const content = result.content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (!block) return "";
        if (typeof block.text === "string") return block.text;
        if (block.type === "image") return "[image]";
        return JSON.stringify(block);
      })
      .join("");
  }
  return JSON.stringify(result);
}

function redactCursorSecret(value) {
  return String(value || "")
    .replace(/crsr[_-]?[A-Za-z0-9_-]{8,}/g, "[redacted-cursor-key]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted-token]");
}

function cursorErrorDiagnostics(error) {
  if (!error || typeof error !== "object") {
    return { message: redactCursorSecret(error) };
  }
  return {
    name: error.name || null,
    message: redactCursorSecret(error.message || String(error)),
    code: error.code || null,
    status: error.status || null,
    operation: error.operation || null,
    endpoint: error.endpoint || null,
    requestId: error.requestId || null,
    isRetryable: typeof error.isRetryable === "boolean" ? error.isRetryable : null,
    cause: error.cause && typeof error.cause === "object"
      ? {
        name: error.cause.name || null,
        message: redactCursorSecret(error.cause.message || String(error.cause)),
      }
      : null,
  };
}

function isCursorAuthMessage(message) {
  return /api.?key|auth|unauthorized|unauthenticated/i.test(String(message || ""));
}

async function logCursorApiKeyValidation(resolvedModule, apiKey) {
  if (!apiKey || typeof resolvedModule?.Cursor?.me !== "function") return;
  try {
    const user = await resolvedModule.Cursor.me({ apiKey });
    console.info("[Cursor SDK] API key validation ok", {
      hasUserId: user?.userId != null,
      hasEmail: Boolean(user?.email),
      createdAt: user?.createdAt || null,
    });
  } catch (error) {
    console.warn("[Cursor SDK] API key validation failed", cursorErrorDiagnostics(error));
  }
}

function closeReasoning(state, emitter) {
  if (state?.reasoningOpen) {
    emitter.reasoningEnd();
    state.reasoningOpen = false;
  }
}

function emitCursorToolCallOnce(event, emitter, state, toolName, args, id) {
  if (!id) return false;
  if (!state.emittedToolCalls) state.emittedToolCalls = new Set();
  if (state.emittedToolCalls.has(id)) return false;
  state.emittedToolCalls.add(id);
  emitter.toolCall(toolName || "tool", args && typeof args === "object" ? args : {}, id);
  return true;
}

function emitCursorToolResultOnce(event, emitter, state, id, result, toolName) {
  if (!id) return false;
  if (!state.emittedToolResults) state.emittedToolResults = new Set();
  if (state.emittedToolResults.has(id)) return false;
  state.emittedToolResults.add(id);
  emitter.toolResult(id, resultToText(result), toolName);
  return true;
}

function getCursorDisplayToolName(rawName, args) {
  const name = String(rawName || "").trim();
  const input = args && typeof args === "object" ? args : {};
  const nestedToolName = typeof input.toolName === "string" ? input.toolName.trim() : "";
  if ((name === "mcp" || name === "tool" || !name) && nestedToolName) {
    return nestedToolName;
  }
  return name || nestedToolName || "tool";
}

function formatCursorErrorForUser(message) {
  const text = String(message || "").trim();
  if (/api.?key|auth|unauthorized/i.test(text)) {
    return "Cursor authentication failed. Update the Cursor API Key in Settings -> AI.";
  }
  return text || "Cursor turn failed";
}

function translateCursorEvent(event, emitter, state = {}) {
  if (!event || typeof event !== "object") return;

  switch (event.type) {
    case "thinking":
      if (event.text) {
        emitter.reasoning(String(event.text));
        state.reasoningOpen = true;
      }
      return;
    case "assistant": {
      closeReasoning(state, emitter);
      const content = event.message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (!block) continue;
        if (block.type === "text" && block.text) {
          emitter.text(String(block.text));
        } else if (block.type === "tool_use") {
          emitCursorToolCallOnce(
            event,
            emitter,
            state,
            getCursorDisplayToolName(block.name, block.input),
            block.input,
            block.id,
          );
        }
      }
      return;
    }
    case "tool_call": {
      closeReasoning(state, emitter);
      const id = event.call_id;
      const name = getCursorDisplayToolName(event.name, event.args);
      if (event.status === "running") {
        emitCursorToolCallOnce(event, emitter, state, name, event.args, id);
      } else if (event.status === "completed" || event.status === "error") {
        emitCursorToolCallOnce(event, emitter, state, name, event.args, id);
        emitCursorToolResultOnce(event, emitter, state, id, event.result || event.error || "", name);
      }
      return;
    }
    case "status":
      if (event.status === "ERROR") {
        closeReasoning(state, emitter);
        state.failed = true;
        state.errorMessage = String(event.message || "");
        console.warn("[Cursor SDK] status error", {
          message: redactCursorSecret(event.message || ""),
        });
        emitter.emitError(formatCursorErrorForUser(event.message));
        return true;
      }
      return false;
    default:
      return false;
  }
}

class CursorTurnAbortError extends Error {
  constructor() {
    super("Cursor turn aborted");
    this.name = "CursorTurnAbortError";
  }
}

function isCursorTurnAbortError(error) {
  return error instanceof CursorTurnAbortError || error?.name === "CursorTurnAbortError";
}

async function abortable(promise, signal, onLateResolve) {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.then((value) => onLateResolve?.(value)).catch(() => {});
    throw new CursorTurnAbortError();
  }

  let aborted = false;
  let removeAbortListener = () => {};
  const abortPromise = new Promise((_, reject) => {
    const onAbort = () => {
      aborted = true;
      reject(new CursorTurnAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });

  try {
    return await Promise.race([promise, abortPromise]);
  } finally {
    removeAbortListener();
    if (aborted) {
      promise.then((value) => onLateResolve?.(value)).catch(() => {});
    }
  }
}

async function runCursorTurn({
  prompt, attachments, agentOptions, runtimeEnv, resumeSessionId, emitter, signal, sdkModule,
}) {
  let resolvedModule = sdkModule;
  if (!resolvedModule) {
    try {
      resolvedModule = await import("@cursor/sdk");
    } catch {
      emitter.emitError("Cursor SDK not installed. Run: npm install @cursor/sdk");
      return { sessionId: resumeSessionId || null };
    }
  }

  const { Agent } = resolvedModule;
  let agent = null;
  let run = null;
  let sessionId = resumeSessionId || null;
  try {
    const restoreCreateEnv = applyTemporaryProcessEnv(runtimeEnv);
    try {
      const agentPromise = resumeSessionId && typeof Agent.resume === "function"
        ? Agent.resume(resumeSessionId, agentOptions)
        : Agent.create(agentOptions);
      agent = await abortable(agentPromise, signal, (lateAgent) => {
        try { lateAgent?.close?.(); } catch { /* best effort */ }
      });
    } finally {
      restoreCreateEnv();
    }
    sessionId = agent.agentId || sessionId;
    if (sessionId) emitter.sessionId(sessionId);
    if (signal?.aborted) return { sessionId };

    const sendMessage = buildCursorSendMessage(prompt, attachments);
    const restoreSendEnv = applyTemporaryProcessEnv(runtimeEnv);
    try {
      run = await abortable(agent.send(sendMessage), signal, (lateRun) => {
        if (lateRun && typeof lateRun.cancel === "function") {
          void lateRun.cancel().catch(() => {});
        }
      });
    } finally {
      restoreSendEnv();
    }
    const state = { reasoningOpen: false };
    let hasContent = false;
    let failed = false;
    const onAbort = () => {
      if (run && typeof run.cancel === "function") {
        void run.cancel().catch(() => {});
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      for await (const event of run.stream()) {
        if (signal?.aborted) break;
        if (event?.type === "assistant" || event?.type === "tool_call") hasContent = true;
        const streamFailed = translateCursorEvent(event, emitter, state);
        if (streamFailed || state.failed) {
          failed = true;
          break;
        }
      }
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
    }
    closeReasoning(state, emitter);
    if (failed) {
      if (isCursorAuthMessage(state.errorMessage)) {
        await logCursorApiKeyValidation(resolvedModule, agentOptions?.apiKey);
      }
      return { sessionId };
    }
    if (!hasContent && !signal?.aborted) {
      emitter.emitError("Cursor returned an empty response. Check the Cursor API Key in Settings -> AI.");
      return { sessionId };
    }
    if (!signal?.aborted) emitter.emitDone();
    return { sessionId };
  } catch (error) {
    if (isCursorTurnAbortError(error) || signal?.aborted) {
      return { sessionId };
    }
    {
      const message = error?.message || String(error);
      console.warn("[Cursor SDK] run error", cursorErrorDiagnostics(error));
      if (isCursorAuthMessage(message)) {
        await logCursorApiKeyValidation(resolvedModule, agentOptions?.apiKey);
      }
      emitter.emitError(formatCursorErrorForUser(message));
    }
    return { sessionId };
  } finally {
    try { await agent?.close?.(); } catch { /* best effort */ }
  }
}

function modelVariantId(modelId, params) {
  const search = new URLSearchParams();
  for (const param of params || []) {
    if (param?.id && param?.value) search.set(param.id, param.value);
  }
  const qs = search.toString();
  return qs ? `${modelId}?${qs}` : modelId;
}

function mapCursorModels(models) {
  const out = [];
  if (!Array.isArray(models)) return out;
  for (const model of models) {
    if (!model?.id) continue;
    const name = model.displayName || model.name || model.id;
    out.push({
      id: model.id,
      name,
      ...(model.description ? { description: model.description } : {}),
    });
    for (const variant of model.variants || []) {
      const id = modelVariantId(model.id, variant.params || []);
      if (id === model.id) continue;
      out.push({
        id,
        name: `${name} - ${variant.displayName || id}`,
        ...(variant.description ? { description: variant.description } : {}),
      });
    }
  }
  return out;
}

async function listCursorModels({ apiKey, env, sdkModule } = {}) {
  let resolvedModule = sdkModule;
  if (!resolvedModule) {
    try { resolvedModule = await import("@cursor/sdk"); } catch { return []; }
  }
  const effectiveApiKey = apiKey || env?.CURSOR_API_KEY || process.env.CURSOR_API_KEY;
  if (!effectiveApiKey) return [];
  const models = await resolvedModule.Cursor.models.list({ apiKey: effectiveApiKey });
  return mapCursorModels(models);
}

module.exports = {
  DEFAULT_CURSOR_MODEL,
  abortable,
  applyTemporaryProcessEnv,
  buildCursorAgentOptions,
  buildCursorSendMessage,
  formatCursorErrorForUser,
  listCursorModels,
  mapCursorModels,
  parseCursorModelSelection,
  runCursorTurn,
  toCursorMcpServers,
  translateCursorEvent,
  withTemporaryProcessEnv,
};
