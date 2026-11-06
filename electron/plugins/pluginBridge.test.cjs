"use strict";

const assert = require("node:assert/strict");
const { mkdtemp, rename, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const {
  CHANNELS,
  createTrustedPluginBridgeSender,
  registerPluginBridge,
  normalizePluginScopeCatalog,
} = require("./pluginBridge.cjs");

function createIpcMain() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handlers,
    listeners,
    handle(channel, handler) { handlers.set(channel, handler); },
    on(channel, listener) {
      const list = listeners.get(channel) ?? [];
      list.push(listener);
      listeners.set(channel, list);
    },
  };
}

test("plugin management bridge is unavailable unless the local development gate is explicit", async () => {
  const ipcMain = createIpcMain();
  registerPluginBridge(ipcMain, {
    manager: null,
    env: {},
    isTrustedSender: () => true,
  });
  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.status)({}), {
    available: false,
    experimental: true,
  });
  await assert.rejects(ipcMain.handlers.get(CHANNELS.list)({}), /runtime is disabled/);
});

test("disabled plugin runtime keeps passive host integration channels quiet", async () => {
  const ipcMain = createIpcMain();
  registerPluginBridge(ipcMain, {
    manager: null,
    env: {},
    isTrustedSender: () => true,
  });

  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.terminalProviders)({}, {}), []);
  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.terminalSessionEvent)({}, {}), []);
  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.extensionProviders)({}, {}), []);
  assert.equal(await ipcMain.handlers.get(CHANNELS.credentialCatalogUpdate)({}, { entries: [] }), 0);
  assert.equal(await ipcMain.handlers.get(CHANNELS.setScopeCatalog)({}, {}), null);
  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.getScopeCatalog)({}, {}), {
    workspace: [],
    host: [],
    session: [],
    device: [{ id: "device", label: "This device" }],
  });
});

test("plugin management bridge fails closed when the host manager is unavailable", async () => {
  const ipcMain = createIpcMain();
  registerPluginBridge(ipcMain, {
    manager: null,
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.status)({}), {
    available: false,
    experimental: true,
  });
  await assert.rejects(ipcMain.handlers.get(CHANNELS.list)({}), /disabled or unavailable/);
});

test("plugin management bridge checks sender ownership before invoking manager", async () => {
  const calls = [];
  const ipcMain = createIpcMain();
  registerPluginBridge(ipcMain, {
    manager: {
      initialize: async () => {},
      list: async () => [],
      install: async (...args) => calls.push(args),
      setEnabled: async () => null,
      restart: async () => null,
      uninstall: async () => true,
    },
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: createTrustedPluginBridgeSender({ devServerUrl: "http://localhost:5173" }),
  });
  const trusted = { senderFrame: { url: "app://netcatty/index.html" } };
  await ipcMain.handlers.get(CHANNELS.install)(trusted, { archivePath: "/plugin.ncpkg", enable: true });
  assert.deepEqual(calls, [["/plugin.ncpkg", { enable: true }]]);
  await assert.rejects(
    ipcMain.handlers.get(CHANNELS.list)({ senderFrame: { url: "https://attacker.invalid/" } }),
    /Untrusted/,
  );
});

test("plugin bridge refuses embedded frames even at an app URL", () => {
  const trusted = createTrustedPluginBridgeSender({ devServerUrl: "http://localhost:5173" });
  const mainFrame = { url: "http://localhost:5173/" };
  const sender = { mainFrame };
  assert.equal(trusted({ sender, senderFrame: mainFrame }), true);
  assert.equal(trusted({ sender, senderFrame: { url: mainFrame.url } }), false);
  assert.equal(trusted({ sender, senderFrame: null }), false);
});

test("author presentation is a trusted-app-only route and forwards no invented authority", async () => {
  const ipcMain = createIpcMain(); const calls = [];
  registerPluginBridge(ipcMain, { manager: { initialize: async () => {} }, isTrustedSender: createTrustedPluginBridgeSender({ devServerUrl: "http://localhost:5173" }),
    catalogService: { author: async (request) => { calls.push(request); return { author: "Netcatty", avatar: null, officialMaintained: false }; } } });
  const payload = { kind: "catalog", pluginId: "com.netcatty.starter", selectionToken: "a".repeat(64), sourceId: "official" };
  for (const url of ["netcatty-plugin://plugin-runtime/index.html", "https://attacker.invalid/"]) {
    await assert.rejects(ipcMain.handlers.get(CHANNELS.author)({ senderFrame: { url } }, payload), /Untrusted/);
  }
  assert.deepEqual(calls, []);
  const result = await ipcMain.handlers.get(CHANNELS.author)({ senderFrame: { url: "app://netcatty/index.html" } }, payload);
  assert.equal(result.officialMaintained, false); assert.deepEqual(calls, [payload]);
});

test("plugin Vault credential catalog updates only through the trusted host bridge", async () => {
  const ipcMain = createIpcMain();
  const updates = [];
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    credentialResolver: {
      update(entries) { updates.push(entries); return entries.length; },
    },
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: (event) => event?.trusted === true,
  });
  const entries = [{ id: "credential-reference-0001", ciphertext: "enc:v1:Y2lwaGVy" }];
  assert.equal(await ipcMain.handlers.get(CHANNELS.credentialCatalogUpdate)(
    { trusted: true },
    { entries },
  ), 1);
  assert.deepEqual(updates, [entries]);
  await assert.rejects(
    ipcMain.handlers.get(CHANNELS.credentialCatalogUpdate)({ trusted: false }, { entries }),
    /Untrusted/i,
  );
});

test("plugin management availability follows asynchronous host initialization", async () => {
  const ipcMain = createIpcMain();
  let listCalls = 0;
  const initializationError = new Error("package recovery failed");
  registerPluginBridge(ipcMain, {
    manager: {
      initialize: async () => { throw initializationError; },
      list: async () => { listCalls += 1; return []; },
    },
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });

  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.status)({}), {
    available: false,
    experimental: true,
  });
  await assert.rejects(ipcMain.handlers.get(CHANNELS.list)({}), (error) => (
    error.message.includes("disabled or unavailable") && error.cause === initializationError
  ));
  assert.equal(listCalls, 0);
});

test("plugin view events are routed with their owning sender and never globally broadcast", async () => {
  const ipcMain = createIpcMain(); const calls = []; const broadcasts = []; const sender = {};
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} }, contributionService: {},
    hostDrawnViewHost: { event: async (...args) => calls.push(args) },
    isTrustedSender: () => true, broadcast: (...args) => broadcasts.push(args),
  });
  const event = { nodeId: "button", type: "click" };
  await ipcMain.handlers.get(CHANNELS.hostDrawnEvent)({ sender }, { instanceId: "view-1", event });
  assert.deepEqual(calls, [["view-1", event, sender]]); assert.deepEqual(broadcasts, []);
});

test("plugin contribution icon requests use the host-owned resolver", async () => {
  const ipcMain = createIpcMain();
  const calls = [];
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    resolveContributionIcon: async (payload) => {
      calls.push(payload);
      return { light: "data:image/png;base64,bGlnaHQ=" };
    },
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const payload = {
    pluginId: "com.example.icon",
    icon: { kind: "package", light: "assets/icon.png" },
  };

  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.contributionIcon)({}, payload), {
    light: "data:image/png;base64,bGlnaHQ=",
  });
  assert.deepEqual(calls, [payload]);
});

test("plugin setting scope catalogs are bounded, sender-owned, and merged for settings windows", async () => {
  assert.deepEqual(normalizePluginScopeCatalog({
    host: [{ id: "host-1", label: "Production" }, { id: "host-1", label: "Duplicate" }],
    workspace: [{ id: "", label: "Invalid" }],
  }), {
    workspace: [],
    host: [{ id: "host-1", label: "Production" }],
    session: [],
    device: [],
  });

  const ipcMain = createIpcMain();
  const broadcasts = [];
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
    broadcast: (...args) => broadcasts.push(args),
  });
  let firstDestroyed;
  const first = {
    sender: {
      id: 1,
      once: (event, listener) => { if (event === "destroyed") firstDestroyed = listener; },
    },
  };
  const second = { sender: { id: 2, once() {} } };
  const settingsWindow = { sender: { id: 3, once() {} } };
  const next = { host: [{ id: "host-1", label: "Production" }] };
  await ipcMain.handlers.get(CHANNELS.setScopeCatalog)(first, next);
  await ipcMain.handlers.get(CHANNELS.setScopeCatalog)(second, {
    workspace: [{ id: "workspace-2", label: "Second window" }],
    host: [{ id: "host-1", label: "Duplicate from second window" }],
  });
  const merged = {
    workspace: [{ id: "workspace-2", label: "Second window" }],
    host: [{ id: "host-1", label: "Production" }],
    session: [],
    device: [{ id: "device", label: "This device" }],
  };
  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.getScopeCatalog)(first), merged);
  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.getScopeCatalog)(second), merged);
  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.getScopeCatalog)(settingsWindow), merged);
  assert.deepEqual(broadcasts.at(-1), [CHANNELS.scopeCatalogChanged, merged]);
  firstDestroyed();
  const afterFirstWindowClosed = {
    workspace: [{ id: "workspace-2", label: "Second window" }],
    host: [{ id: "host-1", label: "Duplicate from second window" }],
    session: [],
    device: [{ id: "device", label: "This device" }],
  };
  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.getScopeCatalog)(settingsWindow), afterFirstWindowClosed);
  assert.deepEqual(broadcasts.at(-1), [CHANNELS.scopeCatalogChanged, afterFirstWindowClosed]);
});

test("plugin terminal Provider bridge owns cancellation by renderer sender", async () => {
  const ipcMain = createIpcMain();
  const calls = [];
  const pipelineCalls = [];
  let destroyed;
  const terminalProviderService = {
    listProviders(options) {
      calls.push(["list", options]);
      return [{ provider: { id: "com.example.completion" } }];
    },
    async provide(request, options) {
      calls.push(["provide", request]);
      return new Promise((resolve) => {
        options.signal.addEventListener("abort", () => resolve([{ status: "cancelled" }]), { once: true });
      });
    },
    async publishSessionEvent(event) {
      calls.push(["event", event]);
      return [{ pluginId: "com.example", delivered: true }];
    },
  };
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    terminalProviderService,
    terminalDataPipelineService: {
      async handleSessionEvent(payload, options) {
        pipelineCalls.push([payload, options]);
        return [{ direction: "input", attached: true }];
      },
    },
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = {
    sender: {
      id: 42,
      once(name, listener) { if (name === "destroyed") destroyed = listener; },
    },
  };

  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.terminalProviders)(event, {
    kind: "terminal.completion",
  }), [{ provider: { id: "com.example.completion" } }]);
  const pending = ipcMain.handlers.get(CHANNELS.terminalProvide)(event, {
    requestId: "renderer-request-1",
    kind: "terminal.completion",
    operation: "provideCompletions",
    session: { sessionId: "session-1" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await ipcMain.handlers.get(CHANNELS.terminalCancel)(event, {
    requestId: "renderer-request-1",
  }), true);
  assert.deepEqual(await pending, [{ status: "cancelled" }]);
  assert.equal(await ipcMain.handlers.get(CHANNELS.terminalCancel)(event, {
    requestId: "renderer-request-1",
  }), false);
  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.terminalSessionEvent)(event, {
    type: "created",
    session: { sessionId: "session-1" },
  }), [{ pluginId: "com.example", delivered: true }]);
  assert.deepEqual(pipelineCalls, [[
    { type: "created", session: { sessionId: "session-1" } },
    { webContentsId: 42 },
  ]]);
  assert.equal(typeof destroyed, "function");
  const destroyedPending = ipcMain.handlers.get(CHANNELS.terminalProvide)(event, {
    requestId: "renderer-request-destroyed",
    kind: "terminal.completion",
    operation: "provideCompletions",
    session: { sessionId: "session-1" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  destroyed();
  assert.deepEqual(await destroyedPending, [{ status: "cancelled" }]);
  assert.deepEqual(calls, [
    ["list", { kind: "terminal.completion" }],
    ["provide", {
      kind: "terminal.completion",
      operation: "provideCompletions",
      session: { sessionId: "session-1" },
    }],
    ["event", { type: "created", session: { sessionId: "session-1" } }],
    ["provide", {
      kind: "terminal.completion",
      operation: "provideCompletions",
      session: { sessionId: "session-1" },
    }],
  ]);
});

test("plugin terminal Provider bridge releases cancellation during host initialization", async () => {
  const ipcMain = createIpcMain();
  let releaseInitialization;
  let initializationStarted;
  const started = new Promise((resolve) => { initializationStarted = resolve; });
  const initialization = new Promise((resolve) => { releaseInitialization = resolve; });
  const observedSignals = [];
  registerPluginBridge(ipcMain, {
    manager: {
      async initialize() {
        initializationStarted();
        await initialization;
      },
    },
    terminalProviderService: {
      async provide(_request, options) {
        observedSignals.push(options.signal);
        return [{ status: options.signal.aborted ? "cancelled" : "ok" }];
      },
    },
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = { sender: { id: 84, once() {} } };
  const pending = ipcMain.handlers.get(CHANNELS.terminalProvide)(event, {
    requestId: "cancel-during-initialize",
    kind: "terminal.completion",
    operation: "provideCompletions",
    session: { sessionId: "session-1" },
  });
  await started;
  assert.equal(await ipcMain.handlers.get(CHANNELS.terminalCancel)(event, {
    requestId: "cancel-during-initialize",
  }), true);
  await assert.rejects(pending, (error) => error?.name === "AbortError");
  assert.equal(observedSignals.length, 0);
  releaseInitialization();
  const retry = await ipcMain.handlers.get(CHANNELS.terminalProvide)(event, {
    requestId: "after-cancelled-initialize",
    kind: "terminal.completion",
    operation: "provideCompletions",
    session: { sessionId: "session-1" },
  });
  assert.deepEqual(retry, [{ status: "ok" }]);
  assert.equal(observedSignals.length, 1);
  assert.equal(observedSignals[0].aborted, false);
});

test("plugin extension Provider requests are cancellable and sender-owned", async () => {
  const ipcMain = createIpcMain();
  let destroyed;
  const calls = [];
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    extensionProviderService: {
      async invoke(payload, options) {
        calls.push(payload);
        return new Promise((resolve) => {
          options.signal.addEventListener("abort", () => resolve({ cancelled: true }), { once: true });
        });
      },
    },
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = {
    sender: {
      id: 73,
      once(name, listener) { if (name === "destroyed") destroyed = listener; },
    },
  };
  const pending = ipcMain.handlers.get(CHANNELS.extensionInvoke)(event, {
    requestId: "extension-request-1",
    providerId: "com.example.transport.connection",
    kind: "connection",
    operation: "probe",
    payload: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await ipcMain.handlers.get(CHANNELS.extensionCancel)(event, {
    requestId: "extension-request-1",
  }), true);
  assert.deepEqual(await pending, { cancelled: true });
  assert.equal(await ipcMain.handlers.get(CHANNELS.extensionCancel)(event, {
    requestId: "extension-request-1",
  }), false);
  assert.equal(typeof destroyed, "function");
  assert.equal(calls.length, 1);
});

test("generic extension invocation cannot bypass authentication or connection-session ownership", async () => {
  const ipcMain = createIpcMain();
  let calls = 0;
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    extensionProviderService: {
      async invoke() { calls += 1; return null; },
    },
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const invoke = ipcMain.handlers.get(CHANNELS.extensionInvoke);
  const event = { sender: { once() {}, id: 41 } };
  await assert.rejects(invoke(event, {
    requestId: "auth-bypass",
    kind: "authentication",
    providerId: "com.example.auth.provider",
    operation: "respond",
    payload: { response: "plaintext" },
  }), /dedicated host workflow/i);
  await assert.rejects(invoke(event, {
    requestId: "connection-bypass",
    kind: "connection",
    providerId: "com.example.connection.provider",
    operation: "close",
    payload: { connectionId: "not-owned" },
  }), /dedicated host workflow/i);
  assert.equal(calls, 0);
});

test("plugin importer files use sender-owned native selections and bounded streaming", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "netcatty-plugin-importer-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "hosts.json");
  await writeFile(filePath, "streamed-import");
  const parsed = [];
  const ipcMain = createIpcMain();
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    extensionProviderService: {
      async parseImporter(params, options) {
        for await (const chunk of params.source) parsed.push(Buffer.from(chunk));
        assert.equal(params.sourceByteLength, 15);
        assert.equal(params.fileName, "hosts.json");
        options.onProgress({ type: "progress", completed: 1, total: 2, message: "Reading" });
        return { providerId: params.providerId, result: { parsed: 0, warnings: 0, errors: 0 }, records: [] };
      },
    },
    selectImporterFile: async () => filePath,
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const progressEvents = [];
  const first = { sender: {
    id: 1,
    once() {},
    isDestroyed: () => false,
    send(channel, payload) { progressEvents.push([channel, payload]); },
  } };
  const second = { sender: { id: 2, once() {} } };
  const selection = await ipcMain.handlers.get(CHANNELS.importerSelectFile)(first, {});
  assert.equal(selection.fileName, "hosts.json");
  assert.equal(Buffer.from(selection.sample).toString(), "streamed-import");
  await assert.rejects(ipcMain.handlers.get(CHANNELS.importerParseFile)(second, {
    requestId: "other-window",
    providerId: "com.example.importer",
    selectionToken: selection.selectionToken,
  }), /selection expired/i);
  await rename(filePath, `${filePath}.selected`);
  await writeFile(filePath, "path-replaced!!");
  const preview = await ipcMain.handlers.get(CHANNELS.importerParseFile)(first, {
    requestId: "owner-window",
    providerId: "com.example.importer",
    selectionToken: selection.selectionToken,
  });
  assert.equal(preview.providerId, "com.example.importer");
  assert.equal(Buffer.concat(parsed).toString(), "streamed-import");
  assert.deepEqual(progressEvents, [[CHANNELS.importerProgress, {
    requestId: "owner-window",
    providerId: "com.example.importer",
    progress: { type: "progress", completed: 1, total: 2, message: "Reading" },
  }]]);
  await assert.rejects(ipcMain.handlers.get(CHANNELS.importerParseFile)(first, {
    requestId: "replay",
    providerId: "com.example.importer",
    selectionToken: selection.selectionToken,
  }), /selection expired/i);
});

test("plugin connection authentication uses host-rendered sender-owned challenges", async () => {
  const ipcMain = createIpcMain();
  const sent = [];
  const calls = [];
  const external = [];
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    extensionProviderService: {
      async authenticate(params, requestChallenge) {
        calls.push(["authenticate", params]);
        const response = await requestChallenge({
          id: "password-1",
          kind: "password",
          title: "Password",
        });
        calls.push(["response", response]);
        return {
          status: "authenticated",
          credential: { kind: "credential", id: "credential-after-auth" },
        };
      },
      async openConnection(params, options) {
        calls.push(["open", params]);
        await options.onData(Uint8Array.from([0xe2]));
        await options.onData(Uint8Array.from([0x82, 0xac]));
        return { sessionId: params.sessionId, providerId: params.providerId, status: "connected", diagnostics: [] };
      },
      closeSessionLocal() {},
    },
    getTerminalWorkerManager: () => ({
      async startExternalSession(options) { external.push(["start", options]); return { sessionId: options.sessionId }; },
      async pushExternalOutput(sessionId, data) { external.push(["output", sessionId, data]); },
      async finishExternalSession(sessionId, details) { external.push(["finish", sessionId, details]); },
    }),
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = {
    sender: {
      id: 74,
      once() {},
      isDestroyed: () => false,
      send(channel, payload) { sent.push([channel, payload]); },
    },
  };
  const pending = ipcMain.handlers.get(CHANNELS.connectionStart)(event, {
    requestId: "connection-auth-1",
    sessionId: "session-auth-1",
    providerId: "com.example.transport.connection",
    authenticationProviderId: "com.example.transport.authentication",
    configuration: { host: "example.test" },
    hostLabel: "Example transport",
    hostname: "example.test",
    columns: 80,
    rows: 24,
    sessionLog: {
      enabled: true,
      directory: "/logs",
      format: "html",
      timestampsEnabled: true,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], CHANNELS.authenticationChallenge);
  const challengeEvent = sent[0][1];
  await assert.rejects(
    ipcMain.handlers.get(CHANNELS.authenticationRespond)({ sender: { id: 75, once() {} } }, {
      ...challengeEvent,
      challengeId: challengeEvent.challenge.id,
      response: "stolen",
    }),
    /not owned/,
  );
  await ipcMain.handlers.get(CHANNELS.authenticationRespond)(event, {
    requestId: challengeEvent.requestId,
    challengeRequestId: challengeEvent.challengeRequestId,
    challengeId: challengeEvent.challenge.id,
    response: "secret answer",
  });
  assert.deepEqual(await pending, {
    sessionId: "session-auth-1",
    providerId: "com.example.transport.connection",
    status: "connected",
    diagnostics: [],
  });
  assert.deepEqual(calls[0], ["authenticate", {
    providerId: "com.example.transport.authentication",
    connectionProviderId: "com.example.transport.connection",
    configuration: { host: "example.test" },
  }]);
  assert.deepEqual(calls[1], ["response", "secret answer"]);
  assert.deepEqual(calls[2][0], "open");
  assert.deepEqual(calls[2][1].credential, {
    kind: "credential",
    id: "credential-after-auth",
  });
  assert.equal(external[0][0], "start");
  assert.deepEqual({
    sessionId: external[0][1].sessionId,
    hostLabel: external[0][1].hostLabel,
    hostname: external[0][1].hostname,
    sessionLog: external[0][1].sessionLog,
  }, {
    sessionId: "session-auth-1",
    hostLabel: "Example transport",
    hostname: "example.test",
    sessionLog: {
      enabled: true,
      directory: "/logs",
      format: "html",
      timestampsEnabled: true,
    },
  });
  assert.deepEqual(external[1], ["output", "session-auth-1", "€"]);
});

test("plugin authentication cancellation removes the queued renderer challenge", async () => {
  const ipcMain = createIpcMain();
  const sent = [];
  const external = [];
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    extensionProviderService: {
      async authenticate(_params, requestChallenge) {
        await requestChallenge({
          id: "password-cancel",
          kind: "password",
          title: "Password",
        });
        throw new Error("authentication should not continue after cancellation");
      },
      async openConnection() {
        throw new Error("connection should not open after cancellation");
      },
      closeSessionLocal(sessionId) { external.push(["close-local", sessionId]); },
    },
    getTerminalWorkerManager: () => ({
      async startExternalSession(options) { external.push(["start", options.sessionId]); return { sessionId: options.sessionId }; },
      async finishExternalSession(sessionId, details) { external.push(["finish", sessionId, details.reason]); },
    }),
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = {
    sender: {
      id: 76,
      once() {},
      isDestroyed: () => false,
      send(channel, payload) { sent.push([channel, payload]); },
    },
  };
  const pending = ipcMain.handlers.get(CHANNELS.connectionStart)(event, {
    requestId: "connection-auth-cancel-1",
    sessionId: "session-auth-cancel-1",
    providerId: "com.example.transport.connection",
    authenticationProviderId: "com.example.transport.authentication",
    configuration: { host: "example.test" },
    hostLabel: "Example transport",
    hostname: "example.test",
    columns: 80,
    rows: 24,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], CHANNELS.authenticationChallenge);
  const challengeEvent = sent[0][1];

  assert.equal(await ipcMain.handlers.get(CHANNELS.extensionCancel)(event, {
    requestId: "connection-auth-cancel-1",
  }), true);
  await assert.rejects(pending, /abort|cancel/i);

  assert.deepEqual(sent[1], [CHANNELS.authenticationChallenge, {
    requestId: "connection-auth-cancel-1",
    challengeRequestId: challengeEvent.challengeRequestId,
    challengeId: "password-cancel",
    cancelled: true,
  }]);
  assert.deepEqual(external.at(-1), ["finish", "session-auth-cancel-1", "error"]);
});

test("plugin connection status monitoring releases readiness then keeps polling later failures", async () => {
  const ipcMain = createIpcMain();
  const statusCalls = [];
  let resolveConnectedOutput;
  const connectedOutput = new Promise((resolve) => { resolveConnectedOutput = resolve; });
  let resolveFinished;
  const finished = new Promise((resolve) => { resolveFinished = resolve; });
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    extensionProviderService: {
      async openConnection(params) {
        return { sessionId: params.sessionId, providerId: params.providerId, status: "connecting", diagnostics: [] };
      },
      async control(sessionId, operation, payload, options) {
        statusCalls.push([sessionId, operation, payload, options.signal.aborted]);
        if (statusCalls.length === 1) return { status: "connecting" };
        if (statusCalls.length === 2) return { status: "connected" };
        return {
          status: "error",
          message: "Link lost after connect",
          diagnostics: [{ severity: "warning", message: "Provider reported reconnect exhaustion" }],
        };
      },
      closeSessionLocal() {},
    },
    getTerminalWorkerManager: () => ({
      async startExternalSession(options) { return { sessionId: options.sessionId }; },
      async pushExternalOutput(sessionId, data, meta) { resolveConnectedOutput([sessionId, data, meta]); },
      async finishExternalSession(sessionId, details) { resolveFinished([sessionId, details]); return true; },
    }),
    connectionStatusPollMs: 0,
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = { sender: { id: 77, once() {}, isDestroyed: () => false } };
  const opened = await ipcMain.handlers.get(CHANNELS.connectionStart)(event, {
    requestId: "connection-silent-start",
    sessionId: "session-silent-start",
    providerId: "com.example.transport.connection",
    configuration: {},
    columns: 80,
    rows: 24,
  });
  assert.equal(opened.status, "connecting");
  assert.deepEqual(await connectedOutput, [
    "session-silent-start",
    "",
    { pluginPipelineIngressBytes: 0, pluginConnectionReady: true },
  ]);
  assert.deepEqual(await finished, [
    "session-silent-start",
    {
      reason: "error",
      error: "Link lost after connect",
      diagnostics: [{ severity: "warning", message: "Provider reported reconnect exhaustion" }],
    },
  ]);
  assert.equal(statusCalls.length, 3);
  assert.equal(statusCalls.every((call) => call[1] === "getStatus" && call[3] === false), true);
});

test("plugin connections that open connected release silent terminal startup", async () => {
  const ipcMain = createIpcMain();
  const output = [];
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    extensionProviderService: {
      async openConnection(params) {
        return { sessionId: params.sessionId, providerId: params.providerId, status: "connected", diagnostics: [] };
      },
      closeSessionLocal() {},
    },
    getTerminalWorkerManager: () => ({
      async startExternalSession(options) { return { sessionId: options.sessionId }; },
      async pushExternalOutput(sessionId, data, meta) { output.push([sessionId, data, meta]); return true; },
      async finishExternalSession() { return true; },
    }),
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = { sender: { id: 79, once() {}, isDestroyed: () => false } };
  const opened = await ipcMain.handlers.get(CHANNELS.connectionStart)(event, {
    requestId: "connection-silent-connected",
    sessionId: "session-silent-connected",
    providerId: "com.example.transport.connection",
    configuration: {},
    columns: 80,
    rows: 24,
  });
  assert.equal(opened.status, "connected");
  assert.deepEqual(output, [[
    "session-silent-connected",
    "",
    { pluginPipelineIngressBytes: 0, pluginConnectionReady: true },
  ]]);
});

test("plugin connections that open connected continue status monitoring", async () => {
  const ipcMain = createIpcMain();
  const statusCalls = [];
  let resolveFinished;
  const finished = new Promise((resolve) => { resolveFinished = resolve; });
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    extensionProviderService: {
      async openConnection(params) {
        return { sessionId: params.sessionId, providerId: params.providerId, status: "connected", diagnostics: [] };
      },
      async control(sessionId, operation) {
        statusCalls.push([sessionId, operation]);
        return { status: "closed", message: "Provider closed" };
      },
      closeSessionLocal() {},
    },
    getTerminalWorkerManager: () => ({
      async startExternalSession(options) { return { sessionId: options.sessionId }; },
      async pushExternalOutput() { return true; },
      async finishExternalSession(sessionId, details) { resolveFinished([sessionId, details]); return true; },
    }),
    connectionStatusPollMs: 0,
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = { sender: { id: 81, once() {}, isDestroyed: () => false } };
  const opened = await ipcMain.handlers.get(CHANNELS.connectionStart)(event, {
    requestId: "connection-connected-monitored",
    sessionId: "session-connected-monitored",
    providerId: "com.example.transport.connection",
    configuration: {},
    columns: 80,
    rows: 24,
  });
  assert.equal(opened.status, "connected");
  assert.deepEqual(await finished, [
    "session-connected-monitored",
    { reason: "closed", error: "Provider closed" },
  ]);
  assert.deepEqual(statusCalls, [["session-connected-monitored", "getStatus"]]);
});

test("an explicit slow close stops status monitoring before the Provider responds", async () => {
  const ipcMain = createIpcMain();
  let releaseClose;
  const closeGate = new Promise((resolve) => { releaseClose = resolve; });
  let resolveCloseStarted;
  const closeStarted = new Promise((resolve) => { resolveCloseStarted = resolve; });
  const statusCalls = [];
  const finished = [];
  const externalSessions = new Map();
  const owners = [];
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    extensionProviderService: {
      async openConnection(params) {
        return { sessionId: params.sessionId, providerId: params.providerId, status: "connected", diagnostics: [] };
      },
      async control(sessionId, operation) {
        if (operation === "close") {
          resolveCloseStarted();
          await closeGate;
          return null;
        }
        statusCalls.push([sessionId, operation]);
        throw new Error("Plugin connection session was not found");
      },
      closeSessionLocal() {},
    },
    getTerminalWorkerManager: () => ({
      async startExternalSession(options) {
        if (externalSessions.has(options.sessionId)) throw new Error("external session already registered");
        owners.push(options.ownerToken);
        externalSessions.set(options.sessionId, options.ownerToken);
        return { sessionId: options.sessionId };
      },
      async pushExternalOutput() { return true; },
      async finishExternalSession(sessionId, details, owner) {
        if (externalSessions.get(sessionId) !== owner) return false;
        externalSessions.delete(sessionId);
        finished.push([sessionId, details, owner]);
        return true;
      },
    }),
    connectionStatusPollMs: 5,
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = { sender: { id: 89, once() {}, isDestroyed: () => false } };
  await ipcMain.handlers.get(CHANNELS.connectionStart)(event, {
    requestId: "connection-explicit-slow-close",
    sessionId: "session-explicit-slow-close",
    providerId: "com.example.transport.connection",
    configuration: {},
    columns: 80,
    rows: 24,
  });

  const closing = ipcMain.handlers.get(CHANNELS.connectionControl)(event, {
    sessionId: "session-explicit-slow-close",
    operation: "close",
    payload: {},
  });
  await closeStarted;
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(statusCalls, []);
  assert.deepEqual(finished, [[
    "session-explicit-slow-close",
    { reason: "closed" },
    owners[0],
  ]]);
  await assert.rejects(ipcMain.handlers.get(CHANNELS.connectionWrite)(event, {
    sessionId: "session-explicit-slow-close",
    data: "late input",
  }), /not owned/i);

  await ipcMain.handlers.get(CHANNELS.connectionStart)(event, {
    requestId: "connection-explicit-slow-close-replacement",
    sessionId: "session-explicit-slow-close",
    providerId: "com.example.transport.connection",
    configuration: {},
    columns: 80,
    rows: 24,
  });
  assert.notEqual(owners[1], owners[0]);
  assert.equal(externalSessions.get("session-explicit-slow-close"), owners[1]);
  releaseClose();
  assert.equal(await closing, null);
  assert.equal(externalSessions.get("session-explicit-slow-close"), owners[1]);
});

test("silent connection readiness delivery failure closes the opened provider session", async () => {
  const ipcMain = createIpcMain();
  const controls = [];
  const finished = [];
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    extensionProviderService: {
      async openConnection(params) {
        return { sessionId: params.sessionId, providerId: params.providerId, status: "connected", diagnostics: [] };
      },
      async control(...args) { controls.push(args); return null; },
      closeSessionLocal() {},
    },
    getTerminalWorkerManager: () => ({
      async startExternalSession(options) { return { sessionId: options.sessionId }; },
      async pushExternalOutput() { throw new Error("renderer unavailable"); },
      async finishExternalSession(sessionId, details) { finished.push([sessionId, details]); return true; },
    }),
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = { sender: { id: 80, once() {}, isDestroyed: () => false } };
  await assert.rejects(
    ipcMain.handlers.get(CHANNELS.connectionStart)(event, {
      requestId: "connection-readiness-failure",
      sessionId: "session-readiness-failure",
      providerId: "com.example.transport.connection",
      configuration: {},
      columns: 80,
      rows: 24,
    }),
    /renderer unavailable/,
  );
  assert.deepEqual(controls.map(([sessionId, operation]) => [sessionId, operation]), [
    ["session-readiness-failure", "close"],
  ]);
  assert.deepEqual(finished, [[
    "session-readiness-failure",
    { reason: "error", error: "renderer unavailable" },
  ]]);
});

test("plugin connection status monitoring closes asynchronous provider errors", async () => {
  const ipcMain = createIpcMain();
  const closed = [];
  const externalSessions = new Map();
  const finishAttempts = [];
  let providerOptions;
  let resolveFinished;
  const finished = new Promise((resolve) => { resolveFinished = resolve; });
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    extensionProviderService: {
      async openConnection(params, options) {
        providerOptions = options;
        return { sessionId: params.sessionId, providerId: params.providerId, status: "connecting", diagnostics: [] };
      },
      async control() {
        return {
          status: "error",
          message: "Handshake rejected",
          diagnostics: [{ severity: "error", message: "Host key mismatch", path: "configuration.hostKey" }],
        };
      },
      closeSessionLocal(sessionId) {
        closed.push(sessionId);
        void providerOptions.onOutputClose(new Error("Plugin stream cancelled: status-close-repro"));
      },
    },
    getTerminalWorkerManager: () => ({
      async startExternalSession(options) {
        externalSessions.set(options.sessionId, options.ownerToken);
        return { sessionId: options.sessionId };
      },
      async pushExternalOutput() {},
      async finishExternalSession(sessionId, details, owner) {
        const accepted = externalSessions.get(sessionId) === owner;
        finishAttempts.push([sessionId, details, accepted]);
        if (!accepted) return false;
        externalSessions.delete(sessionId);
        resolveFinished([sessionId, details]);
        return true;
      },
    }),
    connectionStatusPollMs: 0,
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = { sender: { id: 78, once() {}, isDestroyed: () => false } };
  await ipcMain.handlers.get(CHANNELS.connectionStart)(event, {
    requestId: "connection-late-error",
    sessionId: "session-late-error",
    providerId: "com.example.transport.connection",
    configuration: {},
    columns: 80,
    rows: 24,
  });
  assert.deepEqual(await finished, [
    "session-late-error",
    {
      reason: "error",
      error: "Handshake rejected",
      diagnostics: [{ severity: "error", message: "Host key mismatch", path: "configuration.hostKey" }],
    },
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(closed, ["session-late-error"]);
  assert.equal(finishAttempts[0][1].error, "Handshake rejected");
  assert.equal(finishAttempts[0][2], true);
  assert.equal(finishAttempts[1][1].error, "Plugin stream cancelled: status-close-repro");
  assert.equal(finishAttempts[1][2], false);
});

test("plugin connection status monitoring invokes Provider reconnect for retryable failures", async () => {
  const ipcMain = createIpcMain();
  const controls = [];
  const outputs = [];
  let statusIndex = 0;
  let resolveFinished;
  const finished = new Promise((resolve) => { resolveFinished = resolve; });
  const statuses = [
    { status: "error", message: "Temporary loss", retryable: true },
    { status: "connected" },
    { status: "closed", message: "Done" },
  ];
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    extensionProviderService: {
      async openConnection(params) {
        return { sessionId: params.sessionId, providerId: params.providerId, status: "connecting", diagnostics: [] };
      },
      async control(sessionId, operation) {
        controls.push([sessionId, operation]);
        if (operation === "reconnect") return null;
        return statuses[statusIndex++];
      },
      closeSessionLocal() {},
    },
    getTerminalWorkerManager: () => ({
      async startExternalSession(options) { return { sessionId: options.sessionId }; },
      async pushExternalOutput(sessionId, data, meta) { outputs.push([sessionId, data, meta]); },
      async finishExternalSession(sessionId, details) { resolveFinished([sessionId, details]); return true; },
    }),
    connectionStatusPollMs: 0,
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = { sender: { id: 86, once() {}, isDestroyed: () => false } };
  await ipcMain.handlers.get(CHANNELS.connectionStart)(event, {
    requestId: "connection-retryable-status",
    sessionId: "session-retryable-status",
    providerId: "com.example.transport.connection",
    configuration: {},
    columns: 80,
    rows: 24,
  });

  assert.deepEqual(await finished, [
    "session-retryable-status",
    { reason: "closed", error: "Done" },
  ]);
  assert.deepEqual(controls, [
    ["session-retryable-status", "getStatus"],
    ["session-retryable-status", "reconnect"],
    ["session-retryable-status", "getStatus"],
    ["session-retryable-status", "getStatus"],
  ]);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0][2].pluginConnectionReady, true);
});

test("plugin connection output stream failures finish the terminal as errors", async () => {
  const ipcMain = createIpcMain();
  let closeOutput;
  const finished = [];
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    extensionProviderService: {
      async openConnection(params, options) {
        closeOutput = options.onOutputClose;
        return { sessionId: params.sessionId, providerId: params.providerId, status: "connected", diagnostics: [] };
      },
      async control() { return { status: "connected" }; },
      closeSessionLocal() {},
    },
    getTerminalWorkerManager: () => ({
      async startExternalSession(options) { return { sessionId: options.sessionId }; },
      async pushExternalOutput() { return true; },
      async finishExternalSession(sessionId, details) { finished.push([sessionId, details]); return true; },
    }),
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = { sender: { id: 82, once() {}, isDestroyed: () => false } };
  await ipcMain.handlers.get(CHANNELS.connectionStart)(event, {
    requestId: "connection-output-failure",
    sessionId: "session-output-failure",
    providerId: "com.example.transport.connection",
    configuration: {},
    columns: 80,
    rows: 24,
  });
  await closeOutput({ code: -32013, message: "Provider output failed" });
  assert.deepEqual(finished.at(-1), [
    "session-output-failure",
    { reason: "error", error: "Provider output failed" },
  ]);
});

test("plugin connection output stream endings use supported terminal exit reasons", async () => {
  const ipcMain = createIpcMain();
  let closeOutput;
  const finished = [];
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    extensionProviderService: {
      async openConnection(params, options) {
        closeOutput = options.onOutputClose;
        return { sessionId: params.sessionId, providerId: params.providerId, status: "connected", diagnostics: [] };
      },
      async control() { return { status: "connected" }; },
      closeSessionLocal() {},
    },
    getTerminalWorkerManager: () => ({
      async startExternalSession(options) { return { sessionId: options.sessionId }; },
      async pushExternalOutput() { return true; },
      async finishExternalSession(sessionId, details) { finished.push([sessionId, details]); return true; },
    }),
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = { sender: { id: 90, once() {}, isDestroyed: () => false } };
  const start = (requestId, sessionId) => ipcMain.handlers.get(CHANNELS.connectionStart)(event, {
    requestId,
    sessionId,
    providerId: "com.example.transport.connection",
    configuration: {},
    columns: 80,
    rows: 24,
  });

  await start("connection-output-end", "session-output-end");
  await closeOutput("end");
  assert.deepEqual(finished.at(-1), [
    "session-output-end",
    { reason: "exited", exitCode: 0 },
  ]);

  await start("connection-output-cancel", "session-output-cancel");
  await closeOutput("cancel");
  assert.deepEqual(finished.at(-1), [
    "session-output-cancel",
    { reason: "closed" },
  ]);
});

test("plugin connection ignores output that races with renderer session close", async () => {
  const ipcMain = createIpcMain();
  let externalOptions;
  let providerOptions;
  let outputAttempts = 0;
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    extensionProviderService: {
      async openConnection(params, options) {
        providerOptions = options;
        return { sessionId: params.sessionId, providerId: params.providerId, status: "connected", diagnostics: [] };
      },
      async control() { return null; },
      closeSessionLocal() {},
    },
    getTerminalWorkerManager: () => ({
      async startExternalSession(options) {
        externalOptions = options;
        return { sessionId: options.sessionId };
      },
      async pushExternalOutput(_sessionId, data) {
        if (data === "") return true;
        outputAttempts += 1;
        throw new Error("session no longer exists");
      },
      async finishExternalSession() { return true; },
    }),
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = { sender: { id: 85, once() {}, isDestroyed: () => false } };
  await ipcMain.handlers.get(CHANNELS.connectionStart)(event, {
    requestId: "connection-output-close-race",
    sessionId: "session-output-close-race",
    providerId: "com.example.transport.connection",
    configuration: {},
    columns: 80,
    rows: 24,
  });

  await providerOptions.onData(Uint8Array.from([0xe2]));
  await externalOptions.onClose("renderer-close");
  await assert.doesNotReject(providerOptions.onData(new TextEncoder().encode("late output")));
  await assert.doesNotReject(providerOptions.onOutputClose("end"));
  assert.equal(outputAttempts, 0);
});

test("destroying a plugin connection owner closes the Provider and terminal worker session", async () => {
  const ipcMain = createIpcMain();
  const destroyedListeners = [];
  const controls = [];
  const localCloses = [];
  const finished = [];
  let registeredOwner;
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    extensionProviderService: {
      async openConnection(params) {
        return { sessionId: params.sessionId, providerId: params.providerId, status: "connected", diagnostics: [] };
      },
      async control(sessionId, operation, payload, options) {
        controls.push([sessionId, operation, payload, options]);
        return null;
      },
      closeSessionLocal(sessionId) { localCloses.push(sessionId); },
    },
    getTerminalWorkerManager: () => ({
      async startExternalSession(options) {
        registeredOwner = options.ownerToken;
        return { sessionId: options.sessionId };
      },
      async pushExternalOutput() { return true; },
      async finishExternalSession(sessionId, details, owner) {
        finished.push([sessionId, details, owner]);
        return true;
      },
    }),
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = {
    sender: {
      id: 87,
      once(name, listener) {
        if (name === "destroyed") destroyedListeners.push(listener);
      },
      isDestroyed: () => false,
    },
  };
  await ipcMain.handlers.get(CHANNELS.connectionStart)(event, {
    requestId: "connection-owner-destroyed",
    sessionId: "session-owner-destroyed",
    providerId: "com.example.transport.connection",
    configuration: {},
    columns: 80,
    rows: 24,
  });

  for (const listener of destroyedListeners) listener();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(controls.map((call) => call.slice(0, 3)), [["session-owner-destroyed", "close", {}]]);
  assert.equal(controls[0][3].sessionOwner, registeredOwner);
  assert.deepEqual(localCloses, []);
  assert.deepEqual(finished, [["session-owner-destroyed", { reason: "closed" }, registeredOwner]]);
});

test("a late Provider close cannot finish a same-ID replacement connection", async () => {
  const ipcMain = createIpcMain();
  const providerOptions = [];
  const externalSessions = new Map();
  const owners = [];
  const finishedOwners = [];
  const writes = [];
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    extensionProviderService: {
      async openConnection(params, options) {
        providerOptions.push(options);
        return { sessionId: params.sessionId, providerId: params.providerId, status: "connected", diagnostics: [] };
      },
      async control() { return null; },
      async write(_sessionId, data, owner) { writes.push([data, owner]); },
      closeSessionLocal() {},
    },
    getTerminalWorkerManager: () => ({
      async startExternalSession(options) {
        if (externalSessions.has(options.sessionId)) throw new Error("external session already registered");
        owners.push(options.ownerToken);
        externalSessions.set(options.sessionId, { options, owner: options.ownerToken });
        return { sessionId: options.sessionId };
      },
      async pushExternalOutput(sessionId, _data, _meta, owner) {
        return externalSessions.get(sessionId)?.owner === owner;
      },
      async finishExternalSession(sessionId, _details, owner) {
        if (externalSessions.get(sessionId)?.owner !== owner) return false;
        externalSessions.delete(sessionId);
        finishedOwners.push(owner);
        return true;
      },
    }),
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = { sender: { id: 88, once() {}, isDestroyed: () => false } };
  const start = (requestId) => ipcMain.handlers.get(CHANNELS.connectionStart)(event, {
    requestId,
    sessionId: "session-replaced",
    providerId: "com.example.transport.connection",
    configuration: {},
    columns: 80,
    rows: 24,
  });

  await start("connection-replaced-old");
  const oldExternal = externalSessions.get("session-replaced");
  externalSessions.delete("session-replaced");
  await oldExternal.options.onClose("renderer-close");
  await start("connection-replaced-new");

  await assert.doesNotReject(providerOptions[0].onOutputClose("end"));
  assert.equal(externalSessions.get("session-replaced")?.owner, owners[1]);
  assert.deepEqual(finishedOwners, []);
  await ipcMain.handlers.get(CHANNELS.connectionWrite)(event, {
    sessionId: "session-replaced",
    data: "new input",
  });
  assert.deepEqual(writes, [["new input", owners[1]]]);
});

test("closing the terminal during plugin authentication cancels the challenge before provider open", async () => {
  const ipcMain = createIpcMain();
  const sent = [];
  const closed = [];
  let externalOptions;
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    extensionProviderService: {
      async authenticate(_params, requestChallenge, options) {
        await requestChallenge({
          id: "password-before-open",
          kind: "password",
          title: "Password",
        });
        if (options.signal.aborted) throw options.signal.reason;
        return { status: "authenticated", credential: { kind: "credential", id: "unused" } };
      },
      async openConnection() {
        throw new Error("provider open should not run after terminal close");
      },
      closeSessionLocal(sessionId) { closed.push(sessionId); },
    },
    getTerminalWorkerManager: () => ({
      async startExternalSession(options) {
        externalOptions = options;
        return { sessionId: options.sessionId };
      },
      async finishExternalSession() { return true; },
    }),
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = {
    sender: {
      id: 83,
      once() {},
      isDestroyed: () => false,
      send(channel, payload) { sent.push([channel, payload]); },
    },
  };
  const pending = ipcMain.handlers.get(CHANNELS.connectionStart)(event, {
    requestId: "connection-auth-close-before-open",
    sessionId: "session-auth-close-before-open",
    providerId: "com.example.transport.connection",
    authenticationProviderId: "com.example.transport.authentication",
    configuration: {},
    columns: 80,
    rows: 24,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  await externalOptions.onClose("renderer-close");
  await assert.rejects(pending, (error) => error?.name === "AbortError");
  await assert.rejects(
    ipcMain.handlers.get(CHANNELS.authenticationRespond)(event, {
      requestId: sent[0][1].requestId,
      challengeRequestId: sent[0][1].challengeRequestId,
      challengeId: sent[0][1].challenge.id,
      response: "too late",
    }),
    /not owned/,
  );
  assert.deepEqual(closed, ["session-auth-close-before-open"]);
});

test("closing the terminal while a plugin connection opens cancels the provider startup", async () => {
  const ipcMain = createIpcMain();
  let externalOptions;
  const closed = [];
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    extensionProviderService: {
      openConnection(_params, options) {
        return new Promise((_resolve, reject) => {
          const rejectCancelled = () => reject(options.signal.reason);
          if (options.signal.aborted) rejectCancelled();
          else options.signal.addEventListener("abort", rejectCancelled, { once: true });
        });
      },
      closeSessionLocal(sessionId) { closed.push(sessionId); },
    },
    getTerminalWorkerManager: () => ({
      async startExternalSession(options) {
        externalOptions = options;
        return { sessionId: options.sessionId };
      },
      async finishExternalSession() { return false; },
    }),
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = { sender: { id: 76, once() {}, isDestroyed: () => false } };
  const pending = ipcMain.handlers.get(CHANNELS.connectionStart)(event, {
    requestId: "connection-close-during-start",
    sessionId: "session-close-during-start",
    providerId: "com.example.transport.connection",
    configuration: {},
    columns: 80,
    rows: 24,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await externalOptions.onClose("renderer-close");
  await assert.rejects(pending, (error) => error?.name === "AbortError");
  assert.deepEqual(closed, ["session-close-during-start"]);
});

test("sync read/write shuttle Uint8Array inline and stream large writes", async () => {
  const written = [];
  const ipcMain = createIpcMain();
  registerPluginBridge(ipcMain, {
    manager: { async initialize() {} },
    extensionProviderService: {
      listProviders() {
        return [{
          pluginId: "com.example",
          pluginVersion: "1.0.0",
          provider: { id: "com.example.sync", kind: "sync", label: "Example Sync" },
        }];
      },
      async readSyncObject(params) {
        return {
          found: true,
          key: params.key,
          bytes: Buffer.from("cipher-inline"),
          revision: "r1",
        };
      },
      async writeSyncObject(params) {
        written.push({
          key: params.key,
          byteLength: params.bytes.byteLength,
          preferStream: params.preferStream === true,
        });
        return { created: true, revision: "r2" };
      },
    },
    secretStore: {
      set(pluginId, key, value) {
        return Object.freeze({ kind: "secret", id: "sec-1", key, pluginId, value });
      },
    },
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = { sender: { id: 99, once() {}, isDestroyed: () => false } };

  const inlineRead = await ipcMain.handlers.get(CHANNELS.syncReadObject)(event, {
    requestId: "sync-read-1",
    providerId: "com.example.sync",
    key: "vault",
  });
  assert.equal(inlineRead.found, true);
  assert.equal(inlineRead.streamed, undefined);
  assert.ok(inlineRead.data instanceof Uint8Array || Buffer.isBuffer(inlineRead.data));
  assert.equal(Buffer.from(inlineRead.data).toString("utf8"), "cipher-inline");

  const inlineWrite = await ipcMain.handlers.get(CHANNELS.syncWriteObject)(event, {
    requestId: "sync-write-1",
    providerId: "com.example.sync",
    key: "vault",
    data: Buffer.from("small"),
  });
  assert.deepEqual(inlineWrite, { created: true, revision: "r2" });

  const begin = await ipcMain.handlers.get(CHANNELS.syncWriteBegin)(event, {
    requestId: "sync-write-stream",
    providerId: "com.example.sync",
    key: "vault",
    byteLength: 5,
  });
  assert.equal(typeof begin.transferId, "string");
  await ipcMain.handlers.get(CHANNELS.syncWriteChunk)(event, {
    requestId: "sync-write-stream",
    transferId: begin.transferId,
    sequence: 0,
    chunk: Buffer.from("large"),
  });
  const committed = await ipcMain.handlers.get(CHANNELS.syncWriteCommit)(event, {
    requestId: "sync-write-stream",
    transferId: begin.transferId,
  });
  assert.deepEqual(committed, { created: true, revision: "r2" });
  assert.equal(written.at(-1)?.preferStream, true);
  assert.equal(written.at(-1)?.byteLength, 5);

  const secret = await ipcMain.handlers.get(CHANNELS.syncPutSecret)(event, {
    providerId: "com.example.sync",
    key: "sync-credential",
    value: "pw",
  });
  assert.deepEqual(secret, {
    kind: "secret",
    id: "sec-1",
    key: "sync-credential",
    pluginId: "com.example",
    value: "pw",
    created: true,
  });
});

test("syncDeleteSecrets uses retained provider binding when contribution is missing", async () => {
  const deleted = [];
  const unbound = [];
  const ipcMain = createIpcMain();
  registerPluginBridge(ipcMain, {
    manager: { async initialize() {} },
    extensionProviderService: {
      listProviders() {
        return [];
      },
    },
    secretStore: {
      set() {
        throw new Error("set should not run");
      },
      delete(pluginId, key) {
        deleted.push([pluginId, key]);
      },
      deleteByKeyPrefix(pluginId, prefix) {
        deleted.push([pluginId, `prefix:${prefix}`]);
        return 2;
      },
      resolveSyncProviderPlugin(providerId) {
        assert.equal(providerId, "com.example.sync");
        return "com.example";
      },
      unbindSyncProviderPlugin(pluginId, providerId) {
        unbound.push([pluginId, providerId]);
      },
    },
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: () => true,
  });
  const event = { sender: { id: 99, once() {}, isDestroyed: () => false } };
  const result = await ipcMain.handlers.get(CHANNELS.syncDeleteSecrets)(event, {
    providerId: "com.example.sync",
  });
  assert.deepEqual(result, { deleted: 2 });
  assert.deepEqual(deleted, [["com.example", "prefix:sync-credential"]]);
  assert.deepEqual(unbound, [["com.example", "com.example.sync"]]);
});

test("missing OS vault does not block curated browsing and status exposes the limitation", async () => {
  const ipcMain = createIpcMain();
  let selected;
  registerPluginBridge(ipcMain, {
    manager: { async initialize() {} },
    env: { NETCATTY_PLUGIN_DEV: "1" },
    isTrustedSender: (event) => event.trusted === true,
    credentialResolver: { isAvailable: () => false },
    catalogService: {
      list: () => [{ id: "com.example.synthetic" }],
      install: async (id) => { selected = id; return { id }; },
    },
  });
  const event = { trusted: true };
  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.status)(event), {
    available: true, experimental: true, credentialStorageAvailable: false,
  });
  assert.equal((await ipcMain.handlers.get(CHANNELS.catalog)(event)).length, 1);
  await assert.rejects(ipcMain.handlers.get(CHANNELS.catalog)({ trusted: false }), /Untrusted/);
  await ipcMain.handlers.get(CHANNELS.catalogInstall)(event, { id: "com.example.synthetic", url: "https://attacker.invalid", enable: true });
  assert.equal(selected, "com.example.synthetic");
});

test('brand metadata bridge accepts only trusted UI and forwards only the plugin ID', async () => {
  const ipcMain = createIpcMain(); const seen = [];
  registerPluginBridge(ipcMain, {
    manager: { initialize: async () => {} },
    isTrustedSender: (event) => event.trusted === true,
    resolveBrandIcon: async (...args) => { seen.push(args); return { light: 'data:image/png;base64,fixture' }; },
  });
  await assert.rejects(ipcMain.handlers.get(CHANNELS.brandIcon)({ trusted: false }, { pluginId: 'com.test.brand' }), /Untrusted/);
  assert.equal(seen.length, 0);
  await ipcMain.handlers.get(CHANNELS.brandIcon)({ trusted: true }, { pluginId: 'com.test.brand', path: '/secret', url: 'https://attacker.invalid/' });
  assert.deepEqual(seen, [['com.test.brand']]);
});

test("permission management is trusted-host-only and projects bounded audit summaries", async () => {
  const ipcMain = createIpcMain();
  let reads = 0;
  const revoked = [];
  registerPluginBridge(ipcMain, {
    manager: { async initialize() {}, async revokePermissions(id) { revoked.push(id); return { enabled: false }; } },
    isTrustedSender: (event) => event?.trusted === true,
    permissionEngine: { describeGrants(id, context) {
      assert.equal(context, null);
      reads++;
      assert.equal(id, "com.example.synthetic");
      return { always: [{ permission: "network", resource: "https://example.invalid", resourceKind: "exact", grantedAt: 12, matchesCurrentActivation: false, declarationHash: "private" }], application: [], session: [] };
    } },
    database: { getActivePlugin() { return null; }, listSecurityAudit(id, limit) {
      assert.equal(id, "com.example.synthetic");
      assert.equal(limit, 100);
      return [{ event: "permission.used", createdAt: 13, details: { permission: "network", scope: "always", operationId: "hidden", secret: "synthetic-private" } }];
    } },
  });
  const payload = { pluginId: "com.example.synthetic" };
  for (const channel of [CHANNELS.permissions, CHANNELS.revokePermissions]) {
    await assert.rejects(ipcMain.handlers.get(channel)({}, payload), /Untrusted/);
    await assert.rejects(ipcMain.handlers.get(channel)({ trusted: true }, { pluginId: "../invalid" }), /Plugin ID/);
  }
  assert.equal(reads, 0);
  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.permissions)({ trusted: true }, payload), {
    grants: [{ permission: "network", resource: "https://example.invalid", resourceKind: "exact", scope: "always", sessionId: null, grantedAt: 12, matchesCurrentActivation: false }],
    audit: [{ event: "permission.used", createdAt: 13, permission: "network", scope: "always" }],
  });
  assert.deepEqual(await ipcMain.handlers.get(CHANNELS.revokePermissions)({ trusted: true }, payload), { enabled: false });
  assert.deepEqual(revoked, [payload.pluginId]);
});

test("grant classification uses only the current host activation and stops matching after disable or upgrade", async () => {
  const ipcMain = createIpcMain();
  let plugin = { enabled: true, activeVersion: "1.0.0", manifest: { id: "com.example.synthetic" } };
  let identity = { pluginId: "com.example.synthetic", pluginVersion: "1.0.0", runtimeId: "runtime-host", securityPrincipal: "host-owned-principal" };
  const contexts = [];
  registerPluginBridge(ipcMain, {
    manager: { async initialize() {} }, isTrustedSender: () => true,
    runtimeSupervisor: { getRuntimeIdentity: () => identity },
    permissionEngine: { describeGrants(_id, context) { contexts.push(context); return { always: [], application: [], session: [] }; } },
    database: { getActivePlugin: () => plugin, listSecurityAudit: () => [] },
  });
  const payload = { pluginId: "com.example.synthetic", securityPrincipal: "plugin-forgery", manifest: {} };
  const read = ipcMain.handlers.get(CHANNELS.permissions);
  await read({}, payload);
  assert.deepEqual(contexts[0], { ...identity, manifest: plugin.manifest });
  plugin = { ...plugin, enabled: false };
  await read({}, payload);
  assert.equal(contexts[1], null);
  plugin = { ...plugin, enabled: true, activeVersion: "2.0.0" };
  await read({}, payload);
  assert.equal(contexts[2], null, "old activation cannot label upgraded package grants as current");
  identity = null;
  await read({}, payload);
  assert.equal(contexts[3], null, "stopped and lazy plugins show saved grants as inactive");
});

test("host interaction ready and response channels reject untrusted senders before touching the adapter", async () => {
  const ipcMain = createIpcMain(), calls = [];
  const sender = { id: 7 };
  registerPluginBridge(ipcMain, {
    manager: { async initialize() {} }, isTrustedSender: (event) => event?.trusted === true,
    interactionService: {
      setReady(...args) { calls.push(args); return true; },
      respond(...args) { calls.push(args); return true; },
    },
  });
  for (const channel of [CHANNELS.interactionReady, CHANNELS.interactionResponse]) {
    await assert.rejects(ipcMain.handlers.get(channel)({ sender }, {}), /Untrusted/);
  }
  assert.deepEqual(calls, []);
  await ipcMain.handlers.get(CHANNELS.interactionReady)({ trusted: true, sender }, { ready: true });
  const response = { requestId: "opaque", actionToken: "host-token", action: "cancel" };
  await ipcMain.handlers.get(CHANNELS.interactionResponse)({ trusted: true, sender }, response);
  assert.deepEqual(calls, [[sender, true], [sender, response]]);
});

test('theme catalog and selection remain trusted app management channels',async()=>{
 const ipc=createIpcMain();let calls=0;
 registerPluginBridge(ipc,{manager:{initialize:async()=>{}},isTrustedSender:event=>event?.trusted===true,themeService:{catalog:async()=>{calls++;return{};},apply:async()=>{calls++;return{};}}});
 for(const channel of [CHANNELS.themeCatalog,CHANNELS.themeApply])await assert.rejects(ipc.handlers.get(channel)({trusted:false},{}),/Untrusted/);
 assert.equal(calls,0);await ipc.handlers.get(CHANNELS.themeCatalog)({trusted:true});await ipc.handlers.get(CHANNELS.themeApply)({trusted:true},{});assert.equal(calls,2);
});

test("local log management rejects plugin/untrusted senders before touching the sink", async () => {
  const ipcMain = createIpcMain();
  const actions = [];
  const logService = { ready: Promise.resolve() };
  for (const action of ["status", "configure", "openFolder", "exportLogs", "clear"]) logService[action] = async () => { actions.push(action); return { saveToDisk: false }; };
  registerPluginBridge(ipcMain, { manager: { async initialize() {} }, logService, isTrustedSender: (event) => event?.trusted === true });
  for (const channel of [CHANNELS.logStatus, CHANNELS.logConfigure, CHANNELS.logOpen, CHANNELS.logExport, CHANNELS.logClear]) {
    await assert.rejects(ipcMain.handlers.get(channel)({}, {}), /Untrusted/);
    assert.equal(actions.length, 0);
  }
  for (const channel of [CHANNELS.logStatus, CHANNELS.logConfigure, CHANNELS.logOpen, CHANNELS.logExport, CHANNELS.logClear]) await ipcMain.handlers.get(channel)({ trusted: true }, {});
  assert.deepEqual(actions, ["status", "configure", "openFolder", "exportLogs", "clear"]);
});

test("policy edits require trusted UI and the exact source/version/policy revision", async () => {
  const { PluginPermissionEngine } = require("./permissionEngine.cjs");
  const ipcMain = createIpcMain();
  let sourceOwner = "source-a", mode = "deny";
  const plugin = { id: "com.example.policy", activeVersion: "1.0.0", manifest: { permissions: { optional: ["storage"] } } };
  const engine = new PluginPermissionEngine({ database: { privateOwner: () => sourceOwner,
    getPermissionMode: () => mode, setPermissionMode: (_id, _permission, value) => { mode = value; },
    deleteAllPermissionGrants() {}, recordSecurityAudit() {},
  } });
  registerPluginBridge(ipcMain, { manager: { async initialize() {} }, isTrustedSender: (event) => event?.trusted === true,
    permissionEngine: engine, database: { getActivePlugin: () => plugin } });
  const edit = ipcMain.handlers.get(CHANNELS.setPermissionMode);
  const payload = { pluginId: plugin.id, permission: "storage", mode: "allow", policyRevision: engine.getPolicyRevision(plugin) };
  await assert.rejects(edit({}, payload), /Untrusted/);
  for (const change of [() => { sourceOwner = "source-b"; }, () => { plugin.activeVersion = "2.0.0"; }, () => engine.revokeAll(plugin.id)]) {
    const stale = { ...payload, policyRevision: engine.getPolicyRevision(plugin) }; change();
    await assert.rejects(edit({ trusted: true }, stale), /refresh/);
    assert.equal(mode, "deny");
  }
  assert.equal(await edit({ trusted: true }, { ...payload, policyRevision: engine.getPolicyRevision(plugin) }), true);
  assert.equal(mode, "allow");
  engine.shutdown();
});
