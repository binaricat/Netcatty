const assert = require("node:assert/strict");
const test = require("node:test");

const scriptBridge = require("./scriptBridge.cjs");

test("script run writes through terminal worker manager when enabled", async () => {
  const handlers = new Map();
  const workerSends = [];
  const terminalWrites = [];

  scriptBridge.init({
    sessions: new Map(),
    electronModule: {
      app: {
        getVersion: () => "test",
        getPath: () => process.cwd(),
      },
    },
    terminalBridge: {
      writeToSession(_event, payload) {
        terminalWrites.push(payload);
      },
    },
    terminalWorkerManager: {
      addOutputTap() {
        return () => {};
      },
      send(channel, payload, options) {
        workerSends.push({ channel, payload, options });
      },
    },
    getMainWindow: () => null,
  });
  scriptBridge.registerHandlers({
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  });

  await handlers.get("netcatty:script:run")({}, {
    scriptId: "script-1",
    scriptLabel: "Smoke",
    sessionId: "session-1",
    content: "await nct.screen.sendLine('echo hi');",
    permissionMode: "auto",
  });

  assert.deepEqual(terminalWrites, []);
  assert.equal(workerSends.length, 1);
  assert.equal(workerSends[0].channel, "netcatty:write");
  assert.deepEqual(workerSends[0].payload, {
    sessionId: "session-1",
    data: "echo hi\r",
    automated: true,
  });
});

test("script run completion stores actual executed step count", async () => {
  const handlers = new Map();
  const sentRunUpdates = [];

  scriptBridge.init({
    sessions: new Map(),
    electronModule: {
      app: {
        getVersion: () => "test",
        getPath: () => process.cwd(),
      },
    },
    terminalBridge: {
      writeToSession() {},
    },
    getMainWindow: () => ({
      webContents: {
        send(channel, payload) {
          if (channel === "netcatty:script:runs-updated") {
            sentRunUpdates.push(payload.runs);
          }
        },
      },
    }),
  });
  scriptBridge.registerHandlers({
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  });

  await handlers.get("netcatty:script:run")({}, {
    scriptId: "script-loop",
    scriptLabel: "Loop",
    sessionId: "session-1",
    content: "for (let i = 0; i < 3; i += 1) { nct.log(`step ${i}`); }",
    permissionMode: "auto",
  });

  const finalRun = sentRunUpdates.at(-1).find((run) => run.scriptId === "script-loop");
  assert.equal(finalRun.status, "completed");
  assert.equal(finalRun.stepIndex, 3);
  assert.equal(finalRun.progressMode, "activity");
  assert.equal(finalRun.totalSteps, undefined);
});

test("same session script runs are serialized through the session mutex", async () => {
  const handlers = new Map();
  const writeOrder = [];

  scriptBridge.init({
    sessions: new Map(),
    electronModule: {
      app: {
        getVersion: () => "test",
        getPath: () => process.cwd(),
      },
    },
    terminalBridge: {
      writeToSession(_event, payload) {
        const marker = String(payload.data || "").match(/slow-run|fast-run/);
        if (marker) writeOrder.push(marker[0]);
      },
    },
    terminalWorkerManager: null,
    getMainWindow: () => null,
  });
  scriptBridge.registerHandlers({
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  });

  const runHandler = handlers.get("netcatty:script:run");
  await Promise.all([
    runHandler({}, {
      scriptId: "slow",
      scriptLabel: "Slow",
      sessionId: "session-mutex",
      content: `
        await nct.sleep(40);
        await nct.screen.sendLine('slow-run');
      `,
      permissionMode: "auto",
    }),
    runHandler({}, {
      scriptId: "fast",
      scriptLabel: "Fast",
      sessionId: "session-mutex",
      content: "await nct.screen.sendLine('fast-run');",
      permissionMode: "auto",
    }),
  ]);

  assert.deepEqual(writeOrder, ["slow-run", "fast-run"]);
});

test("script run treats worker-managed sessions as connected", async () => {
  const handlers = new Map();
  const sentRunUpdates = [];

  scriptBridge.init({
    sessions: new Map(),
    electronModule: {
      app: {
        getVersion: () => "test",
        getPath: () => process.cwd(),
      },
    },
    terminalBridge: {
      writeToSession() {},
    },
    terminalWorkerManager: {
      hasOpenSession(sessionId) {
        return sessionId === "session-worker";
      },
      addOutputTap() {
        return () => {};
      },
      send() {},
    },
    getMainWindow: () => ({
      webContents: {
        send(channel, payload) {
          if (channel === "netcatty:script:runs-updated") {
            sentRunUpdates.push(payload.runs);
          }
        },
      },
    }),
  });
  scriptBridge.registerHandlers({
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  });

  await handlers.get("netcatty:script:run")({}, {
    scriptId: "connected-check",
    scriptLabel: "Connected check",
    sessionId: "session-worker",
    sessionMeta: { connected: true, hostname: "worker-host", username: "root" },
    content: `
      if (!nct.session.connected) {
        throw new Error("Session not connected");
      }
      nct.log("connected ok");
    `,
    permissionMode: "auto",
  });

  const finalRun = sentRunUpdates.at(-1).find((run) => run.scriptId === "connected-check");
  assert.equal(finalRun.status, "completed");
  assert.match(finalRun.logs.map((entry) => entry.message).join("\n"), /connected ok/);
});

test("script run uses renderer sessionMeta when main-process session map is empty", async () => {
  const handlers = new Map();
  const sentRunUpdates = [];

  scriptBridge.init({
    sessions: new Map(),
    electronModule: {
      app: {
        getVersion: () => "test",
        getPath: () => process.cwd(),
      },
    },
    terminalBridge: {
      writeToSession() {},
    },
    terminalWorkerManager: null,
    getMainWindow: () => ({
      webContents: {
        send(channel, payload) {
          if (channel === "netcatty:script:runs-updated") {
            sentRunUpdates.push(payload.runs);
          }
        },
      },
    }),
  });
  scriptBridge.registerHandlers({
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  });

  await handlers.get("netcatty:script:run")({}, {
    scriptId: "renderer-meta",
    scriptLabel: "Renderer meta",
    sessionId: "session-renderer",
    sessionMeta: { connected: true, hostname: "10.0.0.1", username: "root" },
    content: `
      if (!nct.session.connected) {
        throw new Error("Session not connected");
      }
      nct.log(\`\${nct.session.hostname}@\${nct.session.username}\`);
    `,
    permissionMode: "auto",
  });

  const finalRun = sentRunUpdates.at(-1).find((run) => run.scriptId === "renderer-meta");
  assert.equal(finalRun.status, "completed");
  assert.match(finalRun.logs.map((entry) => entry.message).join("\n"), /10\.0\.0\.1@root/);
});
