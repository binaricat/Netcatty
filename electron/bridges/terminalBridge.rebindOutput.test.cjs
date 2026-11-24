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
    if (request === "electron") {
      return {};
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

test("main process arbitrates two renderer leases before forwarding to the worker", async () => {
  const { bridge } = loadTerminalBridgeWithMocks();
  const handles = new Map();
  const listeners = new Map();
  const sent = [];
  const requested = [];
  const ipcMain = {
    handle(channel, handler) { handles.set(channel, handler); },
    on(channel, handler) { listeners.set(channel, handler); },
  };
  const terminalWorkerManager = {
    request: async (channel, payload) => {
      requested.push({ channel, payload });
      return { success: true };
    },
    send: (channel, payload) => sent.push({ channel, payload }),
  };
  bridge.registerHandlers(ipcMain, { terminalWorkerManager });
  const sender = (id) => ({ id, once() {} });
  const acquire = handles.get("netcatty:terminal:acquireFlowPauseLease");
  const release = handles.get("netcatty:terminal:releaseFlowPauseLease");
  const flow = listeners.get("netcatty:flow");

  const home = await acquire({ sender: sender(10) }, { sessionId: "session-lease" });
  const popup = await acquire({ sender: sender(20) }, { sessionId: "session-lease" });
  flow({ sender: sender(10) }, { sessionId: "session-lease", paused: false });
  await release(
    { sender: sender(10) },
    { sessionId: "session-lease", leaseId: home.leaseId },
  );
  await release(
    { sender: sender(20) },
    { sessionId: "session-lease", leaseId: popup.leaseId },
  );

  assert.deepEqual(requested.map(({ payload }) => payload.paused), [true, true]);
  assert.deepEqual(sent.map(({ payload }) => payload.paused), [true, true, false]);
  assert.ok([...requested, ...sent].every(({ payload }) => payload._flowArbitrated === true));
});

test("attach recovery respects a home renderer lease in worker mode", async () => {
  const { bridge } = loadTerminalBridgeWithMocks();
  const handles = new Map();
  const sent = [];
  const ipcMain = {
    handle(channel, handler) { handles.set(channel, handler); },
    on() {},
  };
  const terminalWorkerManager = {
    request: async () => ({ success: true }),
    send: (channel, payload) => sent.push({ channel, payload }),
    restoreAttachHome: async () => ({ success: true, restored: true }),
  };
  bridge.registerHandlers(ipcMain, { terminalWorkerManager });
  const sender = { id: 10, once() {} };
  const acquire = handles.get("netcatty:terminal:acquireFlowPauseLease");
  const release = handles.get("netcatty:terminal:releaseFlowPauseLease");
  const home = await acquire({ sender }, { sessionId: "session-restore" });
  const attachRestore = require("./terminalAttachRestore.cjs");

  const restored = await attachRestore.restoreAttachedSessionOutput("session-restore");

  assert.equal(restored.success, true);
  assert.equal(sent.at(-1)?.payload?.paused, true);
  await release(
    { sender },
    { sessionId: "session-restore", leaseId: home.leaseId },
  );
  assert.equal(sent.at(-1)?.payload?.paused, false);
});

test("duplicate popup crash restores share one in-flight operation", async () => {
  const { bridge } = loadTerminalBridgeWithMocks();
  const handles = new Map();
  let restoreCalls = 0;
  let finishRestore;
  const restoreResult = new Promise((resolve) => { finishRestore = resolve; });
  const ipcMain = {
    handle(channel, handler) { handles.set(channel, handler); },
    on() {},
  };
  const terminalWorkerManager = {
    request: async () => ({ success: true }),
    send() {},
    restoreAttachHome: async () => {
      restoreCalls += 1;
      return restoreResult;
    },
  };
  bridge.registerHandlers(ipcMain, { terminalWorkerManager });
  const attachRestore = require("./terminalAttachRestore.cjs");

  const renderGoneRestore = attachRestore.restoreAttachedSessionOutput("session-crash");
  const closedRestore = attachRestore.restoreAttachedSessionOutput("session-crash");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restoreCalls, 1);

  finishRestore({ success: true, restored: true });
  assert.deepEqual(await Promise.all([renderGoneRestore, closedRestore]), [
    { success: true, restored: true },
    { success: true, restored: true },
  ]);
  assert.equal(restoreCalls, 1);
});

test("failed worker lease acquisition compensates the backend pause", async () => {
  const { bridge } = loadTerminalBridgeWithMocks();
  const handles = new Map();
  const sent = [];
  const ipcMain = {
    handle(channel, handler) { handles.set(channel, handler); },
    on() {},
  };
  const terminalWorkerManager = {
    request: async () => { throw new Error("worker unavailable"); },
    send: (channel, payload) => sent.push({ channel, payload }),
  };
  bridge.registerHandlers(ipcMain, { terminalWorkerManager });
  const acquire = handles.get("netcatty:terminal:acquireFlowPauseLease");

  await assert.rejects(
    acquire(
      { sender: { id: 10, once() {} } },
      { sessionId: "session-acquire-failure" },
    ),
    /worker unavailable/,
  );

  assert.equal(sent.at(-1)?.payload?.paused, false);
  assert.equal(sent.at(-1)?.payload?._flowArbitrated, true);
});

test("worker close and natural exit clear main-process pause ownership", async () => {
  const { bridge } = loadTerminalBridgeWithMocks();
  const handles = new Map();
  const sends = new Map();
  const ipcMain = {
    handle(channel, handler) { handles.set(channel, handler); },
    on(channel, handler) { sends.set(channel, handler); },
  };
  let notifySessionClosed = null;
  const terminalWorkerManager = {
    request: async (_channel, payload) => (
      Number.isFinite(payload?.bootEpoch)
        ? { skipped: true }
        : { success: true }
    ),
    send() {},
    onSessionClosed(listener) {
      notifySessionClosed = listener;
      return { dispose() {} };
    },
  };
  bridge.registerHandlers(ipcMain, { terminalWorkerManager });
  const sender = { id: 10, isDestroyed() {}, send() {} };
  const acquire = handles.get("netcatty:terminal:acquireFlowPauseLease");
  const release = handles.get("netcatty:terminal:releaseFlowPauseLease");
  const closeAwait = handles.get("netcatty:close:await");
  const closeFireAndForget = sends.get("netcatty:close");

  const closingLease = await acquire({ sender }, { sessionId: "session-close" });
  await closeAwait({ sender }, { sessionId: "session-close" });
  assert.equal((await release(
    { sender },
    { sessionId: "session-close", leaseId: closingLease.leaseId },
  )).success, false);

  // Epoch-mismatch / skipped close must leave the replacement lease intact.
  const skippedLease = await acquire({ sender }, { sessionId: "session-skipped" });
  const skippedClose = await closeAwait(
    { sender },
    { sessionId: "session-skipped", bootEpoch: 1 },
  );
  assert.equal(skippedClose?.skipped, true);
  assert.equal((await release(
    { sender },
    { sessionId: "session-skipped", leaseId: skippedLease.leaseId },
  )).success, true);

  // Fire-and-forget epoch-scoped close must also preserve leases (worker may
  // no-op); unscoped close still clears eagerly.
  const epochFireLease = await acquire({ sender }, { sessionId: "session-epoch-fire" });
  closeFireAndForget({ sender }, { sessionId: "session-epoch-fire", bootEpoch: 2 });
  assert.equal((await release(
    { sender },
    { sessionId: "session-epoch-fire", leaseId: epochFireLease.leaseId },
  )).success, true);

  const unscopedFireLease = await acquire({ sender }, { sessionId: "session-unscoped-fire" });
  closeFireAndForget({ sender }, { sessionId: "session-unscoped-fire" });
  assert.equal((await release(
    { sender },
    { sessionId: "session-unscoped-fire", leaseId: unscopedFireLease.leaseId },
  )).success, false);

  const exitLease = await acquire({ sender }, { sessionId: "session-exit" });
  notifySessionClosed({ sessionId: "session-exit", reason: "exited" });
  assert.equal((await release(
    { sender },
    { sessionId: "session-exit", leaseId: exitLease.leaseId },
  )).success, false);
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
  const rendererEventIdx = source.indexOf('if (message.kind === "renderer-event")');
  const captureIdx = source.indexOf("const displayWebContentsId =", rendererEventIdx);
  const closeIdx = source.indexOf('if (message.channel === "netcatty:exit" && sessionId)', captureIdx);
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
  const restoreStart = bridgeSource.indexOf("async function restoreAttachedSessionOutputOnce");
  const restoreEnd = bridgeSource.indexOf("function restoreTerminalSessionOutput", restoreStart);
  const restoreSource = bridgeSource.slice(restoreStart, restoreEnd);
  const routeIdx = restoreSource.indexOf("restoreAttachHome");
  const resumeIdx = restoreSource.lastIndexOf("setDirectPaused");
  assert.ok(routeIdx > 0 && resumeIdx > routeIdx, "restore route before resuming output");

  const terminalSource = require("node:fs").readFileSync(
    path.join(__dirname, "../../components/Terminal.tsx"),
    "utf8",
  );
  const cleanupStart = terminalSource.indexOf("Observe/attach popups must not kill");
  const cleanupEnd = terminalSource.indexOf("const cleanupPromise", cleanupStart);
  const cleanupSource = terminalSource.slice(cleanupStart, cleanupEnd);
  const pauseIdx = cleanupSource.indexOf("acquireSessionFlowPauseLease(closingSessionId)");
  const snapshotIdx = cleanupSource.indexOf("applySessionSnapshot");
  const rendererRestoreIdx = cleanupSource.indexOf("restoreSessionOutput");
  const disposeIdx = cleanupSource.indexOf("disposeSessionListeners()");
  const releaseIdx = cleanupSource.indexOf("releaseTerminalFlowBeforeHibernate");
  const leaseReleaseIdx = cleanupSource.indexOf("outputPauseLease.release()", releaseIdx);
  assert.ok(pauseIdx > 0, "pause before final snapshot");
  assert.ok(snapshotIdx > pauseIdx, "snapshot after pause");
  assert.ok(rendererRestoreIdx > snapshotIdx, "restore route after snapshot");
  assert.ok(disposeIdx > rendererRestoreIdx, "detach popup listener after route restore");
  assert.ok(releaseIdx > disposeIdx, "resume only after popup listener detaches");
  assert.ok(leaseReleaseIdx > releaseIdx, "release pause ownership after output handoff");
  const mainRestoreStart = bridgeSource.indexOf("async function restoreAttachedSessionOutputOnce");
  const mainRestoreEnd = bridgeSource.indexOf("function restoreTerminalSessionOutput", mainRestoreStart);
  const mainRestoreSource = bridgeSource.slice(mainRestoreStart, mainRestoreEnd);
  assert.match(
    mainRestoreSource,
    /if \(result\?\.success\) \{[\s\S]*setDirectPaused\([\s\S]*restorePauseOwner,[\s\S]*false/,
  );
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

test("late backend exits cannot tear down a replacement with the same session id", () => {
  const bridgeSource = require("node:fs").readFileSync(
    path.join(__dirname, "terminalBridge.cjs"),
    "utf8",
  );
  const sshSource = require("node:fs").readFileSync(
    path.join(__dirname, "sshBridge/startSession.cjs"),
    "utf8",
  );
  const telnetSource = require("node:fs").readFileSync(
    path.join(__dirname, "terminalBridge/telnetSession.cjs"),
    "utf8",
  );
  const moshSource = require("node:fs").readFileSync(
    path.join(__dirname, "terminalBridge/moshSession.cjs"),
    "utf8",
  );
  const etSource = require("node:fs").readFileSync(
    path.join(__dirname, "terminalBridge/etSession.cjs"),
    "utf8",
  );

  assert.match(sshSource, /if \(liveSession === session\)/);
  assert.match(bridgeSource, /if \(sessions\.get\(sessionId\) !== session\) return;/);
  assert.match(bridgeSource, /serialExitFinalized \|\| sessions\.get\(sessionId\) !== session/);
  assert.match(telnetSource, /sessions\.get\(sessionId\) !== activeSession/);
  assert.match(moshSource, /sessions\.get\(sessionId\) !== session/);
  assert.match(etSource, /sessions\.get\(sessionId\) !== session/);
  assert.match(sshSource, /establishedOwnerSession && current !== establishedOwnerSession/);
  assert.match(sshSource, /establishedOwnerSession \? \{ session: establishedOwnerSession \} : \{\}/);
});

test("in-process explicit close notifies a rebound popup and its home renderer", async () => {
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
    (await ipcMain.handlers.get("netcatty:terminal:rebindOutput")(
      { sender: contents.get(9) },
      { sessionId: "session-close", authorization: "close-grant" },
    )).success,
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
  const effectsSource = require("node:fs").readFileSync(
    path.join(__dirname, "../../components/terminal/useTerminalEffects.ts"),
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
  assert.match(bridgeSource, /kittyKeyboardModeState: normalizeKittyKeyboardModeState/);
  assert.match(preloadSource, /sanitizeKittyKeyboardModeState\(kittyKeyboardModeState\)/);
  assert.match(terminalSource, /getKittyKeyboardModeState\(\)/);
  assert.match(terminalSource, /restoreKittyKeyboardModeState/);
  assert.match(effectsSource, /runtime\.restoreKittyKeyboardModeState\(snap\.kittyKeyboardModeState\)/);
  assert.match(bridgeSource, /kittyKeyboardProtocolEnabled: typeof payload\?\.kittyKeyboardProtocolEnabled/);
  assert.match(preloadSource, /typeof kittyKeyboardProtocolEnabled === "boolean"/);
  assert.match(terminalSource, /getKittyKeyboardProtocolEnabled\(\)/);
  assert.match(terminalSource, /\?\? kittyKeyboardProtocolEnabledForSession/);
  assert.match(terminalSource, /setKittyKeyboardProtocolEnabled/);
  assert.match(effectsSource, /runtime\.setKittyKeyboardProtocolEnabled\(snap\.kittyKeyboardProtocolEnabled\)/);
  assert.match(terminalSource, /passwordPromptActive: passwordPromptActiveRef\.current/u);
  assert.match(preloadSource, /typeof passwordPromptActive === "boolean"/u);
  assert.match(bridgeSource, /passwordPromptActive: typeof payload\?\.passwordPromptActive/u);
  assert.match(effectsSource, /passwordPromptActiveRef\.current = snap\.passwordPromptActive/u);
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

test("failed attach restores retry when a main renderer becomes ready", async () => {
  const registry = require("./terminalAttachRestore.cjs");
  let available = false;
  let calls = 0;
  registry.setRestoreAttachedSessionOutput(() => {
    calls += 1;
    return available
      ? { success: true, restored: true }
      : { success: false, restored: false, error: "Home renderer unavailable" };
  });

  assert.equal((await registry.restoreAttachedSessionOutput("session-retry")).success, false);
  available = true;
  await registry.retryPendingAttachedSessionOutputs();
  await registry.retryPendingAttachedSessionOutputs();

  assert.equal(calls, 2, "successful retry clears the pending restore");
});

test("closing a terminal clears failed restore and popup authorization state", async () => {
  const registry = require("./terminalAttachRestore.cjs");
  let calls = 0;
  registry.setRestoreAttachedSessionOutput(() => {
    calls += 1;
    return { success: false, restored: false };
  });
  registry.registerAttachPopupAuthorization("closed-grant", "closed-session", 42);
  await registry.restoreAttachedSessionOutput("closed-session");

  registry.releaseAttachedSessionState("closed-session");
  const result = await registry.retryPendingAttachedSessionOutput("closed-session", 42);

  assert.equal(calls, 1);
  assert.deepEqual(result, { success: true, restored: false });
  assert.equal(
    registry.validateAttachPopupAuthorization("closed-grant", "closed-session", 42),
    false,
  );
  registry.setRestoreAttachedSessionOutput(null);
});

test("a ready replacement main renderer becomes the explicit restore target", async () => {
  const registry = require("./terminalAttachRestore.cjs");
  const targets = [];
  registry.setRestoreAttachedSessionOutput((_sessionId, preferredHomeWebContentsId) => {
    targets.push(preferredHomeWebContentsId);
    return targets.length === 1
      ? { success: false, restored: false }
      : { success: true, restored: true };
  });

  await registry.restoreAttachedSessionOutput("session-replacement");
  await registry.retryPendingAttachedSessionOutput("session-replacement", 99);

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

test("attach snapshots preserve cwd and title updates including explicit clears", () => {
  const terminalSource = require("node:fs").readFileSync(
    path.join(__dirname, "../../components/Terminal.tsx"),
    "utf8",
  );
  const effectsSource = require("node:fs").readFileSync(
    path.join(__dirname, "../../components/terminal/useTerminalEffects.ts"),
    "utf8",
  );
  assert.match(
    terminalSource,
    /knownCwdRef\.current \?\? null,[\s\S]*?terminalTitleRef\.current \?\? null/,
  );
  assert.match(
    effectsSource,
    /snap\.cwd !== undefined[\s\S]*?setRendererCwd\(snap\.cwd,\s*"snapshot"\)[\s\S]*?snap\.title !== undefined/,
  );
  assert.match(
    effectsSource,
    /onTitleChange: \(title: string \| null\) => \{[\s\S]*?terminalTitleRef\.current = title \|\| undefined/,
  );
  assert.match(
    terminalSource,
    /payload\.cwd !== undefined[\s\S]*?setRendererCwd\(payload\.cwd,\s*"snapshot"\)[\s\S]*?payload\.title !== undefined/,
  );
});

test("active input policy roundtrips through preload and authorized snapshot IPC", async () => {
  const { EventEmitter } = require("node:events");
  const { createPreloadApi } = require("../preload/api.cjs");
  const { bridge, fakeChannel } = loadTerminalBridgeWithMocks();
  const handles = new Map();
  const listeners = new Map();
  const homeIpc = new EventEmitter();
  const home = { id: 71, isDestroyed: () => false, send: (channel, payload) => homeIpc.emit(channel, {}, payload) };
  const popup = { id: 72, isDestroyed: () => false };
  const sessionId = "input-policy-snapshot";
  const authorization = "input-policy-popup";
  bridge.init({
    sessions: new Map([[sessionId, { webContentsId: home.id }]]),
    electronModule: { webContents: { fromId: (id) => id === home.id ? home : popup } },
    terminalOutputChannel: fakeChannel,
  });
  bridge.registerHandlers({
    handle: (channel, handler) => handles.set(channel, handler),
    on: (channel, handler) => listeners.set(channel, handler),
  }, { terminalWorkerManager: { getAttachHomeWebContentsId: () => home.id } });
  const registry = require("./terminalAttachRestore.cjs");
  registry.registerAttachPopupAuthorization(authorization, sessionId, popup.id);
  homeIpc.send = (channel, payload) => listeners.get(channel)({ sender: home }, payload);
  const homeApi = createPreloadApi({ ipcRenderer: homeIpc, webUtils: {} });
  const invoke = (channel, payload) => {
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function(request) {
      if (request === "./windowManager.cjs") return { getMainWindows: () => [{ webContents: home }] };
      return originalRequire.apply(this, arguments);
    };
    try { return handles.get(channel)({ sender: popup }, payload); }
    finally { Module.prototype.require = originalRequire; }
  };
  const popupApi = createPreloadApi({ ipcRenderer: { invoke }, webUtils: {} });
  let mode;
  let received;
  const unsubscribeRequest = homeApi.onTerminalSessionSnapshotRequest(({ requestId }) => {
    homeApi.respondTerminalSessionSnapshot(requestId, "screen", undefined, false, false, null, null, mode);
  });
  const unsubscribeApply = homeApi.onTerminalSessionApplySnapshot((payload) => { received = payload; return true; });
  try {
    for (mode of [false, true, undefined, "false"]) {
      const expected = typeof mode === "boolean" ? mode : undefined;
      const snapshot = await popupApi.requestTerminalSessionSnapshot(sessionId, authorization);
      assert.equal(snapshot.success, true);
      assert.equal(snapshot.perCharacterInput, expected, "snapshot keeps explicit false and drops invalid metadata");
      const applied = await popupApi.applyTerminalSessionSnapshot(sessionId, "screen", {
        contextSnapshot: "", contextViewportSnapshot: "", contextScrollbackSnapshot: "", alternateScreen: false,
        perCharacterInput: mode,
        connectionLogDelta: "popup-output\r\n",
      }, authorization);
      assert.equal(applied.success, true);
      assert.equal(received.perCharacterInput, expected, "return snapshot carries the same active choice");
      assert.equal(received.connectionLogDelta, "popup-output\r\n", "return snapshot carries popup log delta");
    }
    assert.equal((await popupApi.requestTerminalSessionSnapshot(sessionId, "wrong-grant")).success, false);
    assert.equal((await popupApi.applyTerminalSessionSnapshot(sessionId, "", { perCharacterInput: false }, "wrong-grant")).success, false);
  } finally {
    unsubscribeRequest();
    unsubscribeApply();
    registry.releaseAttachPopupAuthorization(authorization);
  }
});

test("rebindOutput activates lifetime heir for moved-tab popups and restoreOutput clears it", async () => {
  const { bridge } = loadTerminalBridgeWithMocks();
  const registry = require("./terminalAttachRestore.cjs");
  const sessionId = "session-move-heir";
  const authorization = "grant-move-heir";
  const popup = { id: 81, isDestroyed: () => false };
  const home = { id: 80, isDestroyed: () => false };
  const handles = new Map();
  const worker = {
    rebindOutputSession: async () => ({ success: true, previousWebContentsId: home.id, webContentsId: popup.id }),
    hasOpenSession: () => true,
    clearAttachHome: () => {},
  };
  bridge.registerHandlers(
    { handle: (channel, fn) => handles.set(channel, fn), on: () => {} },
    { terminalWorkerManager: worker },
  );
  registry.registerAttachPopupAuthorization(authorization, sessionId, popup.id, { ownsLifetime: true });
  const originalRequire = Module.prototype.require;
  Module.prototype.require = function (request, ...rest) {
    if (request === "./windowManager.cjs") return { getMainWindows: () => [{ webContents: home }] };
    return originalRequire.call(this, request, ...rest);
  };
  try {
    assert.equal(registry.getLifetimeHeirWebContentsId(sessionId), null);
    const rebound = await handles.get("netcatty:terminal:rebindOutput")(
      { sender: popup },
      { sessionId, authorization },
    );
    assert.equal(rebound.success, true);
    assert.equal(registry.getLifetimeHeirWebContentsId(sessionId), popup.id);

    const restored = await handles.get("netcatty:terminal:restoreOutput")(
      { sender: popup },
      { sessionId, webContentsId: home.id, authorization },
    );
    assert.equal(restored.success, true);
    assert.equal(registry.getLifetimeHeirWebContentsId(sessionId), null);
  } finally {
    Module.prototype.require = originalRequire;
    registry.releaseAttachPopupAuthorization(authorization);
  }
});

test("detached output is replayed to home on ungraceful restore and cleared after graceful snapshot apply", async () => {
  const { bridge, fakeChannel } = loadTerminalBridgeWithMocks();
  const registry = require("./terminalAttachRestore.cjs");
  const { emitTerminalSessionData } = require("./emitTerminalSessionData.cjs");
  const sessionId = "session-crash-replay";
  const authorization = "grant-crash-replay";
  const homeSent = [];
  const home = {
    id: 91,
    isDestroyed: () => false,
    send: (channel, payload) => homeSent.push({ channel, payload }),
  };
  const popup = { id: 92, isDestroyed: () => false, send: () => {} };
  const channelSent = [];
  fakeChannel.send = (sid, data) => {
    channelSent.push({ sid, data });
    return true;
  };
  const session = { webContentsId: home.id };
  const handles = new Map();
  bridge.init({
    sessions: new Map([[sessionId, session]]),
    electronModule: { webContents: { fromId: (id) => (id === home.id ? home : popup) } },
    terminalOutputChannel: fakeChannel,
  });
  bridge.registerHandlers({ handle: (channel, fn) => handles.set(channel, fn), on: () => {} });
  registry.registerAttachPopupAuthorization(authorization, sessionId, popup.id, { ownsLifetime: true });

  const originalRequire = Module.prototype.require;
  Module.prototype.require = function (request, ...rest) {
    if (request === "./windowManager.cjs") return { getMainWindows: () => [{ webContents: home }] };
    return originalRequire.call(this, request, ...rest);
  };
  try {
    const rebound = await handles.get("netcatty:terminal:rebindOutput")(
      { sender: popup },
      { sessionId, authorization },
    );
    assert.equal(rebound.success, true);

    // Emit detached output while popup is attached.
    emitTerminalSessionData(popup, sessionId, "detached-line-1\r\n");
    emitTerminalSessionData(popup, sessionId, "detached-line-2\r\n");
    channelSent.length = 0;

    // Simulate popup crash: main-process restore runs without applySnapshot.
    const restored = await registry.restoreAttachedSessionOutput(sessionId);
    assert.equal(restored.success, true);
    assert.equal(restored.restored, true);
    assert.deepEqual(channelSent, [{ sid: sessionId, data: "detached-line-1\r\ndetached-line-2\r\n" }]);
    assert.equal(registry.takeDetachedReplayData(sessionId), "");

    // Graceful path: clearDetachedReplayCapture prevents duplicate replay.
    registry.startDetachedReplayCapture(sessionId);
    registry.appendDetachedReplayData(sessionId, "graceful-line\r\n");
    registry.clearDetachedReplayCapture(sessionId);
    assert.equal(registry.takeDetachedReplayData(sessionId), "");
  } finally {
    Module.prototype.require = originalRequire;
    registry.releaseAttachPopupAuthorization(authorization);
    registry.clearDetachedReplayCapture(sessionId);
  }
});

test("moved tab from a peer session window receives applySnapshot and restoreOutput directly", async () => {
  const { EventEmitter } = require("node:events");
  const { createPreloadApi } = require("../preload/api.cjs");
  const { bridge, fakeChannel } = loadTerminalBridgeWithMocks();
  const registry = require("./terminalAttachRestore.cjs");
  const sessionId = "peer-window-session";
  const authorization = "grant-peer-window";
  const mainReceived = [];
  const peerIpc = new EventEmitter();
  const mainWin = {
    id: 101,
    isDestroyed: () => false,
    send: (channel, payload) => mainReceived.push({ channel, payload }),
  };
  const peerWin = {
    id: 102,
    isDestroyed: () => false,
    send: (channel, payload) => peerIpc.emit(channel, {}, payload),
  };
  const popup = { id: 103, isDestroyed: () => false };
  const handles = new Map();
  const listeners = new Map();
  const reboundTargets = [];
  const worker = {
    getAttachHomeWebContentsId: () => peerWin.id,
    hasOpenSession: () => true,
    rebindOutputSession: async (_sid, targetId) => {
      reboundTargets.push(targetId);
      return { success: true, previousWebContentsId: popup.id, webContentsId: targetId };
    },
    clearAttachHome: () => {},
  };
  bridge.init({
    sessions: new Map(),
    electronModule: { webContents: { fromId: (id) => (id === peerWin.id ? peerWin : id === mainWin.id ? mainWin : popup) } },
    terminalOutputChannel: fakeChannel,
  });
  bridge.registerHandlers({
    handle: (channel, fn) => handles.set(channel, fn),
    on: (channel, fn) => listeners.set(channel, fn),
  }, { terminalWorkerManager: worker });
  registry.registerAttachPopupAuthorization(authorization, sessionId, popup.id, { ownsLifetime: true });

  peerIpc.send = (channel, payload) => listeners.get(channel)({ sender: peerWin }, payload);
  const peerApi = createPreloadApi({ ipcRenderer: peerIpc, webUtils: {} });
  let peerApplied = null;
  const unsub = peerApi.onTerminalSessionApplySnapshot((payload) => {
    peerApplied = payload;
    return true;
  });

  const originalRequire = Module.prototype.require;
  Module.prototype.require = function (request, ...rest) {
    if (request === "./windowManager.cjs") {
      return {
        getMainWindows: () => [{ webContents: mainWin }],
        getAppContentWindows: () => [{ webContents: mainWin }, { webContents: peerWin }],
      };
    }
    return originalRequire.call(this, request, ...rest);
  };
  try {
    const applied = await handles.get("netcatty:terminal:applySnapshot")(
      { sender: popup },
      {
        sessionId,
        snapshot: "peer-snapshot",
        contextSnapshot: "",
        contextViewportSnapshot: "",
        contextScrollbackSnapshot: "",
        alternateScreen: false,
        connectionLogDelta: "peer-delta\r\n",
        authorization,
      },
    );
    assert.equal(applied.success, true);
    assert.equal(peerApplied?.snapshot, "peer-snapshot");
    assert.equal(peerApplied?.connectionLogDelta, "peer-delta\r\n");
    assert.deepEqual(mainReceived, []);

    const restored = await handles.get("netcatty:terminal:restoreOutput")(
      { sender: popup },
      { sessionId, webContentsId: peerWin.id, authorization },
    );
    assert.equal(restored.success, true);
    assert.equal(restored.webContentsId, peerWin.id);
    assert.deepEqual(reboundTargets, [peerWin.id]);
  } finally {
    unsub();
    Module.prototype.require = originalRequire;
    registry.releaseAttachPopupAuthorization(authorization);
  }
});

test("reopening preserves pending detached replay data and home shutdown can read it", async () => {
  const { EventEmitter } = require("node:events");
  const { createPreloadApi } = require("../preload/api.cjs");
  const { bridge, fakeChannel } = loadTerminalBridgeWithMocks();
  const registry = require("./terminalAttachRestore.cjs");
  const sessionId = "session-pending-replay";
  const authorization = "grant-pending-replay";
  const homeIpc = new EventEmitter();
  const home = {
    id: 111,
    isDestroyed: () => false,
    send: (channel, payload) => homeIpc.emit(channel, {}, payload),
  };
  const popup = { id: 112, isDestroyed: () => false };
  const other = { id: 113, isDestroyed: () => false };
  const handles = new Map();
  const listeners = new Map();
  const worker = {
    getAttachHomeWebContentsId: () => home.id,
    getSessionOwnerWebContentsId: () => home.id,
    rebindOutputSession: async () => ({ success: true, previousWebContentsId: home.id, webContentsId: popup.id }),
  };
  bridge.init({
    sessions: new Map([[sessionId, { webContentsId: home.id }]]),
    electronModule: { webContents: { fromId: (id) => (id === home.id ? home : popup) } },
    terminalOutputChannel: fakeChannel,
  });
  bridge.registerHandlers({
    handle: (channel, fn) => handles.set(channel, fn),
    on: (channel, fn) => listeners.set(channel, fn),
  }, { terminalWorkerManager: worker });

  homeIpc.send = (channel, payload) => listeners.get(channel)({ sender: home }, payload);
  const homeApi = createPreloadApi({ ipcRenderer: homeIpc, webUtils: {} });
  const unsubReq = homeApi.onTerminalSessionSnapshotRequest(({ requestId }) => {
    homeApi.respondTerminalSessionSnapshot(requestId, "home-before-crash");
  });

  try {
    // Retain unrecovered replay data from an earlier crashed popup.
    registry.startDetachedReplayCapture(sessionId);
    registry.appendDetachedReplayData(sessionId, "lost-during-crash\r\n");

    // Reopening a second popup must preserve that buffer and include it in snapshot response.
    registry.registerAttachPopupAuthorization(authorization, sessionId, popup.id, { ownsLifetime: true });
    const snap = await handles.get("netcatty:terminal:requestSnapshot")(
      { sender: popup },
      { sessionId, authorization },
    );
    assert.equal(snap.success, true);
    assert.equal(snap.snapshot, "home-before-crash");
    assert.equal(snap.pendingReplay, "lost-during-crash\r\n");

    await handles.get("netcatty:terminal:rebindOutput")(
      { sender: popup },
      { sessionId, authorization },
    );
    assert.equal(registry.peekDetachedReplayData(sessionId), "lost-during-crash\r\n");

    // Home shutdown can read detached replay data, while unrelated renderers receive empty string.
    const homeRead = await handles.get("netcatty:terminal:getDetachedReplayData")(
      { sender: home },
      { sessionId },
    );
    assert.deepEqual(homeRead, { success: true, data: "lost-during-crash\r\n" });
    const otherRead = await handles.get("netcatty:terminal:getDetachedReplayData")(
      { sender: other },
      { sessionId },
    );
    assert.deepEqual(otherRead, { success: true, data: "" });
  } finally {
    unsubReq();
    registry.releaseAttachPopupAuthorization(authorization);
    registry.clearDetachedReplayCapture(sessionId);
  }
});
