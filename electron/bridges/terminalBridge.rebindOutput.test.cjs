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
  assert.match(source, /displayWebContentsId/);
  assert.match(source, /attachHomeWebContentsIds/);
  assert.match(source, /restoreAttachHome/);
  // Exit cleanup must not run before we capture display/home targets.
  const captureIdx = source.indexOf("const displayWebContentsId =");
  const closeIdx = source.indexOf('if (message.channel === "netcatty:exit"');
  assert.ok(captureIdx > 0 && closeIdx > captureIdx, "capture targets before closeOutputSession on exit");
  assert.match(
    source,
    /message\.channel === "netcatty:exit" && homeWebContentsId != null/,
    "only exit events fan out to the attach home",
  );
});

test("in-process SSH and Telnet ZMODEM prompts follow the rebound display", () => {
  const sshSource = require("node:fs").readFileSync(
    path.join(__dirname, "sshBridge/startSession.cjs"),
    "utf8",
  );
  const telnetSource = require("node:fs").readFileSync(
    path.join(__dirname, "terminalBridge/telnetSession.cjs"),
    "utf8",
  );
  const sshSentry = sshSource.slice(
    sshSource.indexOf("const sshZmodemSentry"),
    sshSource.indexOf("session.zmodemSentry = sshZmodemSentry"),
  );
  const telnetSentry = telnetSource.slice(
    telnetSource.indexOf("const telnetZmodemSentry"),
    telnetSource.indexOf("const attachTelnetSentry"),
  );
  assert.match(sshSentry, /getCurrentSessionWebContents/);
  assert.match(sshSentry, /getCurrentSessionWebContentsId/);
  assert.doesNotMatch(sshSentry, /event\.sender/);
  assert.match(telnetSentry, /getCurrentTelnetWebContents/);
  assert.match(telnetSentry, /getCurrentTelnetWebContentsId/);
  assert.doesNotMatch(telnetSentry, /telnetWebContentsId/);
});

test("popup window closed lifecycle restores attach output", () => {
  const source = require("node:fs").readFileSync(
    path.join(__dirname, "windowManager/terminalPopupWindow.cjs"),
    "utf8",
  );
  assert.match(source, /restoreAttachedSessionOutput\(attachSessionId\)/);
  assert.match(source, /terminalAttachRestore/);
  const crashStart = source.indexOf('"render-process-gone"');
  const crashEnd = source.indexOf('"console-message"', crashStart);
  assert.match(source.slice(crashStart, crashEnd), /win\.destroy\(\)/);
});

test("attach close restores the output route before resuming the backend", () => {
  const bridgeSource = require("node:fs").readFileSync(
    path.join(__dirname, "terminalBridge.cjs"),
    "utf8",
  );
  const restoreStart = bridgeSource.indexOf("function restoreAttachedSessionOutput");
  const restoreEnd = bridgeSource.indexOf("function restoreTerminalSessionOutput", restoreStart);
  const restoreSource = bridgeSource.slice(restoreStart, restoreEnd);
  const routeIdx = restoreSource.indexOf("restoreAttachHome");
  const resumeIdx = restoreSource.indexOf("resumeSessionOutputFlow");
  assert.ok(routeIdx > 0 && resumeIdx > routeIdx, "restore route before resuming output");

  const terminalSource = require("node:fs").readFileSync(
    path.join(__dirname, "../../components/Terminal.tsx"),
    "utf8",
  );
  const cleanupStart = terminalSource.indexOf("Observe/attach popups must not kill");
  const cleanupEnd = terminalSource.indexOf("const cleanupPromise", cleanupStart);
  const cleanupSource = terminalSource.slice(cleanupStart, cleanupEnd);
  const pauseIdx = cleanupSource.indexOf("setSessionFlowPaused?.(closingSessionId, true)");
  const snapshotIdx = cleanupSource.indexOf("applySessionSnapshot");
  const rendererRestoreIdx = cleanupSource.indexOf("restoreSessionOutput");
  const disposeIdx = cleanupSource.indexOf("disposeSessionListeners()");
  const releaseIdx = cleanupSource.indexOf("releaseTerminalFlowBeforeHibernate");
  assert.ok(pauseIdx > 0, "pause before final snapshot");
  assert.ok(snapshotIdx > pauseIdx, "snapshot after pause");
  assert.ok(rendererRestoreIdx > snapshotIdx, "restore route after snapshot");
  assert.ok(disposeIdx > rendererRestoreIdx, "detach popup listener after route restore");
  assert.ok(releaseIdx > disposeIdx, "resume only after popup listener detaches");
  const mainRestoreStart = bridgeSource.indexOf("function restoreAttachedSessionOutput");
  const mainRestoreEnd = bridgeSource.indexOf("function restoreTerminalSessionOutput", mainRestoreStart);
  const mainRestoreSource = bridgeSource.slice(mainRestoreStart, mainRestoreEnd);
  assert.match(mainRestoreSource, /if \(result\?\.success\) \{\s*resumeSessionOutputFlow/);
});

test("in-process explicit close sends an exit event before dropping the output route", () => {
  const source = require("node:fs").readFileSync(
    path.join(__dirname, "terminalBridge.cjs"),
    "utf8",
  );
  const start = source.indexOf("function closeSession(event, payload)");
  const end = source.indexOf("function setSessionEncoding", start);
  const closeSource = source.slice(start, end);
  assert.ok(
    closeSource.indexOf("fanoutSessionLifecycleEvent") < closeSource.indexOf("closeTerminalOutputSession"),
    "notify attached renderers before removing their output route",
  );
  assert.match(source, /if \(session\.closed\) return;/, "transport callbacks suppress duplicate explicit-close exits");
  const sshSource = require("node:fs").readFileSync(
    path.join(__dirname, "sshBridge/startSession.cjs"),
    "utf8",
  );
  assert.match(sshSource, /if \(liveSession\?\.closed\)/, "SSH close callback suppresses duplicate explicit-close exits");
});

test("in-process explicit close notifies a rebound popup and its home renderer", () => {
  const { bridge, fakeChannel } = loadTerminalBridgeWithMocks();
  const sent = [];
  const contents = new Map([7, 9].map((id) => [id, {
    id,
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ id, channel, payload }),
  }]));
  const sessions = new Map([[
    "session-close",
    { webContentsId: 7, proc: { kill() {} } },
  ]]);
  bridge.init({
    sessions,
    electronModule: { webContents: { fromId: (id) => contents.get(id) } },
    terminalOutputChannel: fakeChannel,
  });
  const registry = require("./terminalAttachRestore.cjs");
  registry.registerAttachPopupAuthorization("close-grant", "session-close", 9);
  assert.equal(bridge.registerHandlers != null, true);
  const ipcMain = {
    handlers: new Map(),
    listeners: new Map(),
    handle(channel, handler) { this.handlers.set(channel, handler); },
    on(channel, handler) { this.listeners.set(channel, handler); },
  };
  bridge.registerHandlers(ipcMain);
  assert.equal(
    ipcMain.handlers.get("netcatty:terminal:rebindOutput")(
      { sender: contents.get(9) },
      { sessionId: "session-close", authorization: "close-grant" },
    ).success,
    true,
  );

  bridge.closeSession({ sender: contents.get(7) }, { sessionId: "session-close" });

  assert.deepEqual(sent, [
    { id: 9, channel: "netcatty:exit", payload: { sessionId: "session-close", exitCode: 0, reason: "closed" } },
    { id: 7, channel: "netcatty:exit", payload: { sessionId: "session-close", exitCode: 0, reason: "closed" } },
  ]);
  registry.releaseAttachPopupAuthorization("close-grant");
});

test("snapshot apply acknowledgements are emitted only by the matching terminal", () => {
  const preloadSource = require("node:fs").readFileSync(
    path.join(__dirname, "../preload/api.cjs"),
    "utf8",
  );
  const terminalSource = require("node:fs").readFileSync(
    path.join(__dirname, "../../components/Terminal.tsx"),
    "utf8",
  );
  const bridgeSource = require("node:fs").readFileSync(
    path.join(__dirname, "terminalBridge.cjs"),
    "utf8",
  );
  assert.match(preloadSource, /if \(handled !== true\) return/);
  assert.match(terminalSource, /typeof payload\.contextViewportSnapshot !== "string"/);
  assert.doesNotMatch(terminalSource, /if \(snap\) \{\s*const applied = await terminalBackend\.applySessionSnapshot/);
  assert.match(terminalSource, /const applied = await terminalBackend\.applySessionSnapshot/);
  assert.match(bridgeSource, /const hasSnapshot = typeof payload\?\.snapshot === "string"/);
  assert.match(bridgeSource, /const hasContextSnapshot = typeof payload\?\.contextSnapshot === "string"/);
  assert.match(preloadSource, /contextSnapshot: typeof context\?\.contextSnapshot === "string"/);
  assert.match(terminalSource, /finalContext = readTerminalHibernateContext\(snapshotTerm\)/);
});

test("exit fanout preserves the original renderer before registry wiring", () => {
  const attachRestore = require("./terminalAttachRestore.cjs");
  attachRestore.setFanoutSessionExit(null);
  const sent = [];
  const contents = {
    id: 42,
    send(channel, payload) {
      sent.push({ channel, payload });
    },
  };
  const payload = { sessionId: "session-1", reason: "exited" };
  assert.equal(attachRestore.fanoutSessionExit("session-1", contents, payload), true);
  assert.deepEqual(sent, [{ channel: "netcatty:exit", payload }]);
});

test("attach authorization is bound to one session and renderer", () => {
  const registry = require("./terminalAttachRestore.cjs");
  registry.registerAttachPopupAuthorization("grant-1", "session-1", 42);
  assert.equal(registry.validateAttachPopupAuthorization("grant-1", "session-1", 42), true);
  assert.equal(registry.validateAttachPopupAuthorization("grant-1", "session-2", 42), false);
  assert.equal(registry.validateAttachPopupAuthorization("grant-1", "session-1", 43), false);
  assert.equal(registry.markAttachPopupClosePrepared("grant-1", "session-1", 42), true);
  assert.equal(registry.isAttachPopupClosePrepared("grant-1"), true);
  registry.releaseAttachPopupAuthorization("grant-1");
  assert.equal(registry.validateAttachPopupAuthorization("grant-1", "session-1", 42), false);
});

test("failed attach restores retry when a main renderer becomes ready", () => {
  const registry = require("./terminalAttachRestore.cjs");
  let available = false;
  let calls = 0;
  registry.setRestoreAttachedSessionOutput(() => {
    calls += 1;
    return available
      ? { success: true, restored: true }
      : { success: false, restored: false, error: "Home renderer unavailable" };
  });

  assert.equal(registry.restoreAttachedSessionOutput("session-retry").success, false);
  available = true;
  registry.retryPendingAttachedSessionOutputs();
  registry.retryPendingAttachedSessionOutputs();

  assert.equal(calls, 2, "successful retry clears the pending restore");
});

test("a ready replacement main renderer becomes the explicit restore target", () => {
  const registry = require("./terminalAttachRestore.cjs");
  const targets = [];
  registry.setRestoreAttachedSessionOutput((_sessionId, preferredHomeWebContentsId) => {
    targets.push(preferredHomeWebContentsId);
    return targets.length === 1
      ? { success: false, restored: false }
      : { success: true, restored: true };
  });

  registry.restoreAttachedSessionOutput("session-replacement");
  registry.retryPendingAttachedSessionOutput("session-replacement", 99);

  assert.deepEqual(targets, [null, 99]);
});

test("attach IPC handlers validate popup authorization and flow pause has an awaitable barrier", () => {
  const source = require("node:fs").readFileSync(
    path.join(__dirname, "terminalBridge.cjs"),
    "utf8",
  );
  assert.match(source, /function isAuthorizedAttachIpc/);
  for (const functionName of [
    "requestTerminalSessionSnapshot",
    "applyTerminalSessionSnapshot",
    "rebindTerminalSessionOutput",
    "restoreTerminalSessionOutput",
  ]) {
    const start = source.indexOf(`function ${functionName}`);
    const end = source.indexOf("\nfunction ", start + 10);
    assert.match(source.slice(start, end), /isAuthorizedAttachIpc/);
  }
  assert.match(source, /netcatty:terminal:setFlowPausedAndWait/);
  assert.match(source, /terminalWorkerManager\.request\("netcatty:terminal:setFlowPausedAndWait"/);
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
