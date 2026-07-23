"use strict";

const assert = require("node:assert/strict");
const { MessageChannel } = require("node:worker_threads");
const test = require("node:test");

const { PluginRpcError, RPC_ERRORS } = require("./rpcRouter.cjs");
const { PluginTerminalDataPipelineService } = require("./terminalDataPipelineService.cjs");

function provider(pluginId, id, direction) {
  return Object.freeze({
    pluginId,
    pluginVersion: "1.0.0",
    pluginDisplayName: pluginId,
    provider: Object.freeze({ id, kind: `terminal.interceptor.${direction}`, label: id }),
  });
}

function harness(options = {}) {
  const providers = options.providers ?? [provider("com.example", "com.example.input", "input")];
  const identity = Object.freeze({
    pluginId: "com.example",
    pluginVersion: "1.0.0",
    runtimeId: "runtime-1",
    runtimeKind: options.runtimeKind ?? "utility",
    securityPrincipal: "principal-1",
  });
  const attached = [];
  const detached = [];
  const authorized = [];
  const activationCalls = [];
  const revokedSessions = [];
  let permissionRevocationListener = null;
  const contributionListeners = [];
  const runtimeListeners = [];
  const contributionService = {
    listProviders({ kind }) { return providers.filter((entry) => entry.provider.kind === kind); },
    async activateProvider(providerId) {
      activationCalls.push(providerId);
      await options.onActivateProvider?.();
      const entry = providers.find((candidate) => candidate.provider.id === providerId);
      if (!entry) throw new Error("missing provider");
      return {
        plugin: {
          id: entry.pluginId,
          activeVersion: entry.pluginVersion,
          manifest: { main: { node: "dist/index.js" }, permissions: { required: ["runtime.advanced"] } },
        },
        provider: entry.provider,
        identity: options.activationIdentity ?? identity,
      };
    },
    onDidChange(listener) { contributionListeners.push(listener); },
  };
  const runtimeSupervisor = {
    getRuntimeIdentity() { return options.getRuntimeIdentity ? options.getRuntimeIdentity() : identity; },
    onDidChangeRuntime(listener) { runtimeListeners.push(listener); },
    async attachTerminalInterceptor(pluginId, descriptor, port, attachOptions) {
      port.unref?.();
      attached.push({ side: "plugin", pluginId, descriptor, port, attachOptions });
      await options.onAttachTerminalInterceptor?.();
    },
  };
  const permissionEngine = {
    async authorize(context, request) {
      authorized.push({ context, request });
      await options.onAuthorize?.({ context, request, providers });
      request.validateBeforeGrant?.();
      const scope = typeof options.permissionScope === "function"
        ? options.permissionScope({ context, request, call: authorized.length })
        : options.permissionScope ?? "session";
      return { scope };
    },
    revokeSession(sessionId) { revokedSessions.push(sessionId); },
    onDidRevoke(listener) {
      permissionRevocationListener = listener;
      return { dispose: () => { permissionRevocationListener = null; } };
    },
  };
  const worker = {
    warningListener: null,
    ownedListener: null,
    closedListener: null,
    ownsSession() { return true; },
    getSessionOwnerWebContentsId() {
      return options.sessionOwnerWebContentsId ?? null;
    },
    attachTerminalInterceptor(descriptor, port) {
      port.unref?.();
      attached.push({ side: "worker", descriptor, port });
    },
    detachTerminalInterceptor(sessionId, direction) { detached.push({ sessionId, direction }); },
    onTerminalInterceptorWarning(listener) {
      this.warningListener = listener;
      return { dispose: () => { this.warningListener = null; } };
    },
    onSessionOwned(listener) {
      this.ownedListener = listener;
      return { dispose: () => { this.ownedListener = null; } };
    },
    onSessionClosed(listener) {
      this.closedListener = listener;
      return { dispose: () => { this.closedListener = null; } };
    },
  };
  const selections = [];
  const warnings = [];
  const service = new PluginTerminalDataPipelineService({
    contributionService,
    permissionEngine,
    runtimeSupervisor,
    MessageChannelMain: MessageChannel,
    requestSelection: async (request) => {
      selections.push(request);
      return Object.hasOwn(options, "selectedProviderId")
        ? options.selectedProviderId
        : request.providers[0].provider.id;
    },
    showWarning: (warning) => warnings.push(warning),
  });
  service.bindTerminalWorkerManager(worker);
  return {
    service,
    worker,
    identity,
    attached,
    detached,
    authorized,
    activationCalls,
    revokedSessions,
    selections,
    warnings,
    runtimeListeners,
    revokePermission(event) { permissionRevocationListener?.(event); },
    contributionListeners,
    contributionService,
  };
}

const session = Object.freeze({
  sessionId: "session-1",
  protocol: "ssh",
  status: "connected",
});

test("pipeline activation requires exact session permissions and transfers one port to each process", async () => {
  const h = harness();
  const result = await h.service.configureDirection(session, "input");
  assert.deepEqual(result, {
    status: "active",
    direction: "input",
    providerId: "com.example.input",
    pluginId: "com.example",
  });
  assert.deepEqual(h.authorized.map((entry) => entry.request.permission), [
    "provider.terminal",
    "terminal.intercept.input",
  ]);
  assert.ok(h.authorized.every((entry) => entry.request.sessionId === "session-1"));
  assert.ok(h.authorized.every((entry) => (
    JSON.stringify(entry.request.allowedScopes) === JSON.stringify(["session", "application", "always"])
  )));
  assert.deepEqual(h.attached.map((entry) => entry.side), ["plugin", "worker"]);
  assert.deepEqual(h.attached[0].attachOptions.expectedIdentity, h.identity);
  assert.deepEqual(h.attached[0].descriptor, {
    providerId: "com.example.input",
    direction: "input",
    session,
  });
  assert.deepEqual(h.attached[1].descriptor, {
    sessionId: "session-1",
    direction: "input",
    providerId: "com.example.input",
    pluginId: "com.example",
    pluginVersion: "1.0.0",
    runtimeId: "runtime-1",
    runtimeKind: "utility",
    securityPrincipal: "principal-1",
    session,
  });
});

test("pipeline rejects one-use permission grants before opening a streaming port", async () => {
  const h = harness({ permissionScope: "once" });
  await assert.rejects(
    () => h.service.configureDirection(session, "input"),
    /require a session, application, or persistent permission grant/,
  );
  assert.equal(h.authorized.length, 1);
  assert.equal(h.attached.length, 0);

  const laterOnce = harness({
    permissionScope: ({ call }) => (call === 2 ? "once" : "session"),
  });
  await assert.rejects(
    () => laterOnce.service.configureDirection(session, "input"),
    /require a session, application, or persistent permission grant/,
  );
  assert.equal(laterOnce.authorized.length, 2);
  assert.equal(laterOnce.attached.length, 0);
});

test("permission denial is remembered for the session instead of prompting again", async () => {
  const h = harness({
    onAuthorize() {
      throw new PluginRpcError(RPC_ERRORS.permissionDenied, "permission denied");
    },
  });
  await assert.rejects(
    () => h.service.configureDirection(session, "input"),
    (error) => error?.code === RPC_ERRORS.permissionDenied,
  );
  h.contributionListeners[0]();
  assert.equal((await h.service.configureDirection(session, "input")).status, "declined");
  assert.equal(h.authorized.length, 1);
  assert.equal(h.attached.length, 0);
});

test("session event permission denial is a quiet declined result", async () => {
  const h = harness({
    onAuthorize() {
      throw new PluginRpcError(RPC_ERRORS.permissionDenied, "permission denied");
    },
  });
  const results = await h.service.handleSessionEvent({ type: "connected", session }, {
    webContentsId: 99,
  });
  assert.deepEqual(results, [
    { status: "declined", direction: "input" },
    { status: "none", direction: "output" },
  ]);
  assert.deepEqual(h.warnings, []);
});

test("pipeline accepts an existing long-lived permission grant", async () => {
  const h = harness({ permissionScope: "existing" });
  const result = await h.service.configureDirection(session, "input");
  assert.equal(result.status, "active");
  assert.equal(h.authorized.length, 2);
  assert.deepEqual(h.attached.map((entry) => entry.side), ["plugin", "worker"]);
});

test("multiple interceptors require an explicit per-session selection", async () => {
  const h = harness({
    providers: [
      provider("com.example", "com.example.input", "input"),
      provider("com.other", "com.other.input", "input"),
    ],
    selectedProviderId: "com.example.input",
  });
  await h.service.configureDirection(session, "input");
  assert.equal(h.selections.length, 1);
  assert.equal(h.selections[0].providers.length, 2);
  await h.service.configureDirection(session, "input");
  assert.equal(h.selections.length, 1, "an active session binding must not prompt again");
});

test("declining competing interceptors is remembered for the session and reset on disposal", async () => {
  const h = harness({
    providers: [
      provider("com.example", "com.example.input", "input"),
      provider("com.other", "com.other.input", "input"),
    ],
    selectedProviderId: null,
  });
  assert.equal((await h.service.configureDirection(session, "input")).status, "declined");
  assert.equal((await h.service.configureDirection(session, "input")).status, "declined");
  assert.equal(h.selections.length, 1);

  await h.service.handleSessionEvent({
    type: "disposed",
    session: { ...session, status: "disconnected" },
  });
  await h.service.configureDirection(session, "input");
  assert.equal(h.selections.length, 2);
});

test("concurrent snapshots serialize to one authorization and one port pair", async () => {
  const h = harness();
  const [first, second] = await Promise.all([
    h.service.configureDirection(session, "input"),
    h.service.configureDirection(session, "input"),
  ]);
  assert.equal(first.status, "active");
  assert.equal(second.status, "active");
  assert.equal(h.authorized.length, 2);
  assert.equal(h.attached.length, 2);
});

test("browser runtimes cannot receive privileged terminal ports", async () => {
  const h = harness({ runtimeKind: "browser" });
  await assert.rejects(
    () => h.service.configureDirection(session, "input"),
    /advanced utility runtime/,
  );
  assert.equal(h.attached.length, 0);
});

test("stale activation identity fails before permissions or port transfer", async () => {
  const h = harness({
    activationIdentity: {
      pluginId: "com.example",
      pluginVersion: "0.9.0",
      runtimeId: "stale-runtime",
      runtimeKind: "utility",
      securityPrincipal: "principal-1",
    },
  });
  await assert.rejects(
    () => h.service.configureDirection(session, "input"),
    /identity is unavailable, stale/,
  );
  assert.equal(h.authorized.length, 0);
  assert.equal(h.attached.length, 0);
});

test("worker transfer starts only after the plugin port is ready", async () => {
  const h = harness();
  h.worker.attachTerminalInterceptor = () => { throw new Error("worker unavailable"); };
  await assert.rejects(
    () => h.service.configureDirection(session, "input"),
    /worker unavailable/,
  );
  assert.deepEqual(h.attached.map((entry) => entry.side), ["plugin"]);
});

test("contribution withdrawal during authorization prevents stale port publication", async () => {
  let withdrawn = false;
  const h = harness({
    onAuthorize({ providers }) {
      if (withdrawn) return;
      withdrawn = true;
      providers.splice(0, providers.length);
    },
  });
  await assert.rejects(
    () => h.service.configureDirection(session, "input"),
    /contribution changed/,
  );
  assert.equal(h.attached.length, 0);
});

test("runtime replacement during port attachment cannot publish a stale active binding", async () => {
  let runtimeId = "runtime-1";
  const h = harness({
    getRuntimeIdentity: () => ({
      pluginId: "com.example",
      pluginVersion: "1.0.0",
      runtimeId,
      runtimeKind: "utility",
      securityPrincipal: "principal-1",
    }),
    onAttachTerminalInterceptor() { runtimeId = "runtime-2"; },
  });
  await assert.rejects(
    () => h.service.configureDirection(session, "input"),
    /runtime changed during port attachment/,
  );
  assert.deepEqual(h.attached.map((entry) => entry.side), ["plugin"]);
  assert.deepEqual(h.detached, []);
  assert.equal(h.service.active.size, 0);
});

test("disconnect detaches and reconnect restores the remembered session interceptor", async () => {
  const h = harness({
    providers: [
      provider("com.example", "com.example.input", "input"),
      provider("com.other", "com.other.input", "input"),
    ],
    selectedProviderId: "com.example.input",
  });
  await h.service.handleSessionEvent({ type: "connected", session });
  assert.equal(h.selections.length, 1);
  assert.deepEqual(h.attached.map((entry) => entry.side), ["plugin", "worker"]);

  await h.service.handleSessionEvent({
    type: "disconnected",
    session: { ...session, status: "disconnected" },
  }, { webContentsId: 99 });
  assert.deepEqual(h.detached, [{ sessionId: "session-1", direction: "input" }]);

  await h.worker.ownedListener({ sessionId: session.sessionId, webContentsId: 99 });
  assert.equal(h.selections.length, 1, "reconnect ownership must reuse the session-local choice");
  assert.deepEqual(h.attached.map((entry) => entry.side), [
    "plugin", "worker", "plugin", "worker",
  ]);

  await h.service.handleSessionEvent({ type: "reconnected", session });
  assert.equal(h.selections.length, 1, "reconnect must reuse the session-local choice");
  assert.deepEqual(h.attached.map((entry) => entry.side), [
    "plugin", "worker", "plugin", "worker", "plugin", "worker",
  ]);
  assert.equal(h.attached.at(-1).descriptor.session.status, "connected");
});

test("session metadata changes refresh the interceptor invocation snapshot", async () => {
  const h = harness();
  await h.service.handleSessionEvent({ type: "connected", session });
  await h.service.handleSessionEvent({
    type: "cwdChanged",
    session: { ...session, cwd: "/srv/current" },
  });
  assert.equal(h.attached.at(-1).descriptor.session.cwd, "/srv/current");
  assert.deepEqual(h.attached.map((entry) => entry.side), [
    "plugin", "worker", "plugin", "worker",
  ]);
  assert.deepEqual(h.detached, [], "snapshot refresh must replace the worker port atomically");
});

test("revoking a terminal permission immediately detaches the matching active interceptor", async () => {
  const h = harness();
  await h.service.configureDirection(session, "input");
  h.revokePermission({
    pluginId: "com.example",
    permission: "terminal.intercept.input",
    resource: "*",
    scope: "application",
  });
  assert.equal(h.service.active.size, 0);
  assert.deepEqual(h.detached, [{ sessionId: "session-1", direction: "input" }]);
});

test("a worker-confirmed terminal exit revokes session grants and clears pipeline state", async () => {
  const h = harness();
  await h.service.configureDirection(session, "input");

  h.worker.closedListener({ sessionId: session.sessionId, reason: "exited" });

  assert.deepEqual(h.revokedSessions, [session.sessionId]);
  assert.equal(h.service.active.size, 0);
  assert.deepEqual(h.detached, [{ sessionId: session.sessionId, direction: "input" }]);
});

test("a renderer cannot attach an interceptor to another window's terminal session", async () => {
  const h = harness();
  h.worker.ownsSession = () => false;
  await assert.rejects(
    () => h.service.configureDirection(session, "input", { webContentsId: 99 }),
    /not owned by the requesting window/,
  );
  assert.equal(h.authorized.length, 0);
  assert.equal(h.attached.length, 0);
});

test("renderer loss during provider selection prevents authorization", async () => {
  const h = harness({
    providers: [
      provider("com.example", "com.example.input", "input"),
      provider("com.other", "com.other.input", "input"),
    ],
  });
  let owned = true;
  let releaseSelection;
  h.worker.ownsSession = () => owned;
  h.service.requestSelection = async () => {
    await new Promise((resolve) => { releaseSelection = resolve; });
    return "com.example.input";
  };

  const activation = h.service.configureDirection(session, "input", { webContentsId: 99 });
  while (!releaseSelection) await new Promise((resolve) => setImmediate(resolve));
  owned = false;
  releaseSelection();

  await assert.rejects(() => activation, /ownership changed during selection/);
  assert.equal(h.authorized.length, 0);
  assert.equal(h.attached.length, 0);
});

test("renderer loss during permission approval prevents a lasting grant", async () => {
  let owned = true;
  let releaseAuthorization;
  const h = harness({
    onAuthorize: () => new Promise((resolve) => { releaseAuthorization = resolve; }),
  });
  h.worker.ownsSession = () => owned;

  const activation = h.service.configureDirection(session, "input", { webContentsId: 99 });
  while (!releaseAuthorization) await new Promise((resolve) => setImmediate(resolve));
  owned = false;
  releaseAuthorization();

  await assert.rejects(() => activation, /ownership changed during activation/);
  assert.equal(h.authorized.length, 1);
  assert.equal(h.attached.length, 0);
});

test("renderer loss during port attachment prevents worker publication", async () => {
  let owned = true;
  let releaseAttach;
  const h = harness({
    onAttachTerminalInterceptor: () => new Promise((resolve) => { releaseAttach = resolve; }),
  });
  h.worker.ownsSession = () => owned;

  const activation = h.service.configureDirection(session, "input", { webContentsId: 99 });
  while (!releaseAttach) await new Promise((resolve) => setImmediate(resolve));
  owned = false;
  releaseAttach();

  await assert.rejects(() => activation, /ownership changed during activation/);
  assert.deepEqual(h.attached.map((entry) => entry.side), ["plugin"]);
});

test("created events defer silently until the worker has recorded session ownership", async () => {
  const h = harness();
  let owned = false;
  h.worker.ownsSession = () => owned;
  const results = await h.service.handleSessionEvent({ type: "created", session }, {
    webContentsId: 99,
  });
  assert.deepEqual(results, [
    { status: "pending-session", direction: "input" },
    { status: "pending-session", direction: "output" },
  ]);
  assert.equal(h.authorized.length, 0);
  assert.equal(h.attached.length, 0);

  owned = true;
  await h.worker.ownedListener({ sessionId: session.sessionId, webContentsId: 99 });
  assert.deepEqual(h.attached.map((entry) => entry.side), ["plugin", "worker"]);
  assert.equal(h.authorized.length, 2);
});

test("session disposal invalidates an in-flight lazy activation before port transfer", async () => {
  const h = harness();
  const originalActivate = h.contributionService.activateProvider;
  let releaseActivation;
  h.contributionService.activateProvider = async (...args) => {
    await new Promise((resolve) => { releaseActivation = resolve; });
    return originalActivate(...args);
  };
  const pending = h.service.configureDirection(session, "input");
  await new Promise((resolve) => setImmediate(resolve));
  await h.service.handleSessionEvent({
    type: "disposed",
    session: { ...session, status: "disconnected" },
  });
  releaseActivation();
  await assert.rejects(pending, /session changed/);
  assert.equal(h.attached.length, 0);
});

test("a stale renderer disposal cannot detach the current owner's interceptor", async () => {
  const h = harness({ sessionOwnerWebContentsId: 9 });
  await h.service.configureDirection(session, "input", { webContentsId: 9 });

  await h.service.handleSessionEvent({
    type: "disposed",
    session: { ...session, status: "disconnected" },
  }, { webContentsId: 7 });

  assert.equal(h.service.active.size, 1);
  assert.deepEqual(h.detached, []);
  assert.deepEqual(h.revokedSessions, []);

  await h.service.handleSessionEvent({
    type: "disposed",
    session: { ...session, status: "disconnected" },
  }, { webContentsId: 9 });
  assert.equal(h.service.active.size, 0);
  assert.deepEqual(h.detached, [{ sessionId: "session-1", direction: "input" }]);
  assert.deepEqual(h.revokedSessions, ["session-1"]);
});

test("a stale renderer cannot publish any lifecycle event for the current owner's session", async () => {
  const h = harness({ sessionOwnerWebContentsId: 9 });
  await h.service.configureDirection(session, "input", { webContentsId: 9 });
  for (const type of ["created", "disconnected", "connected", "cwdChanged"]) {
    const result = await h.service.handleSessionEvent({ type, session }, { webContentsId: 7 });
    assert.deepEqual(result, []);
  }
  assert.equal(h.service.active.size, 1);
  assert.deepEqual(h.detached, []);
  assert.deepEqual(h.revokedSessions, []);
});

test("runtime failure statuses quarantine both directions before detaching", async () => {
  for (const status of ["error", "quarantined"]) {
    const h = harness({
      providers: [
        provider("com.example", "com.example.input", "input"),
        provider("com.example", "com.example.output", "output"),
      ],
    });
    await h.service.handleSessionEvent({ type: "connected", session });
    h.runtimeListeners[0]({
      status,
      pluginId: "com.example",
      runtimeId: "runtime-1",
      error: "utility runtime crashed",
    });
    assert.deepEqual(h.detached.map((entry) => entry.direction).sort(), ["input", "output"]);
    assert.deepEqual(h.warnings.map((warning) => warning.code).sort(), [
      `runtime-${status}`,
      `runtime-${status}`,
    ]);
    const reconnect = await h.service.handleSessionEvent({ type: "connected", session });
    assert.deepEqual(reconnect.map((result) => result.status), ["declined", "declined"]);
    assert.equal(h.authorized.length, 4, "a crashed runtime must not be authorized again");
    assert.equal(h.attached.length, 4, "a crashed runtime must not be reattached");
    await h.service.handleSessionEvent({
      type: "disposed",
      session: { ...session, status: "disconnected" },
    });
  }
});

test("runtime exit clears the cached provider choice but ordinary reconnect preserves it", async () => {
  const providers = [
    provider("com.example", "com.example.input", "input"),
    provider("com.other", "com.other.input", "input"),
  ];
  const h = harness({
    providers,
    selectedProviderId: "com.example.input",
  });
  await h.service.configureDirection(session, "input");
  assert.equal(h.selections.length, 1);

  const withdrawn = providers.splice(0);
  h.runtimeListeners[0]({
    status: "stopped",
    pluginId: "com.example",
    runtimeId: "runtime-1",
  });
  providers.push(...withdrawn);
  await h.service.configureDirection(session, "input");
  assert.equal(h.selections.length, 2, "a stopped runtime must discard its session-local choice");
});

test("an expected runtime close waits for the stopped event instead of quarantining", async () => {
  let currentIdentity;
  const h = harness({ getRuntimeIdentity: () => currentIdentity });
  currentIdentity = h.identity;
  assert.equal((await h.service.configureDirection(session, "input")).status, "active");

  currentIdentity = null;
  h.worker.warningListener({
    sessionId: session.sessionId,
    direction: "input",
    code: "closed",
    message: "Terminal interceptor stopped and was disabled",
  });
  assert.equal(h.warnings.length, 0);

  h.runtimeListeners[0]({
    status: "stopped",
    pluginId: "com.example",
    runtimeId: "runtime-1",
  });
  currentIdentity = h.identity;
  assert.equal((await h.service.configureDirection(session, "input")).status, "active");
  assert.equal(h.warnings.length, 0);
  assert.equal(h.authorized.length, 4);
  assert.equal(h.attached.length, 4);
});

test("a close during runtime failure is quarantined by the authoritative error event", async () => {
  let currentIdentity;
  const h = harness({ getRuntimeIdentity: () => currentIdentity });
  currentIdentity = h.identity;
  assert.equal((await h.service.configureDirection(session, "input")).status, "active");

  currentIdentity = null;
  h.worker.warningListener({
    sessionId: session.sessionId,
    direction: "input",
    code: "closed",
    message: "Terminal interceptor stopped and was disabled",
  });
  h.runtimeListeners[0]({
    status: "error",
    pluginId: "com.example",
    runtimeId: "runtime-1",
    error: "utility runtime crashed",
  });

  const [result] = await h.service.handleSessionEvent({ type: "connected", session });
  assert.equal(result.status, "declined");
  assert.deepEqual(h.warnings.map((warning) => warning.code), ["runtime-error"]);
  assert.equal(h.authorized.length, 2);
  assert.equal(h.attached.length, 2);
});

test("terminal worker exit invalidates active bindings before worker restart", async () => {
  const h = harness();
  await h.service.configureDirection(session, "input");
  h.worker.warningListener({ code: "worker-exit", message: "Terminal worker exited" });
  await h.service.configureDirection(session, "input");
  assert.equal(h.authorized.length, 4);
  assert.equal(h.attached.length, 4);
});

test("a failed interceptor stays quarantined for the rest of the session", async () => {
  const h = harness();
  assert.equal((await h.service.configureDirection(session, "input")).status, "active");

  h.worker.warningListener({
    sessionId: session.sessionId,
    direction: "input",
    code: "timeout",
    message: "Interceptor timed out",
  });

  const [result] = await h.service.handleSessionEvent({ type: "connected", session });
  assert.equal(result.status, "declined");
  assert.equal(h.authorized.length, 2, "the quarantined provider must not be authorized again");
  assert.equal(h.attached.length, 2, "the quarantined provider must not be reattached");
  assert.equal(h.warnings.length, 1);
});

test("permission revocation while a port is attaching prevents the worker attachment", async () => {
  let releaseAttach;
  const attachGate = new Promise((resolve) => { releaseAttach = resolve; });
  const h = harness({ onAttachTerminalInterceptor: () => attachGate });

  const activation = h.service.configureDirection(session, "input");
  while (h.attached.length === 0) await new Promise((resolve) => setImmediate(resolve));
  h.revokePermission({ pluginId: "com.example", permission: "terminal.intercept.input" });
  releaseAttach();

  await assert.rejects(
    () => activation,
    (error) => error?.code === RPC_ERRORS.permissionDenied,
  );
  assert.deepEqual(h.attached.map((entry) => entry.side), ["plugin"]);
});

test("a concurrent metadata refresh cannot revive a quarantined interceptor", async () => {
  let attachCalls = 0;
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => { releaseRefresh = resolve; });
  const h = harness({
    onAttachTerminalInterceptor() {
      attachCalls += 1;
      return attachCalls === 2 ? refreshGate : undefined;
    },
  });
  assert.equal((await h.service.configureDirection(session, "input")).status, "active");

  const refresh = h.service.configureDirection({ ...session, title: "new title" }, "input");
  while (h.attached.length < 3) await new Promise((resolve) => setImmediate(resolve));
  h.worker.warningListener({
    sessionId: session.sessionId,
    direction: "input",
    code: "timeout",
    message: "Interceptor timed out",
  });
  releaseRefresh();

  await assert.rejects(
    () => refresh,
    (error) => error?.code === RPC_ERRORS.unavailable,
  );
  assert.deepEqual(h.attached.map((entry) => entry.side), ["plugin", "worker", "plugin"]);
  assert.equal((await h.service.configureDirection(session, "input")).status, "declined");
});

test("a runtime crash reported after its first port attachment fails still quarantines the interceptor", async () => {
  let rejectAttach;
  const attachGate = new Promise((_resolve, reject) => { rejectAttach = reject; });
  const h = harness({ onAttachTerminalInterceptor: () => attachGate });

  const activation = h.service.configureDirection(session, "input");
  while (h.attached.length === 0) await new Promise((resolve) => setImmediate(resolve));
  rejectAttach(new Error("plugin runtime transport closed"));
  await assert.rejects(() => activation, /transport closed/);

  h.runtimeListeners[0]({
    status: "error",
    pluginId: "com.example",
    runtimeId: h.identity.runtimeId,
    error: "utility runtime crashed during attachment",
  });
  assert.deepEqual(h.attached.map((entry) => entry.side), ["plugin"]);
  assert.equal((await h.service.configureDirection(session, "input")).status, "declined");
  assert.equal(h.authorized.length, 2);
  assert.deepEqual(h.warnings.map((warning) => warning.code), ["runtime-error"]);
});

test("a runtime crash during first provider activation prevents automatic retry", async () => {
  let rejectActivation;
  const activationGate = new Promise((_resolve, reject) => { rejectActivation = reject; });
  const h = harness({ onActivateProvider: () => activationGate });

  const activation = h.service.configureDirection(session, "input");
  while (h.activationCalls.length === 0) await new Promise((resolve) => setImmediate(resolve));
  h.runtimeListeners[0]({
    status: "error",
    pluginId: "com.example",
    runtimeId: h.identity.runtimeId,
    error: "utility runtime crashed during activation",
  });
  rejectActivation(new Error("plugin activation transport closed"));

  await assert.rejects(() => activation, /transport closed/);
  assert.equal((await h.service.configureDirection(session, "input")).status, "declined");
  assert.equal(h.activationCalls.length, 1);
  assert.equal(h.authorized.length, 0);
  assert.deepEqual(h.warnings.map((warning) => warning.code), ["runtime-error"]);
});

test("a late crash from an old session generation cannot quarantine a reused session id", async () => {
  let rejectOldActivation;
  let activationCalls = 0;
  const oldActivationGate = new Promise((_resolve, reject) => { rejectOldActivation = reject; });
  const h = harness({
    onActivateProvider() {
      activationCalls += 1;
      return activationCalls === 1 ? oldActivationGate : undefined;
    },
  });

  const oldActivation = h.service.handleSessionEvent({ type: "snapshot", session });
  while (h.activationCalls.length === 0) await new Promise((resolve) => setImmediate(resolve));
  await h.service.handleSessionEvent({ type: "disposed", session });
  const newActivation = h.service.handleSessionEvent({ type: "created", session });

  h.runtimeListeners[0]({
    status: "error",
    pluginId: "com.example",
    runtimeId: h.identity.runtimeId,
    error: "old utility runtime crashed late",
  });
  rejectOldActivation(new Error("old plugin activation transport closed"));

  const oldResult = await oldActivation;
  const newResult = await newActivation;
  assert.equal(oldResult[0].status, "cancelled");
  assert.notEqual(newResult[0].status, "declined");
  assert.equal(h.activationCalls.length, 2);
  assert.deepEqual(h.warnings.filter((warning) => warning.code === "runtime-error"), []);
});

test("a normal stop before provider activation rejects cannot become a later crash record", async () => {
  let rejectActivation;
  let activationCalls = 0;
  const activationGate = new Promise((_resolve, reject) => { rejectActivation = reject; });
  const h = harness({
    onActivateProvider() {
      activationCalls += 1;
      return activationCalls === 1 ? activationGate : undefined;
    },
  });

  const first = h.service.configureDirection(session, "input");
  while (h.activationCalls.length === 0) await new Promise((resolve) => setImmediate(resolve));
  h.runtimeListeners[0]({
    status: "stopped",
    pluginId: "com.example",
    runtimeId: h.identity.runtimeId,
  });
  rejectActivation(new Error("plugin stopped during activation"));
  await assert.rejects(
    () => first,
    (error) => error?.code === RPC_ERRORS.cancelled,
  );

  h.runtimeListeners[0]({
    status: "error",
    pluginId: "com.example",
    runtimeId: h.identity.runtimeId,
    error: "unrelated later crash",
  });
  assert.equal((await h.service.configureDirection(session, "input")).status, "active");
  assert.equal(h.activationCalls.length, 2);
  assert.deepEqual(h.warnings, []);
});

test("normal cancellation and an already-reported crash do not emit duplicate activation warnings", async () => {
  let rejectActivation;
  const activationGate = new Promise((_resolve, reject) => { rejectActivation = reject; });
  const normal = harness({ onActivateProvider: () => activationGate });
  const normalEvent = normal.service.handleSessionEvent({ type: "snapshot", session });
  while (normal.activationCalls.length === 0) await new Promise((resolve) => setImmediate(resolve));
  normal.runtimeListeners[0]({
    status: "stopped",
    pluginId: "com.example",
    runtimeId: normal.identity.runtimeId,
  });
  rejectActivation(new Error("runtime stopped"));
  const normalResults = await normalEvent;
  assert.equal(normalResults[0].status, "cancelled");
  assert.deepEqual(normal.warnings, []);

  let rejectCrash;
  const crashGate = new Promise((_resolve, reject) => { rejectCrash = reject; });
  const crashed = harness({ onActivateProvider: () => crashGate });
  const crashEvent = crashed.service.handleSessionEvent({ type: "snapshot", session });
  while (crashed.activationCalls.length === 0) await new Promise((resolve) => setImmediate(resolve));
  crashed.runtimeListeners[0]({
    status: "error",
    pluginId: "com.example",
    runtimeId: crashed.identity.runtimeId,
    error: "runtime crashed",
  });
  rejectCrash(new Error("transport closed"));
  const crashResults = await crashEvent;
  assert.equal(crashResults[0].status, "cancelled");
  assert.deepEqual(crashed.warnings.map((warning) => warning.code), ["runtime-error"]);
});

test("contribution changes do not clear a failed interceptor quarantine", async () => {
  const h = harness();
  assert.equal((await h.service.configureDirection(session, "input")).status, "active");

  h.worker.warningListener({
    sessionId: session.sessionId,
    direction: "input",
    code: "protocol",
    message: "Interceptor returned an invalid frame",
  });
  h.contributionListeners[0]();

  const [result] = await h.service.handleSessionEvent({ type: "snapshot", session });
  assert.equal(result.status, "declined");
  assert.equal(h.authorized.length, 2);
  assert.equal(h.attached.length, 2);
});
