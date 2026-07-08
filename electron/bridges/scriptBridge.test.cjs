const assert = require("node:assert/strict");
const test = require("node:test");

const scriptBridge = require("./scriptBridge.cjs");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

test("script run sends form dialog requests and resolves object responses", async () => {
  const handlers = new Map();
  const sentRunUpdates = [];
  let dialogRequest;
  const sessionId = "session-form-dialog";

  scriptBridge.removeSessionBuffer(sessionId);
  scriptBridge.init({
    sessions: new Map(),
    electronModule: {
      app: {
        getVersion: () => "test",
        getPath: () => process.cwd(),
      },
      webContents: {
        fromId: () => null,
      },
    },
    terminalBridge: {
      writeToSession() {},
    },
    terminalWorkerManager: null,
    getMainWindow: () => ({
      webContents: {
        id: 1,
        send(channel, payload) {
          if (channel === "netcatty:script:runs-updated") {
            sentRunUpdates.push(payload.runs);
          }
          if (channel === "netcatty:script:screen-snapshot-request") {
            setImmediate(() => {
              handlers.get("netcatty:script:screen-snapshot-response")({}, {
                requestId: payload.requestId,
                snapshot: {
                  rows: 24,
                  cols: 80,
                  currentRow: 0,
                  lines: ["user@host:~$ "],
                },
              });
            });
          }
          if (channel === "netcatty:script:dialog-request") {
            dialogRequest = payload;
            setImmediate(() => {
              handlers.get("netcatty:script:dialog-response")({}, {
                requestId: payload.requestId,
                value: { env: "prod", restart: true, mode: "safe" },
              });
            });
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
    scriptId: "form-dialog",
    scriptLabel: "Form dialog",
    sessionId,
    content: `
      const values = await nct.dialog.form({
        title: 'Deploy',
        message: 'Choose options',
        fields: [
          { type: 'select', name: 'env', label: 'Environment', options: ['dev', 'prod'], defaultValue: 'dev' },
          { type: 'checkbox', name: 'restart', label: 'Restart', defaultValue: false },
          { type: 'radio', name: 'mode', label: 'Mode', options: ['safe', 'fast'], defaultValue: 'fast' },
        ],
      });
      nct.log(values.env + ':' + values.restart + ':' + values.mode);
    `,
    permissionMode: "auto",
  });

  assert.equal(dialogRequest.type, "form");
  assert.equal(dialogRequest.message, "Choose options");
  assert.equal(dialogRequest.form.title, "Deploy");
  assert.deepEqual(
    JSON.parse(JSON.stringify(dialogRequest.form.fields.map((field) => [field.type, field.name, field.defaultValue]))),
    [
      ["select", "env", "dev"],
      ["checkbox", "restart", false],
      ["radio", "mode", "fast"],
    ],
  );

  const finalRun = sentRunUpdates.at(-1).find((run) => run.scriptId === "form-dialog");
  assert.equal(finalRun.status, "completed");
  assert.match(finalRun.logs.map((entry) => entry.message).join("\n"), /prod:true:safe/);
  scriptBridge.removeSessionBuffer(sessionId);
});

test("script run treats cancelled form dialogs as script failures", async () => {
  const handlers = new Map();
  const sentRunUpdates = [];
  const sessionId = "session-form-cancel";

  scriptBridge.removeSessionBuffer(sessionId);
  scriptBridge.init({
    sessions: new Map(),
    electronModule: {
      app: {
        getVersion: () => "test",
        getPath: () => process.cwd(),
      },
      webContents: {
        fromId: () => null,
      },
    },
    terminalBridge: {
      writeToSession() {},
    },
    terminalWorkerManager: null,
    getMainWindow: () => ({
      webContents: {
        id: 1,
        send(channel, payload) {
          if (channel === "netcatty:script:runs-updated") {
            sentRunUpdates.push(payload.runs);
          }
          if (channel === "netcatty:script:screen-snapshot-request") {
            setImmediate(() => {
              handlers.get("netcatty:script:screen-snapshot-response")({}, {
                requestId: payload.requestId,
                snapshot: {
                  rows: 24,
                  cols: 80,
                  currentRow: 0,
                  lines: ["user@host:~$ "],
                },
              });
            });
          }
          if (channel === "netcatty:script:dialog-request") {
            setImmediate(() => {
              handlers.get("netcatty:script:dialog-response")({}, {
                requestId: payload.requestId,
                cancelled: true,
              });
            });
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
    scriptId: "form-cancel",
    scriptLabel: "Form cancel",
    sessionId,
    content: `
      await nct.dialog.form({
        message: 'Choose options',
        fields: [{ type: 'checkbox', name: 'restart', label: 'Restart' }],
      });
    `,
    permissionMode: "auto",
  });

  const finalRun = sentRunUpdates.at(-1).find((run) => run.scriptId === "form-cancel");
  assert.equal(finalRun.status, "failed");
  assert.equal(finalRun.error, "Dialog cancelled");
  scriptBridge.removeSessionBuffer(sessionId);
});

test("script waitFor matches text already visible on the startup screen", async () => {
  const handlers = new Map();
  const sentRunUpdates = [];
  const sessionId = "session-visible-startup-output";

  scriptBridge.removeSessionBuffer(sessionId);
  // Prior scrollback that has left the viewport must not rematch.
  scriptBridge.appendSessionOutput(sessionId, "scrolled-off READY marker\n");
  scriptBridge.init({
    sessions: new Map(),
    electronModule: {
      app: {
        getVersion: () => "test",
        getPath: () => process.cwd(),
      },
      webContents: {
        fromId: () => null,
      },
    },
    terminalBridge: {
      writeToSession() {},
    },
    terminalWorkerManager: null,
    getMainWindow: () => ({
      webContents: {
        id: 1,
        send(channel, payload) {
          if (channel === "netcatty:script:runs-updated") {
            sentRunUpdates.push(payload.runs);
          }
          if (channel === "netcatty:script:screen-snapshot-request") {
            setImmediate(() => {
              handlers.get("netcatty:script:screen-snapshot-response")({}, {
                requestId: payload.requestId,
                snapshot: {
                  rows: 24,
                  cols: 80,
                  currentRow: 1,
                  lines: [
                    "visible READY marker",
                    "user@host:~$ ",
                  ],
                },
              });
            });
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
    scriptId: "visible-output",
    scriptLabel: "Visible output",
    sessionId,
    content: `
      const value = await nct.screen.waitFor('READY', 1000);
      nct.log('matched ' + value);
    `,
    permissionMode: "auto",
  });

  const finalRun = sentRunUpdates.at(-1).find((run) => run.scriptId === "visible-output");
  assert.equal(finalRun.status, "completed");
  assert.match(finalRun.logs.map((entry) => entry.message).join("\n"), /matched READY/);
  scriptBridge.removeSessionBuffer(sessionId);
});

test("script waitFor ignores keywords that have scrolled off the visible screen", async () => {
  const handlers = new Map();
  const sentRunUpdates = [];
  const sessionId = "session-scrolled-off-startup-output";

  scriptBridge.removeSessionBuffer(sessionId);
  scriptBridge.appendSessionOutput(sessionId, "old deployment READY marker\nuser@host:~$ \n");
  scriptBridge.init({
    sessions: new Map(),
    electronModule: {
      app: {
        getVersion: () => "test",
        getPath: () => process.cwd(),
      },
      webContents: {
        fromId: () => null,
      },
    },
    terminalBridge: {
      writeToSession() {},
    },
    terminalWorkerManager: null,
    getMainWindow: () => ({
      webContents: {
        id: 1,
        send(channel, payload) {
          if (channel === "netcatty:script:runs-updated") {
            sentRunUpdates.push(payload.runs);
          }
          if (channel === "netcatty:script:screen-snapshot-request") {
            setImmediate(() => {
              handlers.get("netcatty:script:screen-snapshot-response")({}, {
                requestId: payload.requestId,
                snapshot: {
                  rows: 24,
                  cols: 80,
                  currentRow: 0,
                  lines: ["user@host:~$ "],
                },
              });
            });
          }
          if (channel === "netcatty:script:dialog-request") {
            setImmediate(() => {
              handlers.get("netcatty:script:dialog-response")({}, {
                requestId: payload.requestId,
                value: "abort",
              });
            });
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
    scriptId: "scrolled-off-output",
    scriptLabel: "Scrolled off output",
    sessionId,
    content: `
      await nct.screen.waitFor('READY', 200);
    `,
    permissionMode: "auto",
  });

  const finalRun = sentRunUpdates.at(-1).find((run) => run.scriptId === "scrolled-off-output");
  assert.equal(finalRun.status, "failed");
  assert.match(String(finalRun.error || ""), /timed out|stopped/i);
  scriptBridge.removeSessionBuffer(sessionId);
});

test("script waitFor does not seed buffer-fallback scrollback as visible screen", async () => {
  const handlers = new Map();
  const sentRunUpdates = [];
  const sessionId = "session-buffer-fallback-scrollback";

  scriptBridge.removeSessionBuffer(sessionId);
  // When the session's webContents is missing, requestScreenSnapshot falls back
  // to the full script buffer. That must stay consumed so scrolled-off keywords
  // do not rematch (#1821 / Codex review on #2035).
  scriptBridge.appendSessionOutput(sessionId, "old deployment READY marker\nuser@host:~$ \n");
  scriptBridge.init({
    sessions: new Map([
      [sessionId, { webContentsId: 999 }],
    ]),
    electronModule: {
      app: {
        getVersion: () => "test",
        getPath: () => process.cwd(),
      },
      webContents: {
        fromId: () => null,
      },
    },
    terminalBridge: {
      writeToSession() {},
    },
    terminalWorkerManager: null,
    getMainWindow: () => ({
      webContents: {
        id: 1,
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

  const runPromise = handlers.get("netcatty:script:run")({}, {
    scriptId: "buffer-fallback",
    scriptLabel: "Buffer fallback",
    sessionId,
    content: `
      const value = await nct.screen.waitFor('READY', 1000);
      nct.log('matched ' + value);
    `,
    permissionMode: "auto",
  });

  await delay(50);
  const earlyRun = sentRunUpdates.at(-1)?.find((run) => run.scriptId === "buffer-fallback");
  assert.notEqual(earlyRun?.status, "completed");
  assert.doesNotMatch(
    (earlyRun?.logs || []).map((entry) => entry.message).join("\n"),
    /matched READY/,
  );

  scriptBridge.appendSessionOutput(sessionId, "fresh READY\n");
  await runPromise;

  const finalRun = sentRunUpdates.at(-1).find((run) => run.scriptId === "buffer-fallback");
  assert.equal(finalRun.status, "completed");
  assert.match(finalRun.logs.map((entry) => entry.message).join("\n"), /matched READY/);
  scriptBridge.removeSessionBuffer(sessionId);
});

test("script waitFor keeps output that arrives during empty/fallback snapshot sync", async () => {
  const handlers = new Map();
  const sentRunUpdates = [];
  const sessionId = "session-output-during-empty-snapshot";
  let snapshotRequestId;

  scriptBridge.removeSessionBuffer(sessionId);
  scriptBridge.appendSessionOutput(sessionId, "old scrollback without keyword\n");
  scriptBridge.init({
    sessions: new Map(),
    electronModule: {
      app: {
        getVersion: () => "test",
        getPath: () => process.cwd(),
      },
      webContents: {
        fromId: () => null,
      },
    },
    terminalBridge: {
      writeToSession() {},
    },
    terminalWorkerManager: null,
    getMainWindow: () => ({
      webContents: {
        id: 1,
        send(channel, payload) {
          if (channel === "netcatty:script:runs-updated") {
            sentRunUpdates.push(payload.runs);
          }
          if (channel === "netcatty:script:screen-snapshot-request") {
            snapshotRequestId = payload.requestId;
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

  const runPromise = handlers.get("netcatty:script:run")({}, {
    scriptId: "empty-snapshot-race",
    scriptLabel: "Empty snapshot race",
    sessionId,
    content: `
      const value = await nct.screen.waitFor('READY', 1000);
      nct.log('matched ' + value);
    `,
    permissionMode: "auto",
  });

  await delay(20);
  assert.ok(snapshotRequestId);
  // Live output during the snapshot wait must stay matchable even when the
  // snapshot is empty / falls through to the consumed-baseline path.
  scriptBridge.appendSessionOutput(sessionId, "fresh READY\n");
  handlers.get("netcatty:script:screen-snapshot-response")({}, {
    requestId: snapshotRequestId,
    snapshot: {
      rows: 24,
      cols: 80,
      currentRow: 0,
      lines: [],
    },
  });

  await runPromise;

  const finalRun = sentRunUpdates.at(-1).find((run) => run.scriptId === "empty-snapshot-race");
  assert.equal(finalRun.status, "completed");
  assert.match(finalRun.logs.map((entry) => entry.message).join("\n"), /matched READY/);
  scriptBridge.removeSessionBuffer(sessionId);
});

test("script waitForRegex matches bastion menu already on screen at script start", async () => {
  const handlers = new Map();
  const sentRunUpdates = [];
  const sessionId = "session-bastion-menu-startup";
  // Keep the header near the top and pad past the 512-byte freshness slack so
  // the whole seeded viewport must stay waitable (#1960 / Codex review).
  const menuLines = [
    "Welcome to SSHD",
    "",
    "user login success",
    "",
    "SSH资源(5) :",
    "  [1] [Empty]@192.168.233.11  (联通助理自研NLP01) ",
    "  [2] [Empty]@192.168.238.34  (192.168.238.34) ",
    "  [3] [Empty]@192.168.242.11  (192.168.242.11) ",
    "  [4] [Empty]@192.168.80.18",
    "  [5] [Empty]@192.168.80.19",
    "",
    "Telnet资源(0) :",
    "",
    "Rlogin资源(0) :",
    "",
    "操作命令:",
    "[l] 显示SSH资源列表",
    "[i] 显示Telnet资源列表",
    "[r] 显示Rlogin资源列表",
    "[s] 搜索资源，根据IP/name/account/label",
    "[k] 显示历史会话列表",
    "[x] English",
    "[n] encoding UTF8",
    "[h] 显示帮助",
    "[e] 退出",
    ...Array.from({ length: 20 }, (_, i) => `  filler line ${i} ${"x".repeat(24)}`),
  ];
  assert.ok(menuLines.join("\n").length > 512);

  scriptBridge.removeSessionBuffer(sessionId);
  scriptBridge.appendSessionOutput(sessionId, `${menuLines.join("\n")}\n`);
  scriptBridge.init({
    sessions: new Map(),
    electronModule: {
      app: {
        getVersion: () => "test",
        getPath: () => process.cwd(),
      },
      webContents: {
        fromId: () => null,
      },
    },
    terminalBridge: {
      writeToSession() {},
    },
    terminalWorkerManager: null,
    getMainWindow: () => ({
      webContents: {
        id: 1,
        send(channel, payload) {
          if (channel === "netcatty:script:runs-updated") {
            sentRunUpdates.push(payload.runs);
          }
          if (channel === "netcatty:script:screen-snapshot-request") {
            setImmediate(() => {
              handlers.get("netcatty:script:screen-snapshot-response")({}, {
                requestId: payload.requestId,
                snapshot: {
                  rows: 40,
                  cols: 80,
                  currentRow: menuLines.length - 1,
                  lines: menuLines,
                },
              });
            });
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
    scriptId: "bastion-menu",
    scriptLabel: "Bastion menu",
    sessionId,
    content: `
      const value = await nct.screen.waitForRegex("SSH资源\\\\s*\\\\(\\\\d+\\\\)\\\\s*:", 1000);
      nct.log("matched " + value);
    `,
    permissionMode: "auto",
  });

  const finalRun = sentRunUpdates.at(-1).find((run) => run.scriptId === "bastion-menu");
  assert.equal(finalRun.status, "completed");
  assert.match(finalRun.logs.map((entry) => entry.message).join("\n"), /matched SSH资源\(5\) :/);
  scriptBridge.removeSessionBuffer(sessionId);
});

test("script waitForRegex keeps visible menu when BEL arrives during startup snapshot sync", async () => {
  const handlers = new Map();
  const sentRunUpdates = [];
  const sessionId = "session-bastion-menu-bel-during-sync";
  const menuLines = [
    "Welcome to SSHD",
    "",
    "user login success",
    "",
    "SSH资源(5) :",
    "  [1] [Empty]@192.168.233.11",
    "  [2] [Empty]@192.168.238.34",
    "  [3] [Empty]@192.168.242.11",
    ...Array.from({ length: 25 }, (_, i) => `  filler ${i} ${"y".repeat(20)}`),
  ];
  assert.ok(menuLines.join("\n").length > 512);
  let snapshotRequestId;

  scriptBridge.removeSessionBuffer(sessionId);
  scriptBridge.appendSessionOutput(sessionId, `${menuLines.join("\n")}\n`);
  scriptBridge.init({
    sessions: new Map(),
    electronModule: {
      app: {
        getVersion: () => "test",
        getPath: () => process.cwd(),
      },
      webContents: {
        fromId: () => null,
      },
    },
    terminalBridge: {
      writeToSession() {},
    },
    terminalWorkerManager: null,
    getMainWindow: () => ({
      webContents: {
        id: 1,
        send(channel, payload) {
          if (channel === "netcatty:script:runs-updated") {
            sentRunUpdates.push(payload.runs);
          }
          if (channel === "netcatty:script:screen-snapshot-request") {
            snapshotRequestId = payload.requestId;
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

  const runPromise = handlers.get("netcatty:script:run")({}, {
    scriptId: "bastion-bel",
    scriptLabel: "Bastion BEL during sync",
    sessionId,
    content: `
      const value = await nct.screen.waitForRegex("SSH资源\\\\s*\\\\(\\\\d+\\\\)\\\\s*:", 1000);
      nct.log("matched " + value);
    `,
    permissionMode: "auto",
  });

  await delay(20);
  assert.ok(snapshotRequestId);
  // Bastion keepalives / BEL can land while the snapshot IPC is in flight.
  scriptBridge.appendSessionOutput(sessionId, "\x07");
  scriptBridge.appendSessionOutput(sessionId, "\x07");
  handlers.get("netcatty:script:screen-snapshot-response")({}, {
    requestId: snapshotRequestId,
    snapshot: {
      rows: 40,
      cols: 80,
      currentRow: menuLines.length - 1,
      lines: menuLines,
    },
  });

  await runPromise;

  const finalRun = sentRunUpdates.at(-1).find((run) => run.scriptId === "bastion-bel");
  assert.equal(finalRun.status, "completed");
  assert.match(finalRun.logs.map((entry) => entry.message).join("\n"), /matched SSH资源\(5\) :/);
  scriptBridge.removeSessionBuffer(sessionId);
});

test("script waitFor sees output that arrives while startup snapshot sync is pending", async () => {
  const handlers = new Map();
  const sentRunUpdates = [];
  const sessionId = "session-output-during-startup-sync";
  let snapshotRequestId;

  scriptBridge.removeSessionBuffer(sessionId);
  scriptBridge.init({
    sessions: new Map(),
    electronModule: {
      app: {
        getVersion: () => "test",
        getPath: () => process.cwd(),
      },
      webContents: {
        fromId: () => null,
      },
    },
    terminalBridge: {
      writeToSession() {},
    },
    terminalWorkerManager: null,
    getMainWindow: () => ({
      webContents: {
        id: 1,
        send(channel, payload) {
          if (channel === "netcatty:script:runs-updated") {
            sentRunUpdates.push(payload.runs);
          }
          if (channel === "netcatty:script:screen-snapshot-request") {
            snapshotRequestId = payload.requestId;
          }
          if (channel === "netcatty:script:dialog-request") {
            setImmediate(() => {
              handlers.get("netcatty:script:dialog-response")({}, {
                requestId: payload.requestId,
                value: "abort",
              });
            });
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

  const runPromise = handlers.get("netcatty:script:run")({}, {
    scriptId: "output-during-sync",
    scriptLabel: "Output during sync",
    sessionId,
    content: `
      const value = await nct.screen.waitFor('READY', 1000);
      nct.log('matched ' + value);
    `,
    permissionMode: "auto",
  });

  await delay(20);
  assert.ok(snapshotRequestId);
  scriptBridge.appendSessionOutput(sessionId, "fresh READY\n");
  handlers.get("netcatty:script:screen-snapshot-response")({}, {
    requestId: snapshotRequestId,
    snapshot: {
      rows: 24,
      cols: 80,
      currentRow: 0,
      lines: ["user@host:~$ "],
    },
  });

  await runPromise;

  const finalRun = sentRunUpdates.at(-1).find((run) => run.scriptId === "output-during-sync");
  assert.equal(finalRun.status, "completed");
  assert.match(finalRun.logs.map((entry) => entry.message).join("\n"), /matched READY/);
  scriptBridge.removeSessionBuffer(sessionId);
});

test("script waitForPrompt can still use the current startup prompt", async () => {
  const handlers = new Map();
  const sentRunUpdates = [];
  const sessionId = "session-startup-prompt";

  scriptBridge.removeSessionBuffer(sessionId);
  scriptBridge.init({
    sessions: new Map(),
    electronModule: {
      app: {
        getVersion: () => "test",
        getPath: () => process.cwd(),
      },
      webContents: {
        fromId: () => null,
      },
    },
    terminalBridge: {
      writeToSession() {},
    },
    terminalWorkerManager: null,
    getMainWindow: () => ({
      webContents: {
        id: 1,
        send(channel, payload) {
          if (channel === "netcatty:script:runs-updated") {
            sentRunUpdates.push(payload.runs);
          }
          if (channel === "netcatty:script:screen-snapshot-request") {
            setImmediate(() => {
              handlers.get("netcatty:script:screen-snapshot-response")({}, {
                requestId: payload.requestId,
                snapshot: {
                  rows: 24,
                  cols: 80,
                  currentRow: 0,
                  lines: ["root@host:~# "],
                },
              });
            });
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
    scriptId: "startup-prompt",
    scriptLabel: "Startup prompt",
    sessionId,
    content: `
      const index = await nct.screen.waitForPrompt(1000);
      nct.log('prompt index ' + index);
    `,
    permissionMode: "auto",
  });

  const finalRun = sentRunUpdates.at(-1).find((run) => run.scriptId === "startup-prompt");
  assert.equal(finalRun.status, "completed");
  assert.match(finalRun.logs.map((entry) => entry.message).join("\n"), /prompt index/);
  scriptBridge.removeSessionBuffer(sessionId);
});

test("script sendLine invalidates startup seed before later waits", async () => {
  const handlers = new Map();
  const sentRunUpdates = [];
  const sessionId = "session-send-invalidates-seed";
  const writes = [];

  scriptBridge.removeSessionBuffer(sessionId);
  scriptBridge.init({
    sessions: new Map(),
    electronModule: {
      app: {
        getVersion: () => "test",
        getPath: () => process.cwd(),
      },
      webContents: {
        fromId: () => null,
      },
    },
    terminalBridge: {
      writeToSession(_event, payload) {
        writes.push(payload.data);
      },
    },
    terminalWorkerManager: null,
    getMainWindow: () => ({
      webContents: {
        id: 1,
        send(channel, payload) {
          if (channel === "netcatty:script:runs-updated") {
            sentRunUpdates.push(payload.runs);
          }
          if (channel === "netcatty:script:screen-snapshot-request") {
            setImmediate(() => {
              handlers.get("netcatty:script:screen-snapshot-response")({}, {
                requestId: payload.requestId,
                snapshot: {
                  rows: 24,
                  cols: 80,
                  currentRow: 0,
                  lines: ["root@host:~# ", "old READY"],
                },
              });
            });
          }
          if (channel === "netcatty:script:dialog-request") {
            setImmediate(() => {
              handlers.get("netcatty:script:dialog-response")({}, {
                requestId: payload.requestId,
                value: "abort",
              });
            });
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

  const runPromise = handlers.get("netcatty:script:run")({}, {
    scriptId: "send-invalidates-seed",
    scriptLabel: "Send invalidates seed",
    sessionId,
    content: `
      await nct.screen.sendLine('echo hi');
      const prompt = await nct.screen.waitForPrompt(1000);
      nct.log('prompt ' + prompt);
      const value = await nct.screen.waitForText('READY', 1000);
      nct.log('matched ' + value);
    `,
    permissionMode: "auto",
  });

  await delay(40);
  assert.ok(writes.some((data) => String(data).includes("echo hi")));

  // Startup seed must be gone: waits should not resolve on old READY / old prompt.
  await delay(80);
  const midRun = sentRunUpdates.at(-1).find((run) => run.scriptId === "send-invalidates-seed");
  assert.equal(midRun.status, "running");

  // Prompt first, then post-command READY — matching the common send-then-wait flow.
  scriptBridge.appendSessionOutput(sessionId, "\necho hi\nroot@host:~# \nfresh READY\n");

  await runPromise;

  const finalRun = sentRunUpdates.at(-1).find((run) => run.scriptId === "send-invalidates-seed");
  assert.equal(finalRun.status, "completed");
  assert.match(finalRun.logs.map((entry) => entry.message).join("\n"), /prompt 0/);
  assert.match(finalRun.logs.map((entry) => entry.message).join("\n"), /matched READY/);
  scriptBridge.removeSessionBuffer(sessionId);
});
