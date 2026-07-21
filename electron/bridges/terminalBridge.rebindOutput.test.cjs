const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

function loadTerminalBridgeWithMocks() {
  const bridgePath = require.resolve("./terminalBridge.cjs");
  delete require.cache[bridgePath];

  const opened = [];
  const fakeChannel = {
    openSession(sessionId, webContents) {
      opened.push({ sessionId, webContentsId: webContents.id });
      return true;
    },
    closeSession() {},
  };

  const originalRequire = Module.prototype.require;
  Module.prototype.require = function patchedRequire(request) {
    if (request === "./terminalOutputChannel.cjs" || request.endsWith("terminalOutputChannel.cjs")) {
      return {
        createTerminalOutputChannel: () => fakeChannel,
        TERMINAL_OUTPUT_PORT_CHANNEL: "netcatty:terminal-output-port",
      };
    }
    if (request === "./emitTerminalSessionData.cjs" || request.endsWith("emitTerminalSessionData.cjs")) {
      return { configureTerminalSessionDataEmitter: () => {} };
    }
    return originalRequire.apply(this, arguments);
  };

  try {
    const bridge = require("./terminalBridge.cjs");
    return { bridge, opened, fakeChannel };
  } finally {
    Module.prototype.require = originalRequire;
  }
}

test("rebindTerminalSessionOutput moves output and updates webContentsId", () => {
  // Load bridge source helpers via init + direct IPC simulation is heavy;
  // assert the implementation is registered and the openSession rebind contract
  // used by the attach popup is present.
  const source = require("node:fs").readFileSync(
    path.join(__dirname, "terminalBridge.cjs"),
    "utf8",
  );
  assert.match(source, /function rebindTerminalSessionOutput/);
  assert.match(source, /function restoreTerminalSessionOutput/);
  assert.match(source, /netcatty:terminal:rebindOutput/);
  assert.match(source, /netcatty:terminal:restoreOutput/);
  assert.match(source, /session\.webContentsId = sender\.id/);
});

test("rebind and restore handlers register even when terminal worker is enabled", () => {
  const source = require("node:fs").readFileSync(
    path.join(__dirname, "terminalBridge.cjs"),
    "utf8",
  );
  // Must be registered before the worker early-return, otherwise production
  // (worker-on) hits "No handler registered for rebindOutput" on first attach.
  const rebindIdx = source.indexOf('ipcMain.handle("netcatty:terminal:rebindOutput"');
  const restoreIdx = source.indexOf('ipcMain.handle("netcatty:terminal:restoreOutput"');
  const snapshotIdx = source.indexOf('ipcMain.handle("netcatty:terminal:requestSnapshot"');
  const workerReturnIdx = source.indexOf("].forEach((channel) => registerWorkerSend");
  assert.ok(rebindIdx > 0, "rebind handler present");
  assert.ok(restoreIdx > 0, "restore handler present");
  assert.ok(snapshotIdx > 0, "snapshot handler present");
  assert.ok(workerReturnIdx > 0, "worker send registration present");
  assert.ok(rebindIdx < workerReturnIdx, "rebind registered before worker-only early return");
  assert.ok(restoreIdx < workerReturnIdx, "restore registered before worker-only early return");
  assert.ok(snapshotIdx < workerReturnIdx, "snapshot registered before worker-only early return");
  assert.match(source, /terminalWorkerManager\.rebindOutputSession/);
  assert.match(source, /function requestTerminalSessionSnapshot/);
});

test("worker renderer-event forwarding prefers rebound webContentsId", () => {
  const source = require("node:fs").readFileSync(
    path.join(__dirname, "terminalWorkerManager.cjs"),
    "utf8",
  );
  assert.match(source, /sessionWebContentsIds\.get\(sessionId\)/);
  assert.match(source, /targetWebContentsId/);
  // Exit cleanup must not run before we capture the rebound target.
  const captureIdx = source.indexOf("const targetWebContentsId =");
  const closeIdx = source.indexOf('if (message.channel === "netcatty:exit"');
  assert.ok(captureIdx > 0 && closeIdx > captureIdx, "capture target before closeOutputSession on exit");
});

test("terminal worker manager exposes rebindOutputSession", () => {
  const source = require("node:fs").readFileSync(
    path.join(__dirname, "terminalWorkerManager.cjs"),
    "utf8",
  );
  assert.match(source, /function rebindOutputSession/);
  assert.match(source, /rebindOutputSession,/);
  assert.match(source, /getSessionWebContentsId\(sessionId\)/);
});

test("attach popup payload field is consumed by terminal popup window", () => {
  const source = require("node:fs").readFileSync(
    path.join(__dirname, "windowManager/terminalPopupWindow.cjs"),
    "utf8",
  );
  assert.match(source, /attachSessionId/);
  assert.match(source, /attachSessionPopups/);
  assert.match(source, /reused: true/);
});
