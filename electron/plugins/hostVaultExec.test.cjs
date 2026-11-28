"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const EventEmitter = require("node:events");
const { PluginHostVaultService } = require("./hostVaultService.cjs");
const { PluginHostVaultDataBridge } = require("./hostVaultDataBridge.cjs");
const { PluginHostSshExecTransport } = require("./hostSshExecTransport.cjs");
const { PluginHostRpcRegistry } = require("./hostRpcRegistry.cjs");
const { RPC_ERRORS } = require("./rpcRouter.cjs");

function createFakeSender(id = 1) {
  const emitter = new EventEmitter();
  emitter.id = id;
  emitter.sent = [];
  emitter.isDestroyed = () => false;
  emitter.send = (channel, payload) => {
    emitter.sent.push({ channel, payload });
  };
  return emitter;
}

function createVaultTestHarness({ locked = false, sourceOwner = "source:official:com.binaricat.netcatty-monitor" } = {}) {
  let isAppLocked = locked;
  const lockListeners = new Set();
  const revokeListeners = new Set();
  const sender = createFakeSender(1);
  const win = { webContents: sender, isDestroyed: () => false };

  const vaultDataBridge = new PluginHostVaultDataBridge({
    getWindow: () => win,
    isLocked: () => isAppLocked,
    subscribeLock: (listener) => {
      lockListeners.add(listener);
      return () => lockListeners.delete(listener);
    },
  });
  vaultDataBridge.setReady(sender, true);

  let stopCount = 0;
  let dialCount = 0;
  let nextRemoteVer = "SSH-2.0-OpenSSH_9.6";
  let execHandler = async (_conn, command) => ({
    stdout: `ok:${command}`,
    stderr: "",
    exitCode: 0,
    truncated: false,
  });

  const fakePortForwardBridge = {
    async startPortForward(_event, opts, hooks) {
      dialCount += 1;
      const conn = new EventEmitter();
      conn._remoteVer = nextRemoteVer;
      conn._sock = { destroyed: false, writableEnded: false };
      const tunnelState = { status: "connecting", tunnelId: opts.tunnelId };
      try {
        await hooks.bindChannels({ conn, tunnelState, chainConnections: [] });
        return { success: true };
      } catch {
        return { success: false };
      }
    },
    async stopPortForward() {
      stopCount += 1;
      return { success: true };
    },
  };

  const sshExecTransport = new PluginHostSshExecTransport({
    portForwardingBridge: fakePortForwardBridge,
    execCommand: (conn, cmd, opts) => execHandler(conn, cmd, opts),
    measurePing: async () => 12,
    isLocked: () => isAppLocked,
    subscribeLock: (listener) => {
      lockListeners.add(listener);
      return () => lockListeners.delete(listener);
    },
    getSender: () => sender,
  });

  const interactionService = {
    owner: { id: 1 },
    ownerGeneration: 1,
    database: {
      privateOwner: (pluginId) => (pluginId === "com.binaricat.netcatty-monitor" ? sourceOwner : `source:other:${pluginId}`),
    },
    permissionEngine: {
      onDidRevoke: (fn) => {
        revokeListeners.add(fn);
        return { dispose: () => revokeListeners.delete(fn) };
      },
    },
    admitRequest() {},
    async request(params, context) {
      return { params, context };
    },
  };

  const bindingObj = Object.freeze({ pluginId: "com.binaricat.netcatty-monitor", runtimeId: "rt-1" });
  const sourceBinding = {
    resolve: async () => bindingObj,
    releaseRuntime() {},
    shutdown() {},
  };

  const service = new PluginHostVaultService({
    sourceBinding,
    interactionService,
    vaultDataBridge,
    sshExecTransport,
    database: interactionService.database,
  });

  const registry = new PluginHostRpcRegistry();
  service.registerRpcCapabilities(registry);

  const makeContext = (overrides = {}) => ({
    pluginId: "com.binaricat.netcatty-monitor",
    pluginVersion: "0.1.0",
    runtimeId: "rt-1",
    runtimeKind: "browser",
    sourceOwner,
    manifest: {
      features: { required: ["vault.host-actions", "vault.host-exec"] },
      permissions: { required: ["vault.metadata", "vault.hostExec", "ui.interact"] },
    },
    assertActive: async () => {},
    signal: new AbortController().signal,
    ...overrides,
  });

  const respondNextVaultData = (handler) => {
    const origSend = sender.send.bind(sender);
    sender.send = (channel, payload) => {
      origSend(channel, payload);
      if (channel === "netcatty:plugins:vault-data-request") {
        queueMicrotask(async () => {
          try {
            const data = await handler(payload);
            vaultDataBridge.respond(sender, {
              requestId: payload.requestId,
              actionToken: payload.actionToken,
              ok: true,
              data,
            });
          } catch (err) {
            vaultDataBridge.respond(sender, {
              requestId: payload.requestId,
              actionToken: payload.actionToken,
              ok: false,
              error: err?.message ?? "failed",
            });
          }
        });
      }
    };
  };

  return {
    service,
    registry,
    vaultDataBridge,
    sshExecTransport,
    sender,
    makeContext,
    respondNextVaultData,
    setLocked(next) {
      isAppLocked = next;
      for (const fn of lockListeners) fn({ locked: next });
    },
    emitRevoke(event) {
      for (const fn of revokeListeners) fn(event);
    },
    setNextRemoteVer(ver) { nextRemoteVer = ver; },
    setExecHandler(fn) { execHandler = fn; },
    getStats() { return { dialCount, stopCount }; },
  };
}

test("durable vault.selectHosts issues sourceOwner-scoped tokens, resolves metadata, and executes pooled SSH commands", async () => {
  const h = createVaultTestHarness();
  const ctx = h.makeContext();

  // Simulate selectHosts with durable: true
  const entry = {
    phase: "request",
    params: { kind: "vault.selectHosts", title: "Pick servers", durable: true },
    context: { ...ctx, vaultBinding: await h.service.sourceBinding.resolve(ctx) },
  };
  const selectOut = await h.service.respond(entry, {
    action: "submit",
    resources: [
      {
        resourceId: "host-1",
        revision: "rev-1",
        label: "Prod Web 1",
        hostname: "10.0.0.10",
        username: "ubuntu",
        port: 22,
        group: "Production",
        tags: ["web", "eu"],
        protocol: "ssh",
        os: "ubuntu",
        notes: "Primary edge",
      },
    ],
  });

  assert.equal(selectOut.result.cancelled, false);
  assert.equal(selectOut.result.hosts.length, 1);
  const token = selectOut.result.hosts[0].hostBindingToken;
  assert.match(token, /^hb_/);
  assert.equal(selectOut.result.hosts[0].metadata.os, "ubuntu");
  assert.equal(selectOut.result.hosts[0].metadata.notes, "Primary edge");

  // Wire renderer responder for metadata refresh & connection prep
  let prepareCalls = 0;
  h.respondNextVaultData(async (req) => {
    if (req.kind === "resolveMetadata") {
      return {
        hosts: {
          "host-1": {
            label: "Prod Web 1 Renamed",
            hostname: "10.0.0.10",
            username: "ubuntu",
            port: 22,
            group: "Production",
            tags: ["web"],
            protocol: "ssh",
            os: "ubuntu",
            notes: "Updated note",
          },
        },
      };
    }
    if (req.kind === "prepareConnection") {
      prepareCalls += 1;
      return { connectionOptions: { hostId: req.payload.hostId, hostname: "10.0.0.10", username: "ubuntu" } };
    }
    throw new Error("unexpected");
  });

  // Resolve valid + unknown token
  const resolved = await h.service.resolveHostBindings(
    { hostBindingTokens: [token, "hb_unknown_token_1234567890"] },
    ctx,
  );
  assert.equal(resolved.hosts.length, 2);
  assert.equal(resolved.hosts[0].status, "available");
  assert.equal(resolved.hosts[0].metadata.label, "Prod Web 1 Renamed");
  assert.equal(resolved.hosts[1].status, "revoked");

  // Cross-plugin token must fail closed
  const otherCtx = h.makeContext({ pluginId: "com.other.plugin", sourceOwner: "source:other:com.other.plugin" });
  const crossResolved = await h.service.resolveHostBindings({ hostBindingTokens: [token] }, otherCtx);
  assert.equal(crossResolved.hosts[0].status, "revoked");
  await assert.rejects(
    h.service.execHostCommand({ hostBindingToken: token, command: "uptime" }, otherCtx),
    (err) => err.code === RPC_ERRORS.permissionDenied,
  );

  // Execute 2 SSH commands back-to-back -> should reuse pooled transport (1 dial, 1 prepareConnection)
  const res1 = await h.service.execHostCommand({ hostBindingToken: token, command: "uname -a" }, ctx);
  const res2 = await h.service.execHostCommand({ hostBindingToken: token, command: "uptime" }, ctx);
  assert.equal(res1.stdout, "ok:uname -a");
  assert.equal(res1.exitCode, 0);
  assert.equal(res1.latencyMs, 12);
  assert.equal(res2.stdout, "ok:uptime");
  assert.equal(prepareCalls, 1);
  assert.equal(h.getStats().dialCount, 1);

  // Revoke binding -> closes cached transport immediately & rejects further exec
  const revoked = h.service.revokeDurableBinding(ctx.pluginId, token, ctx.sourceOwner);
  assert.equal(revoked, true);
  assert.equal(h.getStats().stopCount, 1);
  await assert.rejects(
    h.service.execHostCommand({ hostBindingToken: token, command: "uptime" }, ctx),
    (err) => err.code === RPC_ERRORS.permissionDenied,
  );

  h.service.shutdown();
});

test("vault.execHostCommand rejects single-channel SSH banners and aborts on App Lock", async () => {
  const h = createVaultTestHarness();
  const ctx = h.makeContext();

  const selectOut = await h.service.respond(
    {
      phase: "request",
      params: { kind: "vault.selectHosts", title: "Pick", durable: true },
      context: { ...ctx, vaultBinding: await h.service.sourceBinding.resolve(ctx) },
    },
    {
      action: "submit",
      resources: [
        { resourceId: "host-2", revision: "rev-2", label: "Router", hostname: "10.0.0.2", username: "admin", group: "", tags: [], protocol: "ssh" },
      ],
    },
  );
  const token = selectOut.result.hosts[0].hostBindingToken;

  h.respondNextVaultData(async () => ({
    connectionOptions: { hostId: "host-2", hostname: "10.0.0.2", username: "admin" },
  }));

  // Single-channel / appliance banner -> unsupported
  h.setNextRemoteVer("SSH-2.0-Cisco-1.25");
  await assert.rejects(
    h.service.execHostCommand({ hostBindingToken: token, command: "uname -a" }, ctx),
    (err) => err.code === RPC_ERRORS.unsupported,
  );

  // Switch back to OpenSSH and test App Lock aborting an in-flight exec
  h.setNextRemoteVer("SSH-2.0-OpenSSH_9.6");
  h.setExecHandler((_conn, _cmd, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener("abort", () => reject(opts.signal.reason || new Error("aborted")), { once: true });
  }));

  const pendingExec = h.service.execHostCommand({ hostBindingToken: token, command: "sleep 10" }, ctx);
  setTimeout(() => h.setLocked(true), 25);
  await assert.rejects(pendingExec, (err) => err.code === RPC_ERRORS.cancelled || err.code === RPC_ERRORS.unavailable);

  h.service.shutdown();
});

test("vault.requestConnect accepts durable hostBindingToken with sftp mode and vaultDataBridge rejects untrusted senders", async () => {
  const h = createVaultTestHarness();
  const ctx = h.makeContext();

  const selectOut = await h.service.respond(
    {
      phase: "request",
      params: { kind: "vault.selectHosts", title: "Pick", durable: true },
      context: { ...ctx, vaultBinding: await h.service.sourceBinding.resolve(ctx) },
    },
    {
      action: "submit",
      resources: [
        { resourceId: "host-3", revision: "rev-3", label: "App", hostname: "10.0.0.3", username: "root", group: "", tags: [], protocol: "ssh" },
      ],
    },
  );
  const token = selectOut.result.hosts[0].hostBindingToken;

  const reg = h.registry.requests.get("vault.requestConnect");
  const validated = reg.validateParams({ hostBindingToken: token, mode: "sftp" });
  assert.equal(validated.kind, "vault.requestConnect");
  assert.equal(validated.mode, "sftp");
  const promptDesc = h.service.describePrompt({ params: validated, context: ctx });
  assert.equal(promptDesc.durableHostId, "host-3");

  // Reject invalid mode
  assert.throws(() => reg.validateParams({ hostBindingToken: token, mode: "shell" }));

  // VaultDataBridge rejects untrusted sender
  const fakeOtherSender = createFakeSender(99);
  assert.throws(() => h.vaultDataBridge.setReady(fakeOtherSender, true));

  h.service.shutdown();
});

test("vault.execHostCommand maps boundedSshExec { code } to exitCode, maps SSH_EXEC_OUTPUT_LIMIT to resourceExhausted, and isolates concurrent dial cancellation", async () => {
  const h = createVaultTestHarness();
  const ctx = h.makeContext();
  const selectOut = await h.service.respond(
    {
      phase: "request",
      params: { kind: "vault.selectHosts", title: "Pick", durable: true },
      context: { ...ctx, vaultBinding: await h.service.sourceBinding.resolve(ctx) },
    },
    {
      action: "submit",
      resources: [
        { resourceId: "host-real", revision: "rev-r", label: "Real", hostname: "10.0.0.99", username: "ubuntu", group: "", tags: [], protocol: "ssh" },
      ],
    },
  );
  const token = selectOut.result.hosts[0].hostBindingToken;

  let releaseDial;
  let dialStarted = false;
  h.respondNextVaultData(async () => {
    dialStarted = true;
    await new Promise((resolve) => { releaseDial = resolve; });
    return { connectionOptions: { hostId: "host-real", hostname: "10.0.0.99", username: "ubuntu" } };
  });

  // Return boundedSshExec's real `{ stdout, stderr, code }` shape
  h.setExecHandler(async () => ({ stdout: "ok", stderr: "", code: 42 }));

  // Caller A aborts while dial is in flight; Caller B must still succeed!
  const abortA = new AbortController();
  const ctxA = h.makeContext({ signal: abortA.signal });
  const ctxB = h.makeContext();
  const pA = h.service.execHostCommand({ hostBindingToken: token, command: "cmd-a" }, ctxA);
  const pB = h.service.execHostCommand({ hostBindingToken: token, command: "cmd-b" }, ctxB);
  while (!dialStarted) await new Promise((r) => setTimeout(r, 5));
  abortA.abort();
  await assert.rejects(pA, (err) => err.code === RPC_ERRORS.cancelled);
  releaseDial();
  const resB = await pB;
  assert.equal(resB.exitCode, 42, "must read boundedSshExec's `code` property");

  // SSH_EXEC_OUTPUT_LIMIT maps to resourceExhausted
  h.setExecHandler(async () => {
    const err = new Error("Output limit exceeded");
    err.code = "SSH_EXEC_OUTPUT_LIMIT";
    throw err;
  });
  await assert.rejects(
    h.service.execHostCommand({ hostBindingToken: token, command: "big" }, ctxB),
    (err) => err.code === RPC_ERRORS.resourceExhausted,
  );

  h.service.shutdown();
});
