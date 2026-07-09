const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const scriptBridge = require("./scriptBridge.cjs");
const sessionLogStreamManager = require("./sessionLogStreamManager.cjs");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await delay(10);
  }
  throw new Error("Timed out waiting for condition");
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
  // sendLine emits body then CR as separate keyboard-like writes (#1960).
  assert.equal(workerSends.length, 2);
  assert.equal(workerSends[0].channel, "netcatty:write");
  assert.deepEqual(workerSends[0].payload, {
    sessionId: "session-1",
    data: "echo hi",
    automated: true,
  });
  assert.deepEqual(workerSends[1].payload, {
    sessionId: "session-1",
    data: "\r",
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

test("stopping a script releases the session queue so it can run again", async () => {
  const handlers = new Map();
  const sentRunUpdates = [];
  const writes = [];
  let dialogRequestId;

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
        writes.push(String(payload.data || ""));
      },
    },
    terminalWorkerManager: null,
    getMainWindow: () => ({
      webContents: {
        send(channel, payload) {
          if (channel === "netcatty:script:runs-updated") {
            sentRunUpdates.push(payload.runs);
          }
          if (channel === "netcatty:script:dialog-request") {
            dialogRequestId = payload.requestId;
          }
          if (channel === "netcatty:script:screen-snapshot-request") {
            setImmediate(() => {
              handlers.get("netcatty:script:screen-snapshot-response")({}, {
                requestId: payload.requestId,
                snapshot: {
                  rows: 24,
                  cols: 80,
                  currentRow: 0,
                  lines: [],
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

  const runHandler = handlers.get("netcatty:script:run");
  const firstRunPromise = runHandler({}, {
    scriptId: "stopped",
    scriptLabel: "Stopped",
    sessionId: "session-rerun",
    content: `
      const allowed = await nct.dialog.confirm('continue?');
      if (allowed) {
        await nct.screen.sendLine('old-run');
      }
    `,
    permissionMode: "auto",
  });

  await waitUntil(() => dialogRequestId);
  const firstRunId = await waitUntil(() => (
    sentRunUpdates
      .flat()
      .find((run) => run.scriptId === "stopped" && run.status === "running")
      ?.runId
  ));

  assert.deepEqual(await handlers.get("netcatty:script:stop")({}, { runId: firstRunId }), { ok: true });

  await Promise.race([
    runHandler({}, {
      scriptId: "rerun",
      scriptLabel: "Rerun",
      sessionId: "session-rerun",
      content: "await nct.screen.sendLine('second-run');",
      permissionMode: "auto",
    }),
    delay(500).then(() => {
      throw new Error("rerun stayed blocked behind stopped script");
    }),
  ]);
  await firstRunPromise;

  assert.ok(writes.some((data) => data.includes("second-run")));
  assert.ok(!writes.some((data) => data.includes("old-run")));

  assert.deepEqual(await handlers.get("netcatty:script:dialog-response")({}, {
    requestId: dialogRequestId,
    value: true,
  }), { ok: false });
  await delay(100);
  assert.ok(!writes.some((data) => data.includes("old-run")));

  const stoppedRun = sentRunUpdates.flat().find((run) => (
    run.runId === firstRunId && run.status === "failed"
  ));
  assert.equal(stoppedRun.status, "failed");
  assert.equal(stoppedRun.error, "Stopped by user");
});

test("late startup snapshots from a stopped script do not seed the next run", async () => {
  const handlers = new Map();
  const writes = [];
  const sentRunUpdates = [];
  const snapshotRequestIds = [];

  scriptBridge.removeSessionBuffer("session-late-snapshot");
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
        writes.push(String(payload.data || ""));
      },
    },
    terminalWorkerManager: null,
    getMainWindow: () => ({
      webContents: {
        send(channel, payload) {
          if (channel === "netcatty:script:runs-updated") {
            sentRunUpdates.push(payload.runs);
          }
          if (channel === "netcatty:script:dialog-request") {
            setImmediate(() => {
              handlers.get("netcatty:script:dialog-response")({}, {
                requestId: payload.requestId,
                value: "abort",
              });
            });
          }
          if (channel === "netcatty:script:screen-snapshot-request") {
            snapshotRequestIds.push(payload.requestId);
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

  const runHandler = handlers.get("netcatty:script:run");
  const firstRunPromise = runHandler({}, {
    scriptId: "stopped-before-snapshot",
    scriptLabel: "Stopped before snapshot",
    sessionId: "session-late-snapshot",
    content: "await nct.screen.sendLine('old-run');",
    permissionMode: "auto",
  });

  const firstSnapshotRequestId = await waitUntil(() => snapshotRequestIds[0]);
  const firstRunId = await waitUntil(() => (
    sentRunUpdates
      .flat()
      .find((run) => run.scriptId === "stopped-before-snapshot" && run.status === "running")
      ?.runId
  ));
  assert.deepEqual(await handlers.get("netcatty:script:stop")({}, { runId: firstRunId }), { ok: true });
  await firstRunPromise;

  const secondRunPromise = runHandler({}, {
    scriptId: "second-after-late-snapshot",
    scriptLabel: "Second after late snapshot",
    sessionId: "session-late-snapshot",
    content: `
      try {
        await nct.screen.waitForText('OLD_READY', 200);
        await nct.screen.sendLine('bad-write');
      } catch {
        await nct.screen.sendLine('good-write');
      }
    `,
    permissionMode: "auto",
  });

  const secondSnapshotRequestId = await waitUntil(() => snapshotRequestIds[1]);
  assert.deepEqual(await handlers.get("netcatty:script:screen-snapshot-response")({}, {
    requestId: secondSnapshotRequestId,
    snapshot: {
      rows: 24,
      cols: 80,
      currentRow: 0,
      lines: [],
    },
  }), { ok: true });

  await delay(30);
  assert.deepEqual(await handlers.get("netcatty:script:screen-snapshot-response")({}, {
    requestId: firstSnapshotRequestId,
    snapshot: {
      rows: 24,
      cols: 80,
      currentRow: 0,
      lines: ["OLD_READY"],
    },
  }), { ok: false });

  await secondRunPromise;
  assert.ok(writes.some((data) => data.includes("good-write")));
  assert.ok(!writes.some((data) => data.includes("bad-write")));
  assert.ok(!writes.some((data) => data.includes("old-run")));
  scriptBridge.removeSessionBuffer("session-late-snapshot");
});

test("completed scripts clear unawaited dialog requests without rejecting them as stopped", async () => {
  const handlers = new Map();
  const sentRunUpdates = [];
  const closedSessions = [];
  let dialogRequestId;

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
      closeSession(_event, payload) {
        closedSessions.push(payload.sessionId);
      },
    },
    terminalWorkerManager: null,
    getMainWindow: () => ({
      webContents: {
        send(channel, payload) {
          if (channel === "netcatty:script:runs-updated") {
            sentRunUpdates.push(payload.runs);
          }
          if (channel === "netcatty:script:dialog-request") {
            dialogRequestId = payload.requestId;
          }
          if (channel === "netcatty:script:screen-snapshot-request") {
            setImmediate(() => {
              handlers.get("netcatty:script:screen-snapshot-response")({}, {
                requestId: payload.requestId,
                snapshot: {
                  rows: 24,
                  cols: 80,
                  currentRow: 0,
                  lines: [],
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
    scriptId: "unawaited-dialog",
    scriptLabel: "Unawaited dialog",
    sessionId: "session-unawaited-dialog",
    content: `
      void nct.dialog.confirm('background prompt').then(() => nct.session.disconnect());
      nct.log('done');
    `,
    permissionMode: "auto",
  });

  await delay(100);
  assert.ok(dialogRequestId);
  assert.deepEqual(closedSessions, []);
  const finalRun = sentRunUpdates.at(-1).find((run) => run.scriptId === "unawaited-dialog");
  assert.equal(finalRun.status, "completed");
  assert.deepEqual(await handlers.get("netcatty:script:dialog-response")({}, {
    requestId: dialogRequestId,
    value: true,
  }), { ok: false });
});

test("stopping scripts clears unawaited dialog requests without unhandled rejections", async () => {
  const handlers = new Map();
  const sentRunUpdates = [];
  const unhandled = [];
  let dialogRequestId;

  const onUnhandledRejection = (reason) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
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
            if (channel === "netcatty:script:dialog-request") {
              dialogRequestId = payload.requestId;
            }
            if (channel === "netcatty:script:screen-snapshot-request") {
              setImmediate(() => {
                handlers.get("netcatty:script:screen-snapshot-response")({}, {
                  requestId: payload.requestId,
                  snapshot: {
                    rows: 24,
                    cols: 80,
                    currentRow: 0,
                    lines: [],
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

    const runPromise = handlers.get("netcatty:script:run")({}, {
      scriptId: "stop-unawaited-dialog",
      scriptLabel: "Stop unawaited dialog",
      sessionId: "session-stop-unawaited-dialog",
      content: `
        void nct.dialog.confirm('background prompt');
        await nct.sleep(5000);
      `,
      permissionMode: "auto",
    });

    await waitUntil(() => dialogRequestId);
    const runId = await waitUntil(() => (
      sentRunUpdates
        .flat()
        .find((run) => run.scriptId === "stop-unawaited-dialog" && run.status === "running")
        ?.runId
    ));

    assert.deepEqual(await handlers.get("netcatty:script:stop")({}, { runId }), { ok: true });
    await runPromise;
    await delay(100);

    assert.equal(unhandled.length, 0);
    assert.deepEqual(await handlers.get("netcatty:script:dialog-response")({}, {
      requestId: dialogRequestId,
      value: true,
    }), { ok: false });
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
});

test("stopping scripts clears unawaited screen reads without unhandled rejections", async () => {
  const handlers = new Map();
  const sentRunUpdates = [];
  const snapshotRequestIds = [];
  const unhandled = [];

  const onUnhandledRejection = (reason) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
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
            if (channel === "netcatty:script:screen-snapshot-request") {
              snapshotRequestIds.push(payload.requestId);
              if (snapshotRequestIds.length === 1) {
                setImmediate(() => {
                  handlers.get("netcatty:script:screen-snapshot-response")({}, {
                    requestId: payload.requestId,
                    snapshot: {
                      rows: 24,
                      cols: 80,
                      currentRow: 0,
                      lines: [],
                    },
                  });
                });
              }
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
      scriptId: "stop-unawaited-screen-read",
      scriptLabel: "Stop unawaited screen read",
      sessionId: "session-stop-unawaited-screen-read",
      content: `
        void nct.screen.getText();
        await nct.sleep(5000);
      `,
      permissionMode: "auto",
    });

    await waitUntil(() => snapshotRequestIds[1]);
    const runId = await waitUntil(() => (
      sentRunUpdates
        .flat()
        .find((run) => run.scriptId === "stop-unawaited-screen-read" && run.status === "running")
        ?.runId
    ));

    assert.deepEqual(await handlers.get("netcatty:script:stop")({}, { runId }), { ok: true });
    await runPromise;
    await delay(100);

    assert.equal(unhandled.length, 0);
    assert.deepEqual(await handlers.get("netcatty:script:screen-snapshot-response")({}, {
      requestId: snapshotRequestIds[1],
      snapshot: {
        rows: 24,
        cols: 80,
        currentRow: 0,
        lines: ["late"],
      },
    }), { ok: false });
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
});

test("stopping a script releases its session log so the next run can start one", async () => {
  const handlers = new Map();
  const sentRunUpdates = [];
  const sessionId = "session-stop-log-cleanup";
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-script-log-test-"));

  try {
    scriptBridge.init({
      sessions: new Map([[sessionId, { hostname: "example.test" }]]),
      electronModule: {
        app: {
          getVersion: () => "test",
          getPath: () => logDir,
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
            if (channel === "netcatty:script:screen-snapshot-request") {
              setImmediate(() => {
                handlers.get("netcatty:script:screen-snapshot-response")({}, {
                  requestId: payload.requestId,
                  snapshot: {
                    rows: 24,
                    cols: 80,
                    currentRow: 0,
                    lines: [],
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

    const runHandler = handlers.get("netcatty:script:run");
    const firstLogPath = path.join(logDir, "first.log");
    const firstRunPromise = runHandler({}, {
      scriptId: "stopped-log-run",
      scriptLabel: "Stopped log run",
      sessionId,
      content: `
        await nct.session.startLog(${JSON.stringify(firstLogPath)});
        try {
          await nct.sleep(5000);
        } finally {
          await nct.session.stopLog();
        }
      `,
      permissionMode: "auto",
    });

    await waitUntil(() => sessionLogStreamManager.hasStream(sessionId));
    const firstRunId = await waitUntil(() => (
      sentRunUpdates
        .flat()
        .find((run) => run.scriptId === "stopped-log-run" && run.status === "running")
        ?.runId
    ));

    assert.deepEqual(await handlers.get("netcatty:script:stop")({}, { runId: firstRunId }), { ok: true });
    await firstRunPromise;
    await waitUntil(() => !sessionLogStreamManager.hasStream(sessionId));

    const secondLogPath = path.join(logDir, "second.log");
    await runHandler({}, {
      scriptId: "next-log-run",
      scriptLabel: "Next log run",
      sessionId,
      content: `
        await nct.session.startLog(${JSON.stringify(secondLogPath)});
        await nct.session.stopLog();
      `,
      permissionMode: "auto",
    });

    const secondRun = sentRunUpdates.at(-1).find((run) => run.scriptId === "next-log-run");
    assert.equal(secondRun.status, "completed");
    assert.equal(sessionLogStreamManager.hasStream(sessionId), false);
  } finally {
    await sessionLogStreamManager.cleanupAll();
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test("late stopLog from a stopped script does not close the next run log", async () => {
  const handlers = new Map();
  const sentRunUpdates = [];
  const sessionId = "session-stale-stop-log";
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-script-stale-log-test-"));

  try {
    scriptBridge.init({
      sessions: new Map([[sessionId, { hostname: "example.test" }]]),
      electronModule: {
        app: {
          getVersion: () => "test",
          getPath: () => logDir,
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
            if (channel === "netcatty:script:screen-snapshot-request") {
              setImmediate(() => {
                handlers.get("netcatty:script:screen-snapshot-response")({}, {
                  requestId: payload.requestId,
                  snapshot: {
                    rows: 24,
                    cols: 80,
                    currentRow: 0,
                    lines: [],
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

    const runHandler = handlers.get("netcatty:script:run");
    const firstRunPromise = runHandler({}, {
      scriptId: "stale-stop-log-first",
      scriptLabel: "Stale stopLog first",
      sessionId,
      content: `
        await nct.session.startLog(${JSON.stringify(path.join(logDir, "first.log"))});
        try {
          await nct.sleep(5000);
        } finally {
          await nct.session.stopLog();
        }
      `,
      permissionMode: "auto",
    });

    await waitUntil(() => sessionLogStreamManager.hasStream(sessionId));
    const firstRunId = await waitUntil(() => (
      sentRunUpdates
        .flat()
        .find((run) => run.scriptId === "stale-stop-log-first" && run.status === "running")
        ?.runId
    ));

    assert.deepEqual(await handlers.get("netcatty:script:stop")({}, { runId: firstRunId }), { ok: true });
    await firstRunPromise;
    await waitUntil(() => !sessionLogStreamManager.hasStream(sessionId));

    const secondRunPromise = runHandler({}, {
      scriptId: "stale-stop-log-second",
      scriptLabel: "Stale stopLog second",
      sessionId,
      content: `
        await nct.session.startLog(${JSON.stringify(path.join(logDir, "second.log"))});
        await nct.sleep(250);
        await nct.session.stopLog();
      `,
      permissionMode: "auto",
    });

    await waitUntil(() => sessionLogStreamManager.hasStream(sessionId));
    await delay(120);
    assert.equal(sessionLogStreamManager.hasStream(sessionId), true);
    await secondRunPromise;

    const secondRun = sentRunUpdates.at(-1).find((run) => run.scriptId === "stale-stop-log-second");
    assert.equal(secondRun.status, "completed");
    assert.equal(sessionLogStreamManager.hasStream(sessionId), false);
  } finally {
    await sessionLogStreamManager.cleanupAll();
    fs.rmSync(logDir, { recursive: true, force: true });
  }
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

test("script waitFor seeds buffer-fallback so connection banners stay waitable (#1960)", async () => {
  const handlers = new Map();
  const sentRunUpdates = [];
  const sessionId = "session-buffer-fallback-scrollback";

  scriptBridge.removeSessionBuffer(sessionId);
  // Buffer-fallback must seed the live buffer so bastion menus already
  // received stay waitable. Scrolled-off rematch is covered by viewport tests.
  scriptBridge.appendSessionOutput(sessionId, "Welcome to SSHD\nSSH资源(5) :\n> \n");
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

  await handlers.get("netcatty:script:run")({}, {
    scriptId: "buffer-fallback",
    scriptLabel: "Buffer fallback",
    sessionId,
    content: `
      const value = await nct.screen.waitForRegex("SSH资源\\\\s*\\\\(\\\\d+\\\\)\\\\s*:", 1000);
      nct.log('matched ' + value);
    `,
    permissionMode: "auto",
  });

  const finalRun = sentRunUpdates.at(-1).find((run) => run.scriptId === "buffer-fallback");
  assert.equal(finalRun.status, "completed", finalRun.error || "expected completed");
  assert.match(finalRun.logs.map((entry) => entry.message).join("\n"), /matched SSH资源\(5\) :/);
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

  await delay(80);
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

test("script sendLine keeps prompts that arrive between body and CR waitable", async () => {
  const handlers = new Map();
  const sentRunUpdates = [];
  const sessionId = "session-sendline-gap-prompt";
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
        if (payload.data === "3") {
          setTimeout(() => {
            scriptBridge.appendSessionOutput(sessionId, "\n资源'[Empty]'账户:");
          }, 5);
        }
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
                  lines: ["SSH资源(5) :", "> "],
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
    scriptId: "sendline-gap",
    scriptLabel: "SendLine gap prompt",
    sessionId,
    content: `
      await nct.screen.waitForRegex("SSH资源\\\\s*\\\\(\\\\d+\\\\)\\\\s*:", 1000);
      await nct.screen.sendLine("3");
      await nct.screen.waitForText("资源'[Empty]'账户:", 1000);
      await nct.screen.sendLine("zxadmin");
      nct.log("account sent");
    `,
    permissionMode: "auto",
  });

  const finalRun = sentRunUpdates.at(-1).find((run) => run.scriptId === "sendline-gap");
  assert.equal(finalRun.status, "completed", finalRun.error || "expected completed");
  assert.deepEqual(writes.filter((w) => w === "3" || w === "\r" || w === "zxadmin"), [
    "3",
    "\r",
    "zxadmin",
    "\r",
  ]);
  assert.match(finalRun.logs.map((entry) => entry.message).join("\n"), /account sent/);
  scriptBridge.removeSessionBuffer(sessionId);
});

test("resolveStartupSeedText prefers buffer when viewport paint lags bastion menu", () => {
  const buffer =
    "Welcome to SSHD\n\nuser login success\n\nSSH资源(5) :\n  [1] host\n";
  const laggingViewport = "Welcome to SSHD\n\nuser login success\n";
  const seed = scriptBridge.resolveStartupSeedText(laggingViewport, buffer);
  assert.match(seed, /SSH资源\(5\)/);
  assert.equal(scriptBridge.resolveStartupSeedText("", buffer), buffer);
});

test("resolveStartupSeedText prefers viewport when buffer only adds scrolled-off prefix", () => {
  const viewport = "SSH资源(5) :\n  [1] host\n";
  const buffer = `old deployment READY marker\nuser@host:~$ \n${viewport}`;
  const seed = scriptBridge.resolveStartupSeedText(viewport, buffer);
  assert.equal(seed, viewport);
  assert.doesNotMatch(seed, /READY marker/);
});
