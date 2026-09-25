"use strict";

/**
 * MiMo Code (`mimo`) driver.
 *
 * MiMo Code is a fork of OpenCode, so the wire protocol (SSE events, session
 * parts, provider catalog) matches the OpenCode SDK. We therefore reuse the
 * pure translation helpers from opencodeDriver.cjs.
 *
 * We deliberately do NOT use `@mimo-ai/sdk`'s `createOpencode()`. As of 0.1.15
 * it is incompatible with the `mimo` CLI in three ways:
 *   1. it spawns a binary literally named `opencode`;
 *   2. it waits for a stdout line starting with `opencode server listening`,
 *      but `mimo serve` prints `mimocode server listening on <url>`, so it can
 *      only ever time out;
 *   3. it passes config through `OPENCODE_CONFIG_CONTENT`, while the mimo
 *      binary only reads `MIMOCODE_CONFIG_CONTENT`, so `config` is dropped.
 * Instead we run `mimo serve` ourselves and attach the SDK's
 * `createOpencodeClient` to the URL it reports.
 */
const fs = require("node:fs");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const { prepareCommandForSpawn, resolveCliFromPath } = require("../../ai/shellUtils.cjs");
const {
  buildOpenCodeConfig,
  buildOpenCodePromptParts,
  classifyOpenCodeSpawnError,
  getOpenCodeDefaultModelId,
  getOpenCodeSessionIdFromEvent,
  mapOpenCodeModels,
  parseOpenCodeModel,
  translateOpenCodeEvent,
} = require("./opencodeDriver.cjs");

const DEFAULT_MIMO_PORT = 4096;
// Give `mimo serve` room to boot on a cold start. The SDK default (5000ms) is
// too tight for the first launch after install.
const MIMO_SERVE_TIMEOUT_MS = 10_000;
// `mimo serve` announces readiness as `mimocode server listening on <url>`.
// Accept the OpenCode spelling too so a rebranded build still connects.
const MIMO_LISTENING_RE = /server listening on\s+(https?:\/\/\S+)/;

async function importMimoSdk() {
  try {
    return await import("@mimo-ai/sdk");
  } catch {
    throw new Error("MiMo SDK not installed. Run: npm install @mimo-ai/sdk");
  }
}

/**
 * Resolve an explicit executable for `mimo`.
 *
 * `MIMOCODE_BIN_PATH` is honoured because the npm JS shim reads it first; the
 * platform packages (`@mimo-ai/mimocode-<platform>-<arch>`) only ship
 * `mimo.exe` and are resolved by that shim.
 */
function resolveUsableMimoBinPath(binPath, env) {
  const candidates = [];
  if (binPath) candidates.push(String(binPath));
  if (env?.MIMOCODE_BIN) candidates.push(String(env.MIMOCODE_BIN));
  if (env?.MIMOCODE_BIN_PATH) candidates.push(String(env.MIMOCODE_BIN_PATH));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {}
  }
  return undefined;
}

// How long the server's process group gets to exit on SIGTERM before the
// remaining members are killed outright.
const MIMO_STOP_GRACE_MS = 2000;

function killProcessGroup(pid, signal) {
  process.kill(-pid, signal);
}

function stopMimoProcess(child, {
  platform = process.platform,
  killGroup = killProcessGroup,
  graceMs = MIMO_STOP_GRACE_MS,
} = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  // `mimo` is launched through cmd.exe when the resolved path is the npm .cmd
  // shim, so killing the direct child can orphan the real server. Kill the
  // whole tree instead (same approach the SDK's own stop() uses).
  if (platform === "win32" && child.pid) {
    const out = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    if (!out.error && out.status === 0) return;
  }
  // On macOS/Linux the official npm package's `mimo` is a Node shim that runs
  // the native binary through spawnSync, so signalling only the shim leaves
  // the server listening. spawnMimoServer starts it detached, making the pid
  // the leader of its own process group: signal the whole group, then kill
  // whatever ignored SIGTERM once the grace period is over.
  if (platform !== "win32" && child.pid) {
    try {
      killGroup(child.pid, "SIGTERM");
      const timer = setTimeout(() => {
        try { killGroup(child.pid, "SIGKILL"); } catch {}
      }, graceMs);
      timer.unref?.();
      return;
    } catch {}
  }
  try { child.kill(); } catch {}
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
        else resolve(port === DEFAULT_MIMO_PORT ? getAvailablePort(host) : port);
      });
    });
  });
}

/**
 * Boot `mimo serve` and return a client bound to it.
 *
 * Returns the same `{ client, server }` shape `@mimo-ai/sdk`'s
 * `createOpencode()` would, so the turn/list-models code below mirrors the
 * OpenCode driver.
 */
async function spawnMimoServer({
  config, port, hostname = "127.0.0.1", timeout = MIMO_SERVE_TIMEOUT_MS,
  cwd, env, binPath, signal,
} = {}) {
  const sdk = await importMimoSdk();
  // On Windows the npm shim is `mimo.cmd`, which Node cannot spawn directly,
  // so resolve it through PATH before handing it to prepareCommandForSpawn.
  const resolved = resolveUsableMimoBinPath(binPath, env) || resolveCliFromPath("mimo", env);
  const command = resolved || "mimo";
  const args = ["serve", `--hostname=${hostname}`, `--port=${port}`];

  // The mimo binary reads its config from MIMOCODE_CONFIG_CONTENT (verified in
  // the 0.1.15 binary); OPENCODE_CONFIG_CONTENT is ignored.
  const childEnv = {
    ...process.env,
    ...(env || {}),
    MIMOCODE_CONFIG_CONTENT: JSON.stringify(config ?? {}),
  };

  const spawnSpec = prepareCommandForSpawn(command, args, { unwrapNativeExe: false });
  const child = spawn(spawnSpec.command, spawnSpec.args, {
    cwd: cwd || undefined,
    env: childEnv,
    shell: spawnSpec.shell,
    stdio: ["ignore", "pipe", "pipe"],
    // Own process group on POSIX so stopMimoProcess can reach the native
    // server behind the npm shim. Windows uses taskkill /T instead.
    detached: process.platform !== "win32",
    windowsHide: true,
  });

  const close = () => stopMimoProcess(child);

  const url = await new Promise((resolve, reject) => {
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stopMimoProcess(child);
      reject(new Error(`Timeout waiting for mimo server to start after ${timeout}ms`));
    }, timeout);

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const onData = (chunk) => {
      output += chunk.toString();
      for (const line of output.split("\n")) {
        const match = line.match(MIMO_LISTENING_RE);
        if (match) {
          finish(resolve, match[1]);
          return;
        }
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", (code) => {
      const detail = output.trim() ? `\nmimo output: ${output.trim()}` : "";
      finish(reject, new Error(`mimo server exited with code ${code}${detail}`));
    });
    child.on("error", (error) => finish(reject, error));

    if (signal) {
      if (signal.aborted) {
        finish(reject, signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        stopMimoProcess(child);
        return;
      }
      signal.addEventListener("abort", () => {
        finish(reject, signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        stopMimoProcess(child);
      }, { once: true });
    }
  }).catch((error) => {
    stopMimoProcess(child);
    throw error;
  });

  return {
    url,
    client: sdk.createOpencodeClient({ baseUrl: url }),
    server: { url, close },
  };
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

function extractMimoErrorMessage(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  return String(error.data?.message || error.message || error.name || "");
}

// translateOpenCodeEvent() is shared with the OpenCode driver, so the
// status/error text it emits is OpenCode-branded. MiMo Code is a rebrand, so
// swap the brand at the emitter boundary instead of forking the translator.
// Only strings our own code generates are rewritten; model and tool output
// passes through untouched.
const MIMO_BRAND = "MiMo Code";
const OPENCODE_BRAND = "OpenCode";
// Fallback text translateOpenCodeEvent() uses when a tool part carries neither
// an error nor an output payload.
const OPENCODE_TOOL_FAILED = "OpenCode tool failed";

function createMiMoEmitter(emitter) {
  const rebrand = (text) => (typeof text === "string" ? text.replaceAll(OPENCODE_BRAND, MIMO_BRAND) : text);
  return {
    ...emitter,
    status: (message) => emitter.status(rebrand(message)),
    emitError: (error) => emitter.emitError(rebrand(error)),
    toolResult: (callId, output, toolName) => emitter.toolResult(
      callId,
      output === OPENCODE_TOOL_FAILED ? `${MIMO_BRAND} tool failed` : output,
      toolName,
    ),
  };
}

async function runMimoTurn({
  prompt, systemPrompt, attachments, cwd, model, injectedMcpServers, toolIntegrationMode,
  skillsPathAllowlist, resumeSessionId, env, binPath, emitter, abortController, mimoFactory,
}) {
  const emit = createMiMoEmitter(emitter);
  const config = buildOpenCodeConfig({ model, injectedMcpServers, toolIntegrationMode, skillsPathAllowlist });
  let instance = null;
  let sessionId = resumeSessionId || null;
  let hasContent = false;
  let failed = false;
  let abortSent = false;
  let removeAbortListener = null;
  const state = { reasoningOpen: false };
  const directoryQuery = cwd ? { directory: cwd } : undefined;

  try {
    const factory = mimoFactory || ((options) => spawnMimoServer({ ...options, cwd, env, binPath }));
    const port = await getAvailablePort();
    instance = await factory({
      config,
      port,
      signal: abortController?.signal,
    });
    const { client } = instance;
    const abortMimo = async () => {
      if (abortSent) return;
      abortSent = true;
      if (sessionId) {
        try { await client.session.abort({ path: { id: sessionId }, query: directoryQuery }); } catch {}
      }
      try { instance?.server?.close?.(); } catch {}
    };
    if (abortController?.signal) {
      const onAbort = () => { void abortMimo(); };
      abortController.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => abortController.signal.removeEventListener("abort", onAbort);
    }
    const events = await client.global.event({ signal: abortController?.signal });

    if (!sessionId) {
      const created = await client.session.create({
        body: { title: "Netcatty MiMo Code" },
        query: directoryQuery,
      });
      sessionId = created?.data?.id || created?.id || null;
    }
    if (!sessionId) throw new Error("MiMo Code did not create a session");
    emit.sessionId(sessionId);

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
          // The global event stream carries every session on this server.
          // Only translate our own, so another session's text or idle event
          // can neither leak into this reply nor end it early.
          const eventSessionId = getOpenCodeSessionIdFromEvent(event);
          if (eventSessionId && eventSessionId !== sessionId) continue;
          const result = translateOpenCodeEvent(event, emit, state);
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
          const error = result?.error || null;
          return error ? { type: "error", error } : { type: "prompt" };
        },
        (error) => ({ type: "error", error }),
      ),
      promptAbortWait.promise.then(() => ({ type: "abort" })),
    ]);
    promptAbortWait.dispose();
    if (promptResult.type === "error") {
      failed = true;
      await abortMimo();
      stopEventLoopWait.stop();
      await eventLoop.catch(() => {});
      throw promptResult.error;
    }

    if (promptResult.type === "abort") {
      await abortMimo();
    } else {
      await eventLoop;
    }

    if (abortController?.signal?.aborted) {
      await abortMimo();
    }

    if (!hasContent && !failed && !abortController?.signal?.aborted) {
      emit.emitError("MiMo Code returned an empty response. Run `mimo` in a terminal to configure authentication and models.");
      return { sessionId };
    }
    if (!failed && !abortController?.signal?.aborted) emit.emitDone();
    return { sessionId };
  } catch (error) {
    const classified = classifyOpenCodeSpawnError(error);
    if (classified.isSpawnEnoent) {
      emit.emitError("MiMo Code CLI not found or not runnable. Install MiMo Code and ensure `mimo` is on PATH, or set a custom path in Settings.");
    } else {
      emit.emitError(extractMimoErrorMessage(error) || classified.message || "MiMo Code turn failed");
    }
    return { sessionId };
  } finally {
    removeAbortListener?.();
    try { instance?.server?.close?.(); } catch {}
  }
}

function emptyMimoModelCatalog() {
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

/**
 * Read the provider catalog from a short-lived `mimo serve` instance.
 *
 * The OpenCode driver keeps a pooled server because catalog loads are frequent;
 * MiMo Code has no such traffic yet, so spawning per call keeps this simple.
 */
async function listMimoModels({ env, binPath, cwd, mimoFactory, abortController, signal } = {}) {
  const effectiveSignal = signal || abortController?.signal;
  if (effectiveSignal?.aborted) return emptyMimoModelCatalog();
  let instance = null;
  try {
    const factory = mimoFactory || ((options) => spawnMimoServer({ ...options, cwd, env, binPath }));
    const port = await getAvailablePort();
    instance = await factory({
      config: { autoupdate: false },
      port,
      signal: effectiveSignal,
    });
    const response = await Promise.race([
      instance.client.config.providers(),
      whenAborted(effectiveSignal),
    ]);
    if (response?.error) {
      throw new Error(extractMimoErrorMessage(response.error) || "MiMo Code providers unavailable");
    }
    const data = response?.data || response;
    return {
      currentModelId: getOpenCodeDefaultModelId(data),
      models: mapOpenCodeModels(data),
    };
  } catch {
    return emptyMimoModelCatalog();
  } finally {
    try { instance?.server?.close?.(); } catch {}
  }
}

module.exports = {
  listMimoModels,
  resolveUsableMimoBinPath,
  runMimoTurn,
  spawnMimoServer,
  stopMimoProcess,
  MIMO_SERVE_TIMEOUT_MS,
  MIMO_STOP_GRACE_MS,
};
