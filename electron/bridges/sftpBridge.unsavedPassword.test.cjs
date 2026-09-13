"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { generateKeyPairSync } = require("node:crypto");
const { Server } = require("ssh2");
const sshBridge = require("./sshBridge.cjs");
const sftpBridge = require("./sftpBridge.cjs");
const pool = require("./sshConnectionPool.cjs");

const PASSWORD = "temporary-test-password";

async function fixture(t) {
  pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sockets = new Set();
  let authRounds = 0;
  let connections = 0;
  const sshServer = new Server({
    hostKeys: [privateKey.export({ type: "pkcs1", format: "pem" })],
  }, (client) => {
    connections += 1;
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      if (ctx.method === "password") {
        authRounds += 1;
        if (ctx.username === "root" && ctx.password === PASSWORD) {
          ctx.accept();
          return;
        }
      }
      ctx.reject(["password"]);
    });
    client.on("ready", () => client.on("session", (accept) => {
      const session = accept();
      session.on("pty", (acceptPty) => acceptPty());
      session.on("shell", (acceptShell) => {
        const shell = acceptShell();
        shell.on("data", () => {});
      });
      session.on("sftp", (acceptSftp) => {
        const sftp = acceptSftp();
        sftp.on("REALPATH", (id) => sftp.name(id, [{
          filename: "/root", longname: "drwxr-xr-x", attrs: { mode: 0o040755 },
        }]));
        sftp.on("OPENDIR", (id) => sftp.handle(id, Buffer.from("dir")));
        sftp.on("READDIR", (id) => sftp.status(id, 1));
        sftp.on("CLOSE", (id) => sftp.status(id, 0));
      });
    }));
  });
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    sshServer.injectSocket(socket);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const sessions = new Map();
  const sftpClients = new Map();
  const handlers = new Map();
  sshBridge.init({ sessions, electronModule: {} });
  sshBridge.registerHandlers({ handle: (name, fn) => handlers.set(name, fn), on() {} });
  sftpBridge.init({ sessions, sftpClients, electronModule: {} });
  t.after(async () => {
    for (const sftpId of [...sftpClients.keys()]) {
      await sftpBridge.closeSftp(null, { sftpId }).catch(() => {});
    }
    for (const session of sessions.values()) {
      session.stream?.destroy();
      session.conn?.destroy();
    }
    pool.discardAllTransports("test-end");
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    sshServer.close();
    pool.resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  });
  const original = {
    hostname: "127.0.0.1", port: server.address().port,
    hostId: "unsaved-password-3351", username: "root", authMethod: "password",
    useSshAgent: false, identityFilePaths: [], verifyHostKeys: false,
    fileProtocol: "sftp", timeout: 2000,
  };
  const event = { sender: { id: 3351, isDestroyed: () => false, send() {} } };
  const login = async (saved = false) => {
    const options = saved ? { ...original, password: PASSWORD } : original;
    const result = await handlers.get("netcatty:start")(event, {
      ...options, password: PASSWORD, sessionId: "terminal-3351",
      skipShellPidDiscovery: true,
      ...(saved ? {} : { sftpReuseOptions: original }),
    });
    assert.equal(result.sessionId, "terminal-3351");
    assert.equal(authRounds, 1);
    return options;
  };
  return { original, event, login, sessions, sftpClients,
    counts: () => ({ authRounds, connections }) };
}

test("unsaved terminal password supports pooled and explicit SFTP without another login (#3351)", { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const options = await f.login();
  const pooled = await sftpBridge.openSftp(f.event, { ...options, sessionId: "browse-3351" });
  assert.ok(pooled.sftpId);
  const explicit = await sftpBridge.openSftpForSession(f.event, {
    sessionId: "terminal-3351", expectedEndpoint: options, fileProtocol: "sftp",
  });
  assert.ok(explicit.sftpId);
  for (const id of [pooled.sftpId, explicit.sftpId]) {
    const client = f.sftpClients.get(id);
    assert.equal(await client.realPath("."), "/root");
  }
  assert.deepEqual(f.counts(), { authRounds: 1, connections: 1 });
});

test("saved-password control reuses the terminal transport", { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  const options = await f.login(true);
  const result = await sftpBridge.openSftp(f.event, { ...options, sessionId: "saved-browse" });
  assert.ok(result.sftpId);
  assert.deepEqual(f.counts(), { authRounds: 1, connections: 1 });
});

test("temporary-password alias refuses changed saved credentials and a changed route", { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  await f.login();
  for (const changed of [
    { ...f.original, password: "different-saved-password" },
    { ...f.original, port: f.original.port + 1 },
    { ...f.original, hostId: "different-profile" },
    { ...f.original, verifyHostKeys: true },
    { ...f.original, requiresMfa: true },
  ]) {
    await assert.rejects(sftpBridge.openSftpForSession(f.event, {
      sessionId: "terminal-3351", expectedEndpoint: changed, fileProtocol: "sftp",
    }), { code: "ERR_SFTP_SOURCE_ROUTE_MISMATCH" });
  }
  await assert.rejects(sftpBridge.openSftp(f.event, {
    ...f.original, password: "different-saved-password", sessionId: "changed-password",
  }), /authentication methods failed/i);
  assert.deepEqual(f.counts(), { authRounds: 2, connections: 2 });
});

test("temporary-password alias does not bypass a dedicated connection request", { timeout: 60000 }, async (t) => {
  const f = await fixture(t);
  await f.login();
  await assert.rejects(sftpBridge.openSftp(f.event, {
    ...f.original, reuseTransport: false, sessionId: "dedicated-browse",
  }), /authentication methods failed/i);
  assert.deepEqual(f.counts(), { authRounds: 1, connections: 2 });
});
