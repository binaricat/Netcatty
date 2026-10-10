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
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { prepareCommandForSpawn, resolveCliFromPath } = require("../../ai/shellUtils.cjs");
const { buildSdkAgentEnv } = require("./env.cjs");
const { filterMimoTrustedSkillPaths } = require("./netcattySkillsOpenCodePermissions.cjs");
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
const stoppingMimoChildren = new WeakSet();

function killProcessGroup(pid, signal) {
  process.kill(-pid, signal);
}

function isProcessGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function stopMimoProcess(child, {
  platform = process.platform,
  killGroup = killProcessGroup,
  groupAlive = isProcessGroupAlive,
  graceMs = MIMO_STOP_GRACE_MS,
  pollMs = 100,
} = {}) {
  if (!child || stoppingMimoChildren.has(child)) return;
  const launcherExited = child.exitCode !== null || child.signalCode !== null;
  // The npm launcher may exit while its native server still owns the group.
  if (launcherExited && (platform === "win32" || !child.pid || !groupAlive(child.pid))) return;
  // `mimo` is launched through cmd.exe when the resolved path is the npm .cmd
  // shim, so killing the direct child can orphan the real server. Kill the
  // whole tree instead (same approach the SDK's own stop() uses).
  if (platform === "win32" && child.pid) {
    const out = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    if (!out.error && out.status === 0) {
      stoppingMimoChildren.add(child);
      return;
    }
  }
  // On macOS/Linux the official npm package's `mimo` is a Node shim that runs
  // the native binary through spawnSync, so signalling only the shim leaves
  // the server listening. spawnMimoServer starts it detached, making the pid
  // the leader of its own process group: signal the whole group, then kill
  // whatever ignored SIGTERM once the grace period is over.
  if (platform !== "win32" && child.pid) {
    try {
      killGroup(child.pid, "SIGTERM");
      stoppingMimoChildren.add(child);
      const timer = setTimeout(() => {
        clearInterval(poll);
        if (!groupAlive(child.pid)) return;
        try { killGroup(child.pid, "SIGKILL"); } catch {}
      }, graceMs);
      // The npm shim can exit before its native server. Watch the process
      // group rather than the shim, and cancel escalation once the group is gone.
      const poll = setInterval(() => {
        if (groupAlive(child.pid)) return;
        clearTimeout(timer);
        clearInterval(poll);
      }, Math.max(1, Math.min(pollMs, graceMs)));
      timer.unref?.();
      poll.unref?.();
      return;
    } catch {}
  }
  if (launcherExited) return;
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

// Ask the same CLI that starts the server to resolve its configuration. This
// finishes before `serve`, so project skill roots can be checked and passed to
// the first server instead of starting a second server for every turn.
async function readMimoResolvedConfig({ cwd, env, binPath, signal }) {
  const resolved = resolveUsableMimoBinPath(binPath, env) || resolveCliFromPath("mimo", env);
  const spawnSpec = prepareCommandForSpawn(resolved || "mimo", ["debug", "config"], { unwrapNativeExe: false });
  const childEnv = buildSdkAgentEnv({ shellEnv: env || process.env });
  delete childEnv.MIMOCODE_CONFIG_CONTENT;
  delete childEnv.MIMOCODE_PERMISSION;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd,
      env: childEnv,
      shell: spawnSpec.shell,
      stdio: ["ignore", "pipe", "ignore"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let output = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => {
      stopMimoProcess(child);
      finish(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    const timer = setTimeout(() => {
      stopMimoProcess(child);
      finish(new Error("MiMo Code configuration timed out"));
    }, MIMO_SERVE_TIMEOUT_MS);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
      if (output.length > 2 * 1024 * 1024) {
        stopMimoProcess(child);
        finish(new Error("MiMo Code configuration is too large"));
      }
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) {
        finish(new Error(`MiMo Code configuration command exited with code ${code}`));
        return;
      }
      try { finish(null, JSON.parse(output)); }
      catch { finish(new Error("MiMo Code configuration is invalid")); }
    });
  });
}

async function readMimoSkillPaths({ cwd, env, binPath, signal }) {
  const projectConfig = await readMimoResolvedConfig({ cwd: cwd || process.cwd(), env, binPath, signal });
  const skillPaths = projectConfig?.skills?.paths;
  if (!Array.isArray(skillPaths) || skillPaths.length === 0) return { project: skillPaths || [], global: [] };
  if (filterMimoTrustedSkillPaths(skillPaths, { cwd, env: { ...process.env, ...env } }).length === skillPaths.length) {
    return { project: skillPaths, global: [] };
  }
  const globalConfig = await readMimoResolvedConfig({
    // MiMo rejects a filesystem root as a project directory. The installed
    // application's executable directory is outside the user's project and
    // exists on every supported platform.
    cwd: path.dirname(process.execPath),
    env, binPath, signal,
  });
  return { project: skillPaths, global: globalConfig?.skills?.paths };
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
  const serverUsername = "netcatty";
  const serverPassword = randomBytes(32).toString("base64url");

  // The mimo binary reads its config from MIMOCODE_CONFIG_CONTENT (verified in
  // the 0.1.15 binary); OPENCODE_CONFIG_CONTENT is ignored.
  const childEnv = {
    ...buildSdkAgentEnv({ shellEnv: env || process.env }),
    MIMOCODE_CONFIG_CONTENT: JSON.stringify(config ?? {}),
    MIMOCODE_SERVER_USERNAME: serverUsername,
    MIMOCODE_SERVER_PASSWORD: serverPassword,
  };
  // MiMo merges this env override after the config we supply. Never let an
  // inherited permission policy undo Netcatty's observer/confirm restrictions.
  delete childEnv.MIMOCODE_PERMISSION;

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
    let pendingLine = "";
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
      if (settled) return;
      const text = chunk.toString();
      // Keep just the tail for diagnostics and the unfinished line for the
      // readiness banner; neither grows with a noisy long-running server.
      output = (output + text).slice(-64 * 1024);
      const candidate = pendingLine + text;
      const lastNewline = candidate.lastIndexOf("\n");
      if (lastNewline < 0) {
        pendingLine = candidate.slice(-8 * 1024);
        return;
      }
      const match = candidate.slice(0, lastNewline + 1).match(MIMO_LISTENING_RE);
      if (match) {
        finish(resolve, match[1]);
        return;
      }
      pendingLine = candidate.slice(lastNewline + 1).slice(-8 * 1024);
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

  const exited = new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", resolve);
    child.once("error", resolve);
  });
  const authorization = `Basic ${Buffer.from(`${serverUsername}:${serverPassword}`).toString("base64")}`;
  return {
    url,
    client: sdk.createOpencodeClient({
      baseUrl: url,
      headers: {
        Authorization: authorization,
      },
    }),
    server: {
      url, close, exited,
      async replyPermission(eventType, request, approved, signal) {
        const legacy = eventType === "permission.updated";
        const route = legacy
          ? `/session/${encodeURIComponent(request.sessionID)}/permissions/${encodeURIComponent(request.id)}`
          : `/permission/${encodeURIComponent(request.id)}/reply`;
        const response = await fetch(`${url}${route}`, {
          method: "POST",
          headers: { Authorization: authorization, "Content-Type": "application/json" },
          body: JSON.stringify(legacy
            ? { response: approved ? "once" : "reject" }
            : { reply: approved ? "once" : "reject" }),
          signal,
        });
        if (!response.ok) throw new Error(`MiMo Code permission reply failed (${response.status})`);
      },
      async getGlobalConfig(signal) {
        const response = await fetch(`${url}/global/config`, { headers: { Authorization: authorization }, signal });
        if (!response.ok) throw new Error(`MiMo Code global configuration unavailable (${response.status})`);
        return response.json();
      },
    },
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

function createMimoExitWait(server) {
  return server?.exited
    ? server.exited.then(() => ({ type: "exit" }))
    : new Promise(() => {});
}

async function awaitMimoSetup(promise, signal, server, timeoutMs = 10_000) {
  const abortWait = createAbortWait(signal);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("MiMo Code service did not respond in time")), timeoutMs);
    timer.unref?.();
  });
  try {
    const result = await Promise.race([
      promise.then((value) => ({ type: "value", value })),
      abortWait.promise.then(() => ({ type: "abort" })),
      createMimoExitWait(server),
      timeout,
    ]);
    if (result.type === "exit") throw new Error("MiMo Code service exited unexpectedly");
    return result.type === "abort" ? null : result.value;
  } finally {
    clearTimeout(timer);
    abortWait.dispose();
  }
}

function closeMimoEventIterator(iterator) {
  try { void Promise.resolve(iterator?.return?.()).catch(() => {}); } catch {}
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
  skillsPathAllowlist, permissionMode = "confirm", chatSessionId, requestApprovalFromRenderer, clearPendingApprovals,
  resumeSessionId, env, binPath, emitter, abortController, mimoFactory, mimoConfigReader,
}) {
  const emit = createMiMoEmitter(emitter);
  const nativeSkillOptions = { mimo: true, env: { ...process.env, ...env }, cwd };
  let instance = null;
  let iterator = null;
  let sessionId = resumeSessionId || null;
  let hasContent = false;
  let failed = false;
  let completed = false;
  let turnStarted = false;
  let abortSent = false;
  let removeAbortListener = null;
  let pendingNativeApproval = false;
  const state = { reasoningOpen: false };
  const directoryQuery = cwd ? { directory: cwd } : undefined;

  try {
    const factory = mimoFactory || ((options) => spawnMimoServer({ ...options, cwd, env, binPath }));
    const configReader = mimoConfigReader || (mimoFactory
      ? async () => ({ project: [], global: [] })
      : () => readMimoSkillPaths({ cwd, env, binPath, signal: abortController?.signal }));
    const skillPaths = await configReader();
    if (abortController?.signal?.aborted) return { sessionId };
    const trustedPaths = filterMimoTrustedSkillPaths(skillPaths.project, {
      cwd, env: nativeSkillOptions.env, globalSkillPaths: skillPaths.global,
    });
    const config = buildOpenCodeConfig({
      model, injectedMcpServers, toolIntegrationMode, skillsPathAllowlist,
      nativeSkillOptions: { ...nativeSkillOptions, skillPaths: trustedPaths },
    });
    // The shared OpenCode builder permits bash in Skills mode. MiMo runs that
    // command directly, so the selected Netcatty mode must gate it here.
    if (toolIntegrationMode === "skills") {
      config.permission.bash = permissionMode === "auto" ? "allow"
        : permissionMode === "observer" ? "deny" : "ask";
    }
    if (skillPaths.project.length > 0) {
      // The skill loader reads SKILL.md before tool permissions apply. Limit
      // discovery at startup, including when every custom path was rejected.
      config.skills = { paths: trustedPaths };
    }
    instance = await factory({ config, port: await getAvailablePort(), signal: abortController?.signal });
    const { client } = instance;
    const abortMimo = async () => {
      if (abortSent) return;
      abortSent = true;
      if (sessionId) {
        try {
          void Promise.resolve(client.session.abort({ path: { id: sessionId }, query: directoryQuery })).catch(() => {});
        } catch {}
      }
      try { instance?.server?.close?.(); } catch {}
    };
    if (abortController?.signal) {
      const onAbort = () => { void abortMimo(); };
      abortController.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => abortController.signal.removeEventListener("abort", onAbort);
    }
    if (abortController?.signal?.aborted) {
      await abortMimo();
      return { sessionId };
    }
    const events = await awaitMimoSetup(client.global.event({ signal: abortController?.signal }), abortController?.signal, instance.server);
    if (abortController?.signal?.aborted) return { sessionId };
    iterator = events?.stream?.[Symbol.asyncIterator]?.();
    if (!iterator) throw new Error("MiMo Code did not provide an event stream");
    // The SDK stream is lazy: its first read opens the SSE connection. Wait
    // for that first event before sending a prompt, or a fast reply can be
    // missed entirely. Keep the event to process after session creation.
    const firstEvent = await awaitMimoSetup(iterator.next(), abortController?.signal, instance.server);
    if (abortController?.signal?.aborted) {
      return { sessionId };
    }
    if (!firstEvent || firstEvent.done) throw new Error("MiMo Code event stream closed before the session started");

    if (!sessionId) {
      const created = await awaitMimoSetup(client.session.create({
        body: { title: "Netcatty MiMo Code" },
        query: directoryQuery,
      }), abortController?.signal, instance.server);
      if (abortController?.signal?.aborted) {
        return { sessionId };
      }
      sessionId = created?.data?.id || created?.id || null;
    }
    if (abortController?.signal?.aborted) return { sessionId };
    if (!sessionId) throw new Error("MiMo Code did not create a session");
    emit.sessionId(sessionId);

    const stopEventLoopWait = createStopWait();
    const serverExitWait = createMimoExitWait(instance.server);
    const answeredPermissions = new Set();
    const eventLoop = (async () => {
      const abortWait = createAbortWait(abortController?.signal);
      try {
        let nextEvent = Promise.resolve(firstEvent);
        while (true) {
          const raced = await Promise.race([
            nextEvent.then(
              (value) => ({ type: "event", value }),
              (error) => ({ type: "error", error }),
            ),
            abortWait.promise.then(() => ({ type: "abort" })),
            stopEventLoopWait.promise.then(() => ({ type: "stop" })),
            serverExitWait,
          ]);
          if (raced.type === "abort") break;
          if (raced.type === "stop") break;
          if (raced.type === "exit") throw new Error("MiMo Code service exited unexpectedly");
          if (raced.type === "error") throw raced.error;
          const { value: event, done } = raced.value;
          if (done) break;
          if (abortController?.signal?.aborted) break;
          // The global event stream carries every session on this server.
          // Only translate our own, so another session's text or idle event
          // can neither leak into this reply nor end it early.
          const eventSessionId = getOpenCodeSessionIdFromEvent(event);
          if (eventSessionId && eventSessionId !== sessionId) {
            nextEvent = iterator.next();
            continue;
          }
          const payload = event?.payload || event;
          if (payload?.type === "permission.updated" || payload?.type === "permission.asked") {
            const request = payload.properties;
            if (!request?.id || !instance.server?.replyPermission) {
              throw new Error("MiMo Code permission request could not be answered");
            }
            if (answeredPermissions.has(request.id)) {
              nextEvent = iterator.next();
              continue;
            }
            answeredPermissions.add(request.id);
            pendingNativeApproval = true;
            const approval = permissionMode === "confirm" && typeof requestApprovalFromRenderer === "function"
              ? Promise.resolve().then(() => requestApprovalFromRenderer("MiMo Code permission", {
                permission: request.permission || request.type,
                patterns: request.patterns || request.pattern,
                title: request.title,
                metadata: request.metadata,
              }, chatSessionId)).then(Boolean, () => false)
              : Promise.resolve(false);
            const decision = await Promise.race([
              approval.then((approved) => ({ type: "decision", approved })),
              abortWait.promise.then(() => ({ type: "abort" })),
              serverExitWait,
            ]);
            if (decision.type === "abort") break;
            if (decision.type === "exit") throw new Error("MiMo Code service exited during approval");
            pendingNativeApproval = false;
            await Promise.race([
              instance.server.replyPermission(payload.type, request, decision.approved, abortController?.signal),
              abortWait.promise.then(() => ({ type: "abort" })),
              serverExitWait,
            ]);
            if (abortController?.signal?.aborted) break;
            nextEvent = iterator.next();
            continue;
          }
          // A resumed session can announce the previous turn's idle state
          // before this prompt produces any event. Wait for this turn's busy
          // state or content before accepting an idle as completion.
          if (payload?.type === "session.idle" && !turnStarted) {
            nextEvent = iterator.next();
            continue;
          }
          if (payload?.type === "session.status" && payload.properties?.status?.type === "busy") {
            turnStarted = true;
          }
          const result = translateOpenCodeEvent(event, emit, state);
          if (result.content) {
            hasContent = true;
            turnStarted = true;
          }
          if (result.error) {
            failed = true;
            break;
          }
          if (result.idle) {
            completed = true;
            break;
          }
          nextEvent = iterator.next();
        }
      } finally {
        abortWait.dispose();
      }
    })();
    const eventLoopOutcome = eventLoop.then(
      () => ({ type: "stream-end" }),
      (error) => ({ type: "error", error }),
    );

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
      serverExitWait,
      eventLoopOutcome,
    ]);
    promptAbortWait.dispose();
    if (promptResult.type === "exit") {
      failed = true;
      stopEventLoopWait.stop();
      await eventLoop.catch(() => {});
      throw new Error("MiMo Code service exited unexpectedly");
    }
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

    if (!completed && !failed && !abortController?.signal?.aborted && hasContent) {
      emit.emitError("MiMo Code reply ended before it was complete.");
      return { sessionId };
    }
    if (!hasContent && !failed && !abortController?.signal?.aborted) {
      emit.emitError("MiMo Code returned an empty response. Run `mimo` in a terminal to configure authentication and models.");
      return { sessionId };
    }
    if (!failed && completed && !abortController?.signal?.aborted) emit.emitDone();
    return { sessionId };
  } catch (error) {
    if (abortController?.signal?.aborted) return { sessionId };
    const classified = classifyOpenCodeSpawnError(error);
    if (classified.isSpawnEnoent) {
      emit.emitError("MiMo Code CLI not found or not runnable. Install MiMo Code and ensure `mimo` is on PATH, or set a custom path in Settings.");
    } else {
      emit.emitError(extractMimoErrorMessage(error) || classified.message || "MiMo Code turn failed");
    }
    return { sessionId };
  } finally {
    if (pendingNativeApproval && chatSessionId) {
      try { clearPendingApprovals?.(chatSessionId); } catch {}
    }
    removeAbortListener?.();
    closeMimoEventIterator(iterator);
    try { instance?.server?.close?.(); } catch {}
  }
}

function emptyMimoModelCatalog() {
  return { currentModelId: null, models: [] };
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
    // Deliberately skip readMimoSkillPaths(): it spawns `mimo debug config`
    // (seconds on a cold CLI) only to seed the server's skills config, which
    // the provider catalog never reads. Keeping the chain to serve + providers
    // is what lets the catalog fit its timeout budget at all.
    const port = await getAvailablePort();
    instance = await factory({
      config: { autoupdate: false },
      port,
      signal: effectiveSignal,
    });
    const response = await awaitMimoSetup(instance.client.config.providers(), effectiveSignal, instance.server);
    if (effectiveSignal?.aborted) return emptyMimoModelCatalog();
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
  readMimoSkillPaths,
  resolveUsableMimoBinPath,
  runMimoTurn,
  spawnMimoServer,
  stopMimoProcess,
  MIMO_SERVE_TIMEOUT_MS,
  MIMO_STOP_GRACE_MS,
};
