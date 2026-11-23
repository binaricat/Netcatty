"use strict";

// --- merged from sshBridge.agentFallback.test.cjs ---
{
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { Server } = require("ssh2");
const bridge = require("./sshBridge.cjs");
const tempDirBridge = require("./tempDirBridge.cjs");

const listen = (server, ...args) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(...args, resolve);
});
const close = (server) => new Promise((resolve) => server.close(resolve));

test("normal SSH startup preserves fallback after an unavailable system agent", {
  skip: process.platform === "win32", // This fixture exercises Unix agent sockets.
  timeout: 20_000,
}, async (t) => {
  const fixture = fs.mkdtempSync(`${tempDirBridge.getTempFilePath("a")}-`);
  const originalHomedir = os.homedir;
  const originalAgentSocket = process.env.SSH_AUTH_SOCK;
  os.homedir = () => fixture; // Never discover the developer's default keys.
  t.after(() => {
    os.homedir = originalHomedir;
    if (originalAgentSocket === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = originalAgentSocket;
    fs.rmSync(fixture, { recursive: true, force: true });
  });
  const hostKey = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;

  let sequence = 0;
  async function run({ stale = true, useSshAgent, password = "fixture-password", stall = false, jump = false } = {}) {
    const senderId = 3640 + sequence++;
    const socketPath = path.join(fixture, "s");
    fs.rmSync(socketPath, { force: true });
    const agentClients = new Set();
    let agentChecks = 0;
    const agent = net.createServer((socket) => {
      agentClients.add(socket);
      agentChecks += 1;
      socket.on("error", () => {});
      socket.on("close", () => agentClients.delete(socket));
      // SSH_AGENT_IDENTITIES_ANSWER with zero keys.
      socket.once("data", () => socket.end(Buffer.from([0, 0, 0, 5, 12, 0, 0, 0, 0])));
    });
    await listen(agent, socketPath);
    if (stale) {
      // Preserve a real socket entry with no listener, without a timing race.
      fs.renameSync(socketPath, socketPath + ".stale");
      await close(agent);
      fs.renameSync(socketPath + ".stale", socketPath);
      assert.ok(fs.statSync(socketPath).isSocket());
    }
    process.env.SSH_AUTH_SOCK = socketPath;
    const sshClients = new Set();
    const forwardingSockets = new Set();
    const methods = [];
    let shells = 0;
    const ssh = new Server({ hostKeys: [hostKey] }, (client) => {
      sshClients.add(client);
      client.on("error", () => {});
      client.on("close", () => sshClients.delete(client));
      client.on("tcpip", (accept, reject, info) => {
        if (info.destIP !== "127.0.0.1" || info.destPort !== ssh.address().port) return reject();
        const socket = net.connect(info.destPort, info.destIP, () => {
          const stream = accept();
          stream.on("error", () => socket.destroy());
          stream.pipe(socket).pipe(stream);
        });
        forwardingSockets.add(socket);
        socket.on("close", () => forwardingSockets.delete(socket));
        socket.on("error", () => reject());
      });
      client.on("authentication", (ctx) => {
        methods.push(ctx.method);
        if (ctx.method === "password" && stall) return;
        if (ctx.method === "password" && ctx.password === "fixture-password") ctx.accept();
        else ctx.reject(["publickey", "password"]);
      });
      client.on("ready", () => client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (acceptPty) => acceptPty());
        session.on("shell", (acceptShell) => {
          shells += 1;
          acceptShell().write("fixture ready\r\n");
        });
      }));
    });
    await listen(ssh, 0, "127.0.0.1");
    const handlers = new Map();
    const sent = [];
    bridge.init({ sessions: new Map(), electronModule: {} });
    bridge.registerHandlers({ handle: (name, fn) => handlers.set(name, fn), on() {} });
    const event = { sender: { id: senderId, isDestroyed: () => false,
      send: (channel, payload) => sent.push({ channel, payload }) } };
    let guard;
    try {
      const start = handlers.get("netcatty:start")(event, {
        sessionId: `agent-fallback-${senderId}`, hostname: "127.0.0.1", port: ssh.address().port,
        username: "fixture", password, authMethod: "auto", useSshAgent,
        verifyHostKeys: false, reuseTransport: false, skipShellPidDiscovery: true,
        sshTcpConnectTimeoutMs: 1000, sshAuthReadyTimeoutMs: 1000,
        ...(jump ? { jumpHosts: [{
          hostname: "127.0.0.1", port: ssh.address().port, username: "fixture",
          password, authMethod: "auto", useSshAgent,
          sshTcpConnectTimeoutMs: 1000, sshAuthReadyTimeoutMs: 1000,
        }] } : {}),
      });
      let error;
      try {
        await Promise.race([start, new Promise((_, reject) => {
          guard = setTimeout(() => reject(new Error("Fixture exceeded authentication deadline")), 4000);
        })]);
      } catch (err) { error = err; }
      return { error, methods, shells, sent: sent.slice(), agentChecks };
    } finally {
      clearTimeout(guard);
      for (const client of sshClients) client.end();
      for (const socket of forwardingSockets) socket.destroy();
      for (const client of agentClients) client.destroy();
      if (agent.listening) await close(agent);
      await close(ssh);
    }
  }

  for (const [name, options] of [
    ["stale agent", {}],
    ["disabled agent", { useSshAgent: false }],
    ["healthy empty agent", { stale: false }],
  ]) {
    await t.test(`${name} still opens a real shell using the saved password`, async () => {
      const result = await run(options);
      assert.equal(result.error, undefined);
      assert.deepEqual(result.methods, ["none", "password"]);
      assert.equal(result.shells, 1);
      assert.equal(result.agentChecks, options.stale === false ? 1 : 0);
      assert.equal(result.sent.some(({ channel }) => channel === "netcatty:auth:failed"), false);
      assert.equal(result.sent.some(({ channel }) => channel === "netcatty:exit"), false);
    });
  }
  for (const [name, password, methods] of [
    ["agent without other credentials", undefined, ["none"]],
    ["incorrect password", "wrong-password", ["none", "password"]],
  ]) {
    await t.test(`${name} still reports a real authentication failure`, async () => {
      // null deliberately omits a password rather than taking run's default.
      const result = await run({ password: password ?? null });
      assert.equal(result.error?.level, "client-authentication");
      assert.match(result.error.message, /All configured authentication methods failed/);
      assert.deepEqual(result.methods, methods);
      assert.equal(result.shells, 0);
      assert.ok(result.sent.some(({ channel }) => channel === "netcatty:auth:failed"));
    });
  }
  await t.test("stalled password fallback retains its authentication deadline", async () => {
    const result = await run({ stall: true });
    assert.match(result.error?.message || "", /Connection timeout to 127\.0\.0\.1/);
    assert.deepEqual(result.methods, ["none", "password"]);
    assert.equal(result.shells, 0);
    assert.ok(result.sent.some(({ channel, payload }) => (
      channel === "netcatty:exit" && payload.reason === "timeout"
    )));
  });
  await t.test("a stale jump-host agent still reaches a shell through saved passwords", async () => {
    const result = await run({ jump: true });
    assert.equal(result.error, undefined);
    assert.deepEqual(result.methods, ["none", "password", "none", "password"]);
    assert.equal(result.shells, 1);
    assert.equal(result.sent.some(({ channel }) => channel === "netcatty:auth:failed"), false);
  });
  await t.test("a fatal jump-host auth error after its agent error still rejects", async () => {
    const result = await run({ jump: true, password: "wrong-password" });
    assert.equal(result.error?.level, "client-authentication");
    assert.equal(result.error?.isJumpHostAuthError, true);
    assert.deepEqual(result.methods, ["none", "password"]);
    assert.equal(result.shells, 0);
  });
  await t.test("a stalled jump-host password retains its authentication deadline", async () => {
    const result = await run({ jump: true, stall: true });
    assert.match(result.error?.message || "", /Connection timeout to 127\.0\.0\.1/);
    assert.deepEqual(result.methods, ["none", "password"]);
    assert.equal(result.shells, 0);
  });
});
}

// --- merged from sshBridge.strictAgentRetry.test.cjs ---
{
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  _canFailedHopRetryWithEncryptedDefaultKeys,
  _canRetryWithEncryptedDefaultKeys,
  _isStrictAgentAuthFailure,
} = require("./sshBridge.cjs");

test("strict agent failures skip encrypted default-key prompts", () => {
  const jumpHosts = [
    { hostname: "shared.example", useSshAgent: false },
    { hostname: "shared.example", useSshAgent: true, identitiesOnly: true },
  ];
  assert.equal(_isStrictAgentAuthFailure({ jumpHosts }, {
    isJumpHostAuthError: true,
    jumpHostIndex: 1,
    jumpHostHostname: "shared.example",
  }), true);
  assert.equal(_isStrictAgentAuthFailure({ jumpHosts }, {
    isJumpHostAuthError: true,
    jumpHostIndex: 0,
    jumpHostHostname: "shared.example",
  }), false);
  assert.equal(_isStrictAgentAuthFailure({ jumpHosts }, {
    isJumpHostAuthError: true,
    jumpHostHostname: "shared.example",
  }), false, "ambiguous legacy errors must not guess the failed hop");
});

test("encrypted default-key retry is limited to automatic or legacy hops", () => {
  assert.equal(_canRetryWithEncryptedDefaultKeys({ authMethod: "password" }), false);
  assert.equal(_canRetryWithEncryptedDefaultKeys({ authMethod: "key" }), false);
  assert.equal(_canRetryWithEncryptedDefaultKeys({ authMethod: "certificate" }), false);
  assert.equal(_canRetryWithEncryptedDefaultKeys({ authMethod: "auto" }), true);
  assert.equal(_canRetryWithEncryptedDefaultKeys({
    authMethod: "password",
    jumpHosts: [{ authMethod: "auto" }],
  }), true);
  assert.equal(_canRetryWithEncryptedDefaultKeys({
    authMethod: "password",
    jumpHosts: [{ authMethod: "password" }, { authMethod: "key" }],
  }), false);
  assert.equal(_canRetryWithEncryptedDefaultKeys({
    authMethod: "auto",
    _unlockedEncryptedKeys: [{ keyName: "id_work" }],
  }), false);
});

test("encrypted default-key prompts follow the hop that actually failed", () => {
  const automaticJumpExplicitTarget = {
    authMethod: "password",
    jumpHosts: [{ authMethod: "auto", hostname: "jump.example" }],
  };
  assert.equal(_canFailedHopRetryWithEncryptedDefaultKeys(
    automaticJumpExplicitTarget,
    { level: "client-authentication" },
  ), false);
  assert.equal(_canFailedHopRetryWithEncryptedDefaultKeys(
    automaticJumpExplicitTarget,
    { isJumpHostAuthError: true, jumpHostIndex: 0 },
  ), true);

  const automaticTargetExplicitJump = {
    authMethod: "auto",
    jumpHosts: [{ authMethod: "key", hostname: "jump.example" }],
  };
  assert.equal(_canFailedHopRetryWithEncryptedDefaultKeys(
    automaticTargetExplicitJump,
    { level: "client-authentication" },
  ), true);
  assert.equal(_canFailedHopRetryWithEncryptedDefaultKeys(
    automaticTargetExplicitJump,
    { isJumpHostAuthError: true, jumpHostIndex: 0 },
  ), false);
});
}
