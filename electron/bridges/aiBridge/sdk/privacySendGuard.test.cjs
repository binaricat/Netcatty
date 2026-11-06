"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAiPrivacyService } = require("../../../shared/aiPrivacyService.cjs");
// Load the query-only Claude fixture with config repair replaced. Its live
// prompt guard tests must never read or repair the executor's actual profile.
const configPath = require.resolve("./claudeConfig.cjs");
const priorConfigModule = require.cache[configPath];
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: { ensureClaudeConfig() {} } };
const claudeDriver = require("./claudeDriver.cjs");
if (priorConfigModule) require.cache[configPath] = priorConfigModule;
else delete require.cache[configPath];

function fixture() {
  const privacy = createAiPrivacyService();
  privacy.checkSession("chat");
  const errors = [];
  const sends = [];
  const emitter = new Proxy({ sessionId() {}, emitError: (error) => errors.push(error) }, {
    get: (target, key) => target[key] || (() => {}),
  });
  return {
    privacy, errors, sends, emitter,
    assertSessionValid: () => privacy.checkSession("chat"),
    enable: () => privacy.configure({ enabled: true }),
    assertBlocked() {
      assert.deepEqual(sends, []);
      assert.match(errors.join("\n"), /start a new chat/);
    },
  };
}

function gate() {
  let entered;
  let release;
  const ready = new Promise((resolve) => { entered = resolve; });
  const waiting = new Promise((resolve) => { release = resolve; });
  return { ready, release, async wait() { entered(); await waiting; } };
}

async function toggleDuringStartup(f, pause, run) {
  await pause.ready;
  f.enable();
  pause.release();
  await run;
  f.assertBlocked();
}

test("Codex SDK rechecks after runStreamed before starting its lazy outbound iterator", async () => {
  const { runCodexTurn } = require("./codexDriver.cjs");
  const f = fixture();
  const pause = gate();
  class Codex {
    startThread() {
      return {
        async runStreamed(prompt) {
          await pause.wait();
          return { events: (async function* () { f.sends.push(prompt); yield {}; })() };
        },
      };
    }
  }
  await toggleDuringStartup(f, pause, runCodexTurn({
    ...f, prompt: "raw-secret", CodexCtor: Codex,
  }));
});

test("Copilot rechecks after paused session startup before sendAndWait", async () => {
  const { runCopilotTurn } = require("./copilotDriver.cjs");
  const f = fixture();
  const pause = gate();
  class CopilotClient {
    async createSession() {
      await pause.wait();
      return { sessionId: "native", sendAndWait: (input) => { f.sends.push(input); } };
    }
    async stop() {}
  }
  await toggleDuringStartup(f, pause, runCopilotTurn({
    ...f, prompt: "raw-secret", sdkModule: { CopilotClient },
  }));
});

test("Cursor rechecks inside the environment lock after paused Agent.create", async () => {
  const { runCursorTurnInProcess } = require("./cursorDriver.cjs");
  const f = fixture();
  const pause = gate();
  const Agent = {
    async create() {
      await pause.wait();
      return { agentId: "native", send: (input) => { f.sends.push(input); }, close() {} };
    },
  };
  await toggleDuringStartup(f, pause, runCursorTurnInProcess({
    ...f, prompt: "raw-secret", sdkModule: { Agent }, agentOptions: {},
  }));
});

test("CodeBuddy validates prompt-bearing session options after asynchronous SDK loading", async () => {
  const { CodebuddySessionManager } = require("./codebuddySessionManager.cjs");
  const f = fixture();
  const pause = gate();
  const manager = new CodebuddySessionManager({
    loadSdk: async () => {
      await pause.wait();
      return {
        unstable_v2_createSession: (input) => { f.sends.push(input); },
        unstable_v2_resumeSession() {},
      };
    },
  });
  const run = manager.runTurn({ ...f, sessionKey: "chat", prompt: "raw-secret", options: {}, sessionOptions: { systemPrompt: "raw-secret" } });
  const rejected = assert.rejects(run, /start a new chat/);
  await pause.ready;
  f.enable();
  pause.release();
  await rejected;
  assert.deepEqual(f.sends, []);
});

test("CodeBuddy rechecks before sending into a session obtained asynchronously", async () => {
  const { CodebuddySessionManager } = require("./codebuddySessionManager.cjs");
  const f = fixture();
  const pause = gate();
  const manager = new CodebuddySessionManager();
  manager.getOrCreateSession = async () => {
    await pause.wait();
    return { sessionId: "native", send: (input) => { f.sends.push(input); } };
  };
  await toggleDuringStartup(f, pause, manager.runTurn({
    ...f, sessionKey: "chat", prompt: "raw-secret", options: {}, sessionOptions: {},
  }));
});

for (const backend of ["opencode", "mimo"]) {
  test(`${backend} rechecks after paused session creation before promptAsync`, async () => {
    const runTurn = backend === "opencode"
      ? require("./opencodeDriver.cjs").runOpenCodeTurn
      : require("./mimoDriver.cjs").runMimoTurn;
    const f = fixture();
    const pause = gate();
    let closed = false;
    const factory = async () => ({
      client: {
        global: { event: async () => ({ stream: (async function* () { yield { type: "server.connected" }; })() }) },
        session: {
          create: async () => { await pause.wait(); return { id: "native" }; },
          promptAsync: (input) => { f.sends.push(input); return Promise.resolve({}); },
        },
      },
      server: { close() { closed = true; } },
    });
    await toggleDuringStartup(f, pause, runTurn({
      ...f, prompt: "raw-secret", systemPrompt: "raw-system",
      [backend === "opencode" ? "openCodeFactory" : "mimoFactory"]: factory,
    }));
    assert.equal(closed, true);
  });
}

for (const pausedMethod of ["initialize", "session/new"]) {
  test(`Grok ACP validates after paused ${pausedMethod} before releasing semantic content`, async () => {
    const { runGrokAcpTurn } = require("./grokAcpDriver.cjs");
    const f = fixture();
    const pause = gate();
    const run = runGrokAcpTurn({
      ...f, prompt: "raw-secret", systemPrompt: "raw-system", binPath: "/bin/grok",
      rpcClientFactory: () => ({
        async request(method, params) {
          if (method === pausedMethod) await pause.wait();
          else if (method === "session/new" || method === "session/prompt") f.sends.push({ method, params });
          return method === "initialize" ? {} : { sessionId: "native" };
        },
      }),
    });
    await toggleDuringStartup(f, pause, run);
  });
}

test("query and argv drivers reject invalid sessions at their outbound handoff", async (t) => {
  const cases = [
    ["claude", (f) => claudeDriver.runClaudeTurn({ ...f, options: {}, queryFn: (input) => { f.sends.push(input); } })],
    ["codebuddy", (f) => require("./codebuddyDriver.cjs").runCodebuddyTurn({ ...f, options: {}, queryFn: (input) => { f.sends.push(input); } })],
    ["cursor-cli", (f) => require("./cursorCliDriver.cjs").runCursorCliTurn({ ...f, binPath: "/bin/cursor", workspaceCwd: "/tmp", spawnImpl: (...input) => { f.sends.push(input); } })],
    ["grok-cli", (f) => require("./grokDriver.cjs").runGrokTurn({ ...f, binPath: "/bin/grok", spawnImpl: (...input) => { f.sends.push(input); } })],
  ];
  for (const [backend, run] of cases) {
    await t.test(backend, async () => {
      const f = fixture();
      f.enable();
      await run({ ...f, prompt: "raw-secret" });
      f.assertBlocked();
    });
  }
});
