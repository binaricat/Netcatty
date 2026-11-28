"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const EventEmitter = require("node:events");
const { Readable, Writable } = require("node:stream");
const { PluginHostVaultService } = require("./hostVaultService.cjs");
const { PluginHostVaultDataBridge } = require("./hostVaultDataBridge.cjs");
const { PluginHostSshExecTransport } = require("./hostSshExecTransport.cjs");
const { PluginHostSshSftpTransport } = require("./hostSshSftpTransport.cjs");
const { PluginHostCapabilitiesService } = require("./hostCapabilitiesService.cjs");
const { PluginHostInteractionService } = require("./hostInteractionService.cjs");
const { PluginHostRpcRegistry } = require("./hostRpcRegistry.cjs");
const { RPC_ERRORS } = require("./rpcRouter.cjs");

function createFakeSender(id = 1) {
  const emitter = new EventEmitter();
  emitter.id = id;
  emitter.sent = [];
  emitter.isDestroyed = () => false;
  emitter.send = (channel, payload) => emitter.sent.push({ channel, payload });
  return emitter;
}

function createFakeSftpSubsystem(files) {
  return {
    once() {},
    readdir(dirPath, cb) {
      if (dirPath !== "/srv") return cb(Object.assign(new Error("No such file"), { code: 2 }));
      cb(null, [
        { filename: "app.conf", attrs: { mode: 0o100644, size: 12, mtime: 1700000000 } },
        { filename: "logs", attrs: { mode: 0o040755, size: 4096, mtime: 1700000001 } },
      ]);
    },
    lstat(target, cb) {
      if (files.has(target)) {
        const content = files.get(target);
        return cb(null, { mode: content === "DIR" ? 0o040755 : 0o100644, size: content === "DIR" ? 0 : content.length, mtime: 1700000000 });
      }
      cb(Object.assign(new Error("No such file"), { code: 2 }));
    },
    createReadStream(target) {
      const content = files.get(target);
      if (content === undefined || content === "DIR") {
        const s = new Readable({ read() {} });
        queueMicrotask(() => s.emit("error", Object.assign(new Error("No such file"), { code: 2 })));
        return s;
      }
      return Readable.from([Buffer.from(content)]);
    },
    createWriteStream(target) {
      const chunks = [];
      const w = new Writable({
        write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
      });
      w.on("finish", () => {
        files.set(target, Buffer.concat(chunks).toString("utf8"));
        w.emit("close");
      });
      return w;
    },
    mkdir(target, cb) { files.set(target, "DIR"); cb(null); },
    unlink(target, cb) {
      if (!files.has(target)) return cb(Object.assign(new Error("No such file"), { code: 2 }));
      files.delete(target);
      cb(null);
    },
    rmdir(target, cb) {
      if (!files.has(target)) return cb(Object.assign(new Error("No such file"), { code: 2 }));
      files.delete(target);
      cb(null);
    },
  };
}

function createCapabilitiesHarness() {
  let locked = false;
  const lockListeners = new Set();
  const auditEvents = [];
  const sender = createFakeSender(1);
  const win = { webContents: sender, isDestroyed: () => false, isVisible: () => true };

  const vaultDataBridge = new PluginHostVaultDataBridge({
    getWindow: () => win,
    isLocked: () => locked,
    subscribeLock: (fn) => { lockListeners.add(fn); return () => lockListeners.delete(fn); },
  });
  vaultDataBridge.setReady(sender, true);

  const sftpFiles = new Map([["/srv/app.conf", "hello=world\n"], ["/srv/big.txt", "0123456789ABCDEF"]]);
  const fakeSftp = createFakeSftpSubsystem(sftpFiles);
  let dialCount = 0;

  const sshExecTransport = new PluginHostSshExecTransport({
    portForwardingBridge: {
      async startPortForward(_ev, opts, hooks) {
        dialCount += 1;
        const conn = new EventEmitter();
        conn._remoteVer = "SSH-2.0-OpenSSH_9.6";
        conn._sock = { destroyed: false, writableEnded: false };
        conn.sftp = (cb) => cb(null, fakeSftp);
        await hooks.bindChannels({ conn, tunnelState: { status: "connecting", tunnelId: opts.tunnelId }, chainConnections: [] });
        return { success: true };
      },
      async stopPortForward() { return { success: true }; },
    },
    isLocked: () => locked,
    subscribeLock: (fn) => { lockListeners.add(fn); return () => lockListeners.delete(fn); },
    getSender: () => sender,
  });
  const sshSftpTransport = new PluginHostSshSftpTransport({ sshExecTransport });

  const sourceOwner = "source:official:com.test.cap";
  const database = {
    privateOwner: (id) => (id === "com.test.cap" ? sourceOwner : `source:other:${id}`),
    recordSecurityAudit: (pluginId, event, details) => auditEvents.push({ pluginId, event, details }),
  };

  const interactionService = {
    owner: { id: 1 },
    ownerGeneration: 1,
    database,
    permissionEngine: { onDidRevoke: () => ({ dispose() {} }) },
    admitRequest() {},
    async request(params, context) { return { params, context }; },
  };
  const bindingObj = Object.freeze({ pluginId: "com.test.cap", runtimeId: "rt-cap" });
  const hostVaultService = new PluginHostVaultService({
    sourceBinding: { resolve: async () => bindingObj, releaseRuntime() {}, shutdown() {} },
    interactionService,
    vaultDataBridge,
    sshExecTransport,
    database,
  });

  const probeCalls = [];
  const capabilitiesService = new PluginHostCapabilitiesService({
    hostVaultService,
    vaultDataBridge,
    sshSftpTransport,
    database,
    probeRemoteDesktopFn: async (opts) => {
      probeCalls.push(opts);
      return { ok: true, reachable: true, protocol: opts.protocol, port: opts.port, rttMs: 18, bannerVerified: true, bannerDetail: "RDP TLS", checkedAt: 1700000000000 };
    },
    probeTcpFn: async ({ port }) => ({ reachable: true, protocol: "ssh", port, rttMs: 9, bannerVerified: true, bannerDetail: "SSH-2.0-OpenSSH_9.6", checkedAt: 1700000000000 }),
    isLocked: () => locked,
    subscribeLock: (fn) => { lockListeners.add(fn); return () => lockListeners.delete(fn); },
  });

  const registry = new PluginHostRpcRegistry();
  hostVaultService.registerRpcCapabilities(registry);
  capabilitiesService.registerRpcCapabilities(registry);

  const ctx = {
    pluginId: "com.test.cap",
    pluginVersion: "0.1.0",
    runtimeId: "rt-cap",
    runtimeKind: "browser",
    sourceOwner,
    manifest: {
      features: {
        required: [
          "vault.host-actions", "vault.host-exec", "vault.host-probe", "vault.host-sftp",
          "vault.port-forwarding", "vault.snippets", "terminal.session-control", "workspace.tabs",
        ],
      },
      permissions: {
        required: [
          "vault.metadata", "vault.write", "vault.hostExec", "sftp.read", "sftp.write",
          "portForward.read", "portForward.manage", "snippets.read", "snippets.write",
          "terminal.metadata", "terminal.output", "terminal.input", "ui.interact",
          "workspace.read", "workspace.navigate",
        ],
      },
    },
    assertActive: async () => {},
    signal: new AbortController().signal,
  };

  const invoke = async (method, params = {}, overrideCtx = ctx) => {
    const reg = registry.requests.get(method);
    assert.ok(reg, `RPC ${method} not registered`);
    const validated = reg.validateParams ? reg.validateParams(params) : params;
    if (typeof reg.authorization === "function") {
      await reg.authorization(validated, overrideCtx);
    }
    return reg.handler(validated, overrideCtx);
  };

  const wireDataResponder = (fn) => {
    const orig = sender.send.bind(sender);
    sender.send = (channel, payload) => {
      orig(channel, payload);
      if (channel === "netcatty:plugins:vault-data-request") {
        queueMicrotask(async () => {
          try {
            const data = await fn(payload.kind, payload.payload);
            vaultDataBridge.respond(sender, { requestId: payload.requestId, actionToken: payload.actionToken, ok: true, data });
          } catch (err) {
            vaultDataBridge.respond(sender, { requestId: payload.requestId, actionToken: payload.actionToken, ok: false, error: err?.message ?? "err" });
          }
        });
      }
    };
  };

  const bindHost = async (hostId = "host-1") => {
    const out = await hostVaultService.respond(
      { phase: "request", params: { kind: "vault.selectHosts", title: "Bind", durable: true }, context: { ...ctx, vaultBinding: bindingObj } },
      { action: "submit", resources: [{ resourceId: hostId, revision: "r1", label: "Srv", hostname: "10.0.0.10", username: "ubuntu", port: 22, group: "Prod", tags: ["web"], protocol: "ssh" }] },
    );
    return out.result.hosts[0].hostBindingToken;
  };

  return {
    invoke,
    bindHost,
    wireDataResponder,
    sftpFiles,
    auditEvents,
    probeCalls,
    getDialCount: () => dialCount,
    setLocked(v) { locked = v; for (const fn of lockListeners) fn({ locked: v }); },
    shutdown() { capabilitiesService.shutdown(); hostVaultService.shutdown(); },
  };
}

test("vault.probeHost probes configured RDP/VNC/SSH ports and blocks arbitrary port scanning", async () => {
  const h = createCapabilitiesHarness();
  const token = await h.bindHost("host-rdp");
  h.wireDataResponder(async (kind) => {
    if (kind === "prepareProbeTarget") {
      return { hostname: "10.0.0.50", sshPort: 22, rdpPort: 3389, defaultProtocol: "rdp", rdpSecurityMode: "auto" };
    }
    throw new Error(`unexpected ${kind}`);
  });

  const rdp = await h.invoke("vault.probeHost", { hostBindingToken: token });
  assert.equal(rdp.reachable, true);
  assert.equal(rdp.protocol, "rdp");
  assert.equal(rdp.port, 3389);
  assert.equal(rdp.rttMs, 18);

  const ssh = await h.invoke("vault.probeHost", { hostBindingToken: token, protocol: "ssh" });
  assert.equal(ssh.reachable, true);
  assert.equal(ssh.protocol, "ssh");
  assert.equal(ssh.port, 22);

  // Anti-port-scan: arbitrary port rejected
  await assert.rejects(
    h.invoke("vault.probeHost", { hostBindingToken: token, protocol: "rdp", port: 8080 }),
    (err) => err.code === RPC_ERRORS.permissionDenied,
  );
  // Unconfigured protocol rejected
  await assert.rejects(
    h.invoke("vault.probeHost", { hostBindingToken: token, protocol: "vnc" }),
    (err) => err.code === RPC_ERRORS.failedPrecondition,
  );

  h.shutdown();
});

test("vault.sftp.* runs bounded list/stat/read/write/mkdir/delete over pooled SSH and rejects root deletion", async () => {
  const h = createCapabilitiesHarness();
  const token = await h.bindHost("host-sftp");
  h.wireDataResponder(async (kind, payload) => {
    if (kind === "prepareConnection") return { connectionOptions: { hostId: payload.hostId, hostname: "10.0.0.10", username: "ubuntu" } };
    throw new Error(`unexpected ${kind}`);
  });

  const listed = await h.invoke("vault.sftp.listDir", { hostBindingToken: token, path: "/srv" });
  assert.equal(listed.entries.length, 2);
  assert.equal(listed.entries[0].name, "app.conf");

  const st = await h.invoke("vault.sftp.stat", { hostBindingToken: token, path: "/srv/app.conf" });
  assert.equal(st.exists, true);
  assert.equal(st.type, "file");

  const readTrunc = await h.invoke("vault.sftp.readFile", { hostBindingToken: token, path: "/srv/big.txt", maxBytes: 8 });
  assert.equal(readTrunc.data, "01234567");
  assert.equal(readTrunc.truncated, true);

  const written = await h.invoke("vault.sftp.writeFile", { hostBindingToken: token, path: "/srv/new.txt", data: "abc123", encoding: "utf8" });
  assert.equal(written.bytesWritten, 6);
  assert.equal(h.sftpFiles.get("/srv/new.txt"), "abc123");

  await h.invoke("vault.sftp.mkdir", { hostBindingToken: token, path: "/srv/sub" });
  assert.equal(h.sftpFiles.get("/srv/sub"), "DIR");

  await h.invoke("vault.sftp.delete", { hostBindingToken: token, path: "/srv/new.txt" });
  assert.equal(h.sftpFiles.has("/srv/new.txt"), false);

  // Destructive root/home delete rejected (including trailing slash ~/ )
  for (const badPath of ["/", ".", "..", "~", "~/", "///..//"]) {
    await assert.rejects(
      h.invoke("vault.sftp.delete", { hostBindingToken: token, path: badPath }),
      (err) => err.code === RPC_ERRORS.invalidArgument,
    );
  }
  // Reused single pooled SSH dial across all 6 SFTP operations
  assert.equal(h.getDialCount(), 1);

  h.shutdown();
});

test("portForward, snippets, vault annotations, terminals, and workspace enforce bounds and secret-free auditing", async () => {
  const h = createCapabilitiesHarness();
  const token = await h.bindHost("host-ops");
  const received = [];
  h.wireDataResponder(async (kind, payload) => {
    received.push({ kind, payload });
    if (kind === "listGroups") return { groups: [{ path: "Prod", hostCount: 3 }] };
    if (kind === "updateHostNotes" || kind === "updateHostTags") return { updated: true };
    if (kind === "portForward.list") return { rules: [] };
    if (kind === "portForward.create") return { ok: true, rule: { id: "pf-1", label: payload.label, type: payload.type, localPort: payload.localPort, bindAddress: payload.bindAddress, status: "inactive" } };
    if (kind === "portForward.start" || kind === "portForward.stop" || kind === "portForward.delete") return { ok: true };
    if (kind === "snippets.list") return { snippets: [{ id: "s1", label: "Disk", command: "df -h" }] };
    if (kind === "snippets.get") return { found: true, snippet: { id: "s1", label: "Disk", command: "df -h" } };
    if (kind === "snippets.save") return { snippet: { id: "s2", label: payload.label, command: payload.command } };
    if (kind === "snippets.delete") return { deleted: true };
    if (kind === "terminals.listSessions") return { sessions: [{ sessionId: "sess-1", label: "Prod", hostname: "10.0.0.10", protocol: "ssh", status: "connected", active: true }] };
    if (kind === "terminals.readScreen") return { sessionId: payload.sessionId, rows: 24, cols: 80, lines: ["line 1", "line 2"] };
    if (kind === "terminals.sendInput") return { sent: true };
    if (kind === "terminals.openLocal") return { opened: true, sessionId: "local-1" };
    if (kind === "workspace.listTabs") return { activeTabId: "vault", tabs: [{ id: "vault", kind: "vault", title: "Vault", active: true }] };
    if (kind === "workspace.focusTab") return { focused: true };
    throw new Error(`unexpected ${kind}`);
  });

  assert.equal((await h.invoke("vault.listGroups")).groups[0].path, "Prod");
  assert.equal((await h.invoke("vault.updateHostNotes", { hostBindingToken: token, notes: "primary" })).updated, true);
  assert.equal((await h.invoke("vault.updateHostTags", { hostBindingToken: token, tags: ["prod"] })).updated, true);

  const pfCreated = await h.invoke("portForward.create", { hostBindingToken: token, label: "PG", type: "local", localPort: 5432, remoteHost: "127.0.0.1", remotePort: 5432 });
  assert.equal(pfCreated.ok, true);
  assert.equal(pfCreated.rule.bindAddress, "127.0.0.1");
  assert.equal(received.find((r) => r.kind === "portForward.create").payload.hostId, "host-ops");
  assert.equal((await h.invoke("portForward.start", { ruleId: "pf-1" })).ok, true);
  assert.equal((await h.invoke("portForward.stop", { ruleId: "pf-1" })).ok, true);
  assert.equal((await h.invoke("portForward.delete", { ruleId: "pf-1" })).ok, true);

  assert.equal((await h.invoke("snippets.list", { query: "df" })).snippets.length, 1);
  assert.equal((await h.invoke("snippets.save", { label: "Uptime", command: "uptime" })).snippet.label, "Uptime");
  assert.equal((await h.invoke("snippets.delete", { id: "s2" })).deleted, true);

  assert.equal((await h.invoke("terminals.listSessions")).sessions.length, 1);
  assert.deepEqual((await h.invoke("terminals.readScreen", { sessionId: "sess-1", maxRows: 10 })).lines, ["line 1", "line 2"]);
  assert.equal((await h.invoke("terminals.sendInput", { sessionId: "sess-1", data: "super-secret-token\n" })).sent, true);
  const inputAudit = h.auditEvents.find((e) => e.event === "terminal.sendInput");
  assert.ok(inputAudit);
  assert.equal(inputAudit.details.sessionId, "sess-1");
  assert.equal(inputAudit.details.bytes, 19);
  assert.equal(JSON.stringify(inputAudit).includes("super-secret-token"), false, "audit must never log raw terminal input");

  assert.equal((await h.invoke("terminals.openLocal")).opened, true);
  assert.equal((await h.invoke("workspace.listTabs")).activeTabId, "vault");
  assert.equal((await h.invoke("workspace.focusTab", { tabId: "vault" })).focused, true);

  h.shutdown();
});

test("ui.openExternalUrl rejects non-HTTPS/credential URLs and only opens after host confirmation", async () => {
  const openedUrls = [];
  const sender = createFakeSender(1);
  const win = { webContents: sender, isDestroyed: () => false, isVisible: () => true, isFocused: () => true, once() {}, removeListener() {} };
  const interactionService = new PluginHostInteractionService({
    database: { recordSecurityAudit() {} },
    permissionEngine: { onDidRevoke: () => ({ dispose() {} }), getMode: () => "allow" },
    quotaManager: { chargeBytes() {} },
    shell: { openExternal: async (u) => { openedUrls.push(u); } },
    getWindow: () => win,
    isLocked: () => false,
  });
  interactionService.setReady(sender, true);
  const registry = new PluginHostRpcRegistry();
  interactionService.registerRpcCapabilities(registry);
  const interactReg = registry.requests.get("ui.interact");

  for (const badUrl of [
    "http://example.com",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:pass@example.com/secret",
  ]) {
    assert.throws(() => interactReg.validateParams({ kind: "openExternalUrl", url: badUrl }));
  }

  const validParams = interactReg.validateParams({ kind: "openExternalUrl", url: "https://netcatty.app/docs" });
  const reqCtx = {
    pluginId: "com.test.cap",
    pluginVersion: "0.1.0",
    runtimeId: "rt-1",
    assertActive: async () => {},
    signal: new AbortController().signal,
  };
  interactionService.admitRequest(validParams, reqCtx);
  const reqPromise = interactionService.request(validParams, reqCtx);
  await new Promise((r) => setTimeout(r, 10));
  const promptMsg = sender.sent.find((m) => m.channel === "netcatty:plugins:host-interaction")?.payload;
  assert.ok(promptMsg);
  assert.equal(openedUrls.length, 0, "must not open URL before user confirmation");

  await interactionService.respond(sender, {
    requestId: promptMsg.requestId,
    actionToken: promptMsg.actionToken,
    action: "submit",
  });
  const res = await reqPromise;
  assert.equal(res.cancelled, false);
  assert.equal(res.value, true);
  assert.deepEqual(openedUrls, ["https://netcatty.app/docs"]);

  interactionService.shutdown();
});

test("portForward.create rejects non-loopback bindAddress, SFTPWrapper error events do not crash, and silent TCP host probes reachable", async () => {
  const net = require("node:net");
  const { probeTcpReachability } = require("./hostCapabilitiesService.cjs");

  // 1. portForward.create rejects 0.0.0.0 and ::
  const h = createCapabilitiesHarness();
  const token = await h.bindHost("host-pf-guard");
  for (const badBind of ["0.0.0.0", "::", "192.168.1.10"]) {
    await assert.rejects(
      h.invoke("portForward.create", { hostBindingToken: token, label: "Expose", type: "local", localPort: 5432, bindAddress: badBind }),
      (err) => err.code === RPC_ERRORS.invalidArgument,
    );
  }

  // 2. SFTPWrapper async 'error' event is handled (no uncaught ERR_UNHANDLED_ERROR)
  const fakeSftp = new EventEmitter();
  fakeSftp.readdir = (_p, cb) => cb(null, []);
  const sftpTransport = new PluginHostSshSftpTransport({
    sshExecTransport: {
      async acquireConnection() {
        const conn = { sftp: (cb) => cb(null, fakeSftp) };
        return { conn, signal: new AbortController().signal, invalidate() {}, release() {} };
      },
    },
  });
  await sftpTransport.listDir({}, "/");
  assert.doesNotThrow(() => fakeSftp.emit("error", new Error("async sftp channel reset")));

  // 3. probeTcpReachability returns reachable: true when TCP connects but server sends no banner before timeout
  const server = net.createServer((socket) => { socket.resume(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const probed = await probeTcpReachability({ host: "127.0.0.1", port, timeoutMs: 80, signal: new AbortController().signal });
    assert.equal(probed.reachable, true, "connected silent TCP host must report reachable: true");
    assert.equal(probed.bannerVerified, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  h.shutdown();
});
