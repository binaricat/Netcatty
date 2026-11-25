"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const { StringDecoder } = require("node:string_decoder");

const DEFAULT_MAX_LINE_BYTES = 10 * 1024 * 1024;
const DEFAULT_ABORT_GRACE_MS = 1_500;
const ANTHROPIC_IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function closeReasoning(state, emitter) {
  if (state?.reasoningOpen) {
    emitter.reasoningEnd();
    state.reasoningOpen = false;
  }
}

function getAvailablePort(host = "127.0.0.1", avoidPort = 0) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(avoidPort && port === avoidPort ? getAvailablePort(host, avoidPort) : port);
      });
    });
  });
}

function signalProcessTree(child, signal, forceKillImpl) {
  if (!child) return;
  if (typeof forceKillImpl === "function") {
    try { forceKillImpl(child, signal); } catch { /* ignore */ }
    return;
  }
  if (process.platform === "win32" && signal === "SIGKILL" && child.pid) {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {});
      killer.unref?.();
      return;
    } catch {
      // Fall through to ChildProcess.kill below.
    }
  }
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The child may not be a process-group leader (for injected tests or an
      // older runtime). Fall back to killing the direct child.
    }
  }
  try { child.kill(signal); } catch { /* ignore */ }
}

function createLineBuffer(
  onLine,
  {
    maxBytes = DEFAULT_MAX_LINE_BYTES,
    errorLabel = "Stream",
    errorCode = "LINE_LIMIT",
  } = {},
) {
  let buffer = "";
  let bufferedBytes = 0;
  let overflowed = false;
  const decoder = new StringDecoder("utf8");
  return {
    push(chunk) {
      if (overflowed) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk || ""));
      bufferedBytes += bytes.length;
      buffer += decoder.write(bytes);
      let idx;
      let consumedLine = false;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        consumedLine = true;
        if (line) onLine(line);
      }
      if (consumedLine) bufferedBytes = Buffer.byteLength(buffer, "utf8") + decoder.lastNeed;
      if (bufferedBytes > maxBytes) {
        overflowed = true;
        buffer = "";
        const error = new Error(`${errorLabel} message exceeded ${maxBytes} bytes`);
        error.code = errorCode;
        throw error;
      }
    },
    flush() {
      if (overflowed) return;
      buffer += decoder.end();
      const line = buffer.trim();
      buffer = "";
      if (line) onLine(line);
    },
  };
}

function createBoundedTextCollector(maxBytes) {
  const decoder = new StringDecoder("utf8");
  let text = "";
  let bytes = 0;
  let truncated = false;
  let ended = false;
  return {
    push(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remaining = Math.max(0, maxBytes - bytes);
      const accepted = buffer.length <= remaining ? buffer : buffer.subarray(0, remaining);
      if (accepted.length > 0) text += decoder.write(accepted);
      bytes += accepted.length;
      if (accepted.length < buffer.length) truncated = true;
    },
    end() {
      if (!ended) {
        ended = true;
        if (!truncated || decoder.lastNeed === 0) text += decoder.end();
      }
      return text;
    },
    text() {
      return text;
    },
  };
}

function attachAbortGraceKill(
  child,
  {
    signal,
    abortGraceMs = DEFAULT_ABORT_GRACE_MS,
    forceKillImpl,
    termForceKillImpl,
    isSettled,
    onBeforeSignal,
    onAfterTerm,
    onGraceTimeout,
  },
) {
  let forceKillTimer = null;
  let terminationStarted = false;
  const onAbort = () => {
    if (isSettled() || terminationStarted) return;
    terminationStarted = true;
    onBeforeSignal?.();
    forceKillTimer = setTimeout(() => {
      if (isSettled()) return;
      signalProcessTree(child, "SIGKILL", forceKillImpl);
      onGraceTimeout?.();
    }, Math.max(0, abortGraceMs));
    forceKillTimer.unref?.();
    signalProcessTree(child, "SIGTERM", termForceKillImpl);
    onAfterTerm?.();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    clearTimer() {
      clearTimeout(forceKillTimer);
    },
    dispose() {
      clearTimeout(forceKillTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
    },
  };
}

function collectBoundedStdout({
  spawnChild,
  maxBytes,
  signal,
  abortGraceMs = DEFAULT_ABORT_GRACE_MS,
  forceKillImpl,
}) {
  return new Promise((resolve) => {
    const stdoutCollector = createBoundedTextCollector(maxBytes);
    let settled = false;
    let abortGuard = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      abortGuard?.dispose();
      resolve(value);
    };

    let child;
    try {
      child = spawnChild();
    } catch {
      finish(null);
      return;
    }

    child.stdout?.on("data", (chunk) => {
      if (signal?.aborted) return;
      stdoutCollector.push(chunk);
    });
    child.on("error", () => finish(null));
    child.on("close", () => {
      finish(stdoutCollector.end());
    });

    abortGuard = attachAbortGraceKill(child, {
      signal,
      abortGraceMs,
      forceKillImpl,
      termForceKillImpl: forceKillImpl,
      isSettled: () => settled,
      onGraceTimeout: () => finish(null),
    });
  });
}

function resultToText(
  result,
  {
    includeSuccessContent = false,
    includeText = false,
    includeMessage = false,
  } = {},
) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  if (typeof result === "number" || typeof result === "boolean") return String(result);
  if (typeof result === "object") {
    if (typeof result.content === "string") return result.content;
    if (includeSuccessContent && result.success && typeof result.success.content === "string") {
      return result.success.content;
    }
    if (includeText && typeof result.text === "string") return result.text;
    if (includeMessage && typeof result.message === "string") return result.message;
    try { return JSON.stringify(result); } catch { return String(result); }
  }
  return String(result);
}

function isAnthropicImageAttachment(attachment) {
  return Boolean(
    attachment &&
    ANTHROPIC_IMAGE_MEDIA_TYPES.has(String(attachment.mediaType || "").toLowerCase()) &&
    attachment.base64Data,
  );
}

function buildMultimodalUserPrompt(prompt, attachments) {
  const imageAttachments = Array.isArray(attachments)
    ? attachments.filter(isAnthropicImageAttachment)
    : [];
  if (imageAttachments.length === 0) return String(prompt || "");

  const content = [{ type: "text", text: String(prompt || "") }];
  for (const attachment of imageAttachments) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: String(attachment.mediaType).toLowerCase(),
        data: attachment.base64Data,
      },
    });
  }

  return (async function* multimodalUserPrompt() {
    yield {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    };
  }());
}

async function* createIdleAbortableInput(signal) {
  await new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function querySupportedModelsWithIdleSession({
  queryFn,
  queryOptions,
  externalSignal,
  mapModels,
}) {
  const queryAbortController = new AbortController();
  const forwardAbort = () => {
    try { queryAbortController.abort(externalSignal?.reason); } catch { /* ignore */ }
  };
  if (externalSignal) {
    externalSignal.addEventListener("abort", forwardAbort, { once: true });
    if (externalSignal.aborted) forwardAbort();
  }
  let q;
  try {
    q = queryFn({
      prompt: createIdleAbortableInput(queryAbortController.signal),
      options: {
        ...queryOptions,
        abortController: queryAbortController,
        includePartialMessages: false,
      },
    });
    const result = await Promise.race([
      Promise.resolve(q.supportedModels()).then((models) => ({ type: "models", models })),
      new Promise((resolve) => {
        if (queryAbortController.signal.aborted) return resolve({ type: "aborted" });
        queryAbortController.signal.addEventListener(
          "abort",
          () => resolve({ type: "aborted" }),
          { once: true },
        );
      }),
    ]);
    return result.type === "models" ? mapModels(result.models) : [];
  } catch {
    return [];
  } finally {
    if (externalSignal) externalSignal.removeEventListener("abort", forwardAbort);
    queryAbortController.abort();
    try { void Promise.resolve(q?.return?.(undefined)).catch(() => {}); } catch { /* best effort */ }
  }
}

function forwardAnthropicStreamEvent(event, emitter) {
  if (!event || event.type !== "content_block_delta" || !event.delta) return;
  if (event.delta.type === "text_delta" && event.delta.text) {
    emitter.text(event.delta.text);
  } else if (event.delta.type === "thinking_delta" && event.delta.thinking) {
    emitter.reasoning(event.delta.thinking);
  }
}

function forwardAnthropicToolResultBlocks(blocks, emitter) {
  for (const block of blocks) {
    if (block?.type === "tool_result") {
      const out = typeof block.content === "string"
        ? block.content
        : JSON.stringify(block.content);
      emitter.toolResult(block.tool_use_id, out, undefined);
    }
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

function findFirstExistingExecutable(candidates) {
  for (const rawCandidate of candidates || []) {
    if (!rawCandidate) continue;
    const candidate = String(rawCandidate);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch { /* ignore */ }
  }
  return undefined;
}

module.exports = {
  ANTHROPIC_IMAGE_MEDIA_TYPES,
  attachAbortGraceKill,
  buildMultimodalUserPrompt,
  closeReasoning,
  collectBoundedStdout,
  createAbortWait,
  createBoundedTextCollector,
  createIdleAbortableInput,
  createLineBuffer,
  createStopWait,
  findFirstExistingExecutable,
  forwardAnthropicStreamEvent,
  forwardAnthropicToolResultBlocks,
  getAvailablePort,
  isAnthropicImageAttachment,
  querySupportedModelsWithIdleSession,
  resultToText,
  signalProcessTree,
};
