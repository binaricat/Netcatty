"use strict";

const assert = require("node:assert/strict");
const { execFile, execFileSync, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { Client, Server, utils } = require("ssh2");

const { EventEmitter } = require("node:events");
const { Duplex } = require("node:stream");
const {
  createSshChannelBridge,
  resolveRemoteTransportForTarget,
  bridgeChannelStreams,
  attachClientChannelMultiplexer,
} = require("./sshChannelBridge.cjs");
const {
  createTransport,
  borrowTransport,
  returnTransport,
  resetSshTransportRegistryForTests,
} = require("./sshConnectionPool.cjs");
const { buildSshBridgeConfigBlock } = require("./externalEditorBridge.cjs");
const { getSshProxyLauncherPath, SSH_BRIDGE_DISCOVERY_ENV_VAR } = require("../cli/sshBridgeDiscoveryPath.cjs");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function startMockRemoteSshServer() {
  const hostKey = utils.generateKeyPairSync("ed25519");
  const receivedCommands = [];
  const receivedSubsystems = [];

  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    client.on("authentication", (ctx) => {
      // Require a specific secret password that OpenSSH does NOT have.
      if (ctx.method === "password" && ctx.username === "remoteuser" && ctx.password === "vault-only-secret") {
        ctx.accept();
      } else {
        ctx.reject(["password"]);
      }
    });

    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (acceptPty) => acceptPty?.());
        session.on("env", (acceptEnv) => acceptEnv?.());
        session.on("exec", (acceptExec, _rejectExec, info) => {
          receivedCommands.push(info.command);
          const stream = acceptExec();
          if (info.command === "fail-with-42") {
            stream.stderr.write("remote-err-detail\n");
            stream.exit(42);
            stream.end();
            return;
          }
          if (info.command === "echo-stdin") {
            let acc = "";
            stream.on("data", (d) => {
              acc += d.toString("utf8");
            });
            stream.on("end", () => {
              stream.write(`ECHO:${acc}`);
              stream.exit(0);
              stream.end();
            });
            return;
          }
          stream.write(`RAN:${info.command}\n`);
          stream.exit(0);
          stream.end();
        });

        session.on("subsystem", (acceptSubsys, _rejectSubsys, info) => {
          receivedSubsystems.push(info.name);
          const stream = acceptSubsys();
          stream.write(`SUBSYS:${info.name}`);
          stream.exit(0);
          stream.end();
        });
      });
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const port = server.address().port;
  return {
    server,
    port,
    receivedCommands,
    receivedSubsystems,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function connectRemoteClient(port) {
  const client = new Client();
  await new Promise((resolve, reject) => {
    client.once("ready", resolve);
    client.once("error", reject);
    client.connect({
      host: "127.0.0.1",
      port,
      username: "remoteuser",
      password: "vault-only-secret",
    });
  });
  return client;
}

test("sshChannelBridge rejects unauthorized handshake token and unknown host", async () => {
  const tmpDir = makeTempDir("nc-ssh-bridge-auth-");
  const sessions = new Map();
  const bridge = createSshChannelBridge({
    sessions,
    sftpClients: new Map(),
    stateDir: tmpDir,
  });

  try {
    const status = await bridge.ensureStarted();
    assert.equal(status.running, true);
    assert.ok(fs.existsSync(status.discoveryPath));
    assert.ok(fs.existsSync(status.knownHostsPath));

    const sendHandshake = (payload) => new Promise((resolve, reject) => {
      const sock = net.createConnection(status.endpoint);
      let buf = "";
      sock.on("connect", () => sock.write(JSON.stringify(payload) + "\n"));
      sock.on("data", (d) => {
        buf += d.toString("utf8");
        if (buf.includes("\n")) {
          sock.destroy();
          resolve(JSON.parse(buf.split("\n")[0]));
        }
      });
      sock.on("error", reject);
    });

    const badToken = await sendHandshake({ token: "wrong-token", host: "demo-12345678.netcatty" });
    assert.equal(badToken.ok, false);
    assert.match(badToken.error, /Unauthorized/i);

    const discovery = JSON.parse(fs.readFileSync(status.discoveryPath, "utf8"));
    const unknownHost = await sendHandshake({ token: discovery.token, host: "missing-12345678.netcatty" });
    assert.equal(unknownHost.ok, false);
    assert.match(unknownHost.error, /No active Netcatty session/i);
  } finally {
    await bridge.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("sshChannelBridge multiplexes real OpenSSH ssh exec, stdin/stdout, exit code, and subsystem over live Netcatty transport", async (t) => {
  // Check whether system OpenSSH `ssh` binary is available in this test environment.
  try {
    execFileSync("ssh", ["-V"], { stdio: "ignore" });
  } catch {
    t.skip("OpenSSH client not installed in test environment");
    return;
  }

  const tmpDir = makeTempDir("nc-ssh-bridge-e2e-");
  const stateDirWithSpace = path.join(tmpDir, "Netcatty Dev", "dev", "ssh-bridge");
  const remote = await startMockRemoteSshServer();
  const remoteConn = await connectRemoteClient(remote.port);
  const sessions = new Map([
    ["sess-1", {
      id: "sess-1",
      conn: remoteConn,
      _reuseEndpoint: {
        hostId: "host-prod-1",
        hostname: "127.0.0.1",
        port: remote.port,
        username: "remoteuser",
      },
    }],
  ]);

  const bridge = createSshChannelBridge({
    sessions,
    sftpClients: new Map(),
    stateDir: stateDirWithSpace,
  });

  try {
    const bridgeHost = "prod-a1b2c3d4.netcatty";
    const status = await bridge.registerTarget({
      bridgeHost,
      sessionId: "sess-1",
      hostId: "host-prod-1",
      hostname: "127.0.0.1",
      port: remote.port,
      username: "remoteuser",
    });
    assert.equal(status.connected, true);

    const sshConfigPath = path.join(tmpDir, "ssh_config");
    const proxyLauncherPath = getSshProxyLauncherPath(process.platform);
    fs.writeFileSync(
      sshConfigPath,
      buildSshBridgeConfigBlock({
        proxyLauncherPath,
        knownHostsPath: status.knownHostsPath,
        discoveryPath: status.discoveryPath,
        platform: process.platform,
      }) + "\n",
      { mode: 0o600 },
    );

    // Explicitly do NOT set SSH_BRIDGE_DISCOVERY_ENV_VAR so we test the
    // ProxyCommand argv discovery path (including spaces like "Netcatty Dev/dev").
    const env = { ...process.env };
    delete env[SSH_BRIDGE_DISCOVERY_ENV_VAR];

    // 1. Standard Zed-style `ssh -T` exec command (no password or key required!)
    const { stdout: out1 } = await execFileAsync(
      "ssh",
      ["-F", sshConfigPath, "-T", bridgeHost, "echo hello-from-zed"],
      { env, encoding: "utf8", timeout: 15_000 },
    );
    assert.equal(out1.trim(), "RAN:echo hello-from-zed");

    // 2. Zed-style Windows MasterProcess `-t` (PTY + exec) command
    const { stdout: outPty } = await execFileAsync(
      "ssh",
      ["-F", sshConfigPath, "-tt", bridgeHost, "echo ZED_SSH_CONNECTION_ESTABLISHED"],
      { env, encoding: "utf8", timeout: 15_000 },
    );
    assert.match(outPty, /RAN:echo ZED_SSH_CONNECTION_ESTABLISHED/);

    // 3. Bidirectional stdin/stdout piping (like Zed `proxy` RPC over stdio)
    const echoOut = await new Promise((resolve, reject) => {
      const child = spawn("ssh", ["-F", sshConfigPath, "-T", bridgeHost, "echo-stdin"], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
      child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(`ssh exited ${code}: ${stderr}`));
        else resolve(stdout);
      });
      child.stdin.end("zed-rpc-frame-payload");
    });
    assert.equal(echoOut, "ECHO:zed-rpc-frame-payload");

    // 4. Non-zero exit code + stderr propagation
    const errResult = await new Promise((resolve, reject) => {
      const child = spawn("ssh", ["-F", sshConfigPath, "-T", bridgeHost, "fail-with-42"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stderr }));
    });
    assert.equal(errResult.code, 42);
    assert.match(errResult.stderr, /remote-err-detail/);

    // 5. Subsystem forwarding (`ssh -s <host> sftp`, used by Zed's SFTP server upload)
    const { stdout: subsysOut } = await execFileAsync(
      "ssh",
      ["-F", sshConfigPath, "-T", "-s", bridgeHost, "sftp"],
      { env, encoding: "utf8", timeout: 15_000 },
    );
    assert.equal(subsysOut, "SUBSYS:sftp");
    assert.deepEqual(remote.receivedSubsystems, ["sftp"]);
  } finally {
    await bridge.stop();
    remoteConn.end();
    await remote.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

function makeFakeConn(label) {
  const conn = new EventEmitter();
  conn.label = label;
  conn._sock = { destroyed: false };
  conn.exec = () => {};
  conn.end = () => {
    conn._ended = true;
  };
  return conn;
}

test("resolveRemoteTransportForTarget keeps fallback selection within the originating hostId profile", () => {
  const connBastionB = makeFakeConn("bastion-b");
  const connBastionA = makeFakeConn("bastion-a");

  // Two saved profiles share the same private IP/port/username behind different bastions.
  const sessions = new Map([
    ["sess-b", {
      conn: connBastionB,
      _reuseEndpoint: {
        hostId: "host-profile-b",
        hostname: "10.0.0.5",
        port: 22,
        username: "ubuntu",
      },
    }],
    ["sess-a", {
      conn: connBastionA,
      _reuseEndpoint: {
        hostId: "host-profile-a",
        hostname: "10.0.0.5",
        port: 22,
        username: "ubuntu",
      },
    }],
  ]);

  // Originating session for profile A closed; fallback must skip profile B and pick profile A.
  const resolved = resolveRemoteTransportForTarget(
    {
      sessionId: "sess-a-closed",
      hostId: "host-profile-a",
      hostname: "10.0.0.5",
      port: 22,
      username: "ubuntu",
    },
    { sessions, sftpClients: new Map() },
  );
  assert.equal(resolved?.conn, connBastionA);

  // When only profile B is live, profile A must NOT fall back to profile B.
  sessions.delete("sess-a");
  const rejected = resolveRemoteTransportForTarget(
    {
      sessionId: "sess-a-closed",
      hostId: "host-profile-a",
      hostname: "10.0.0.5",
      port: 22,
      username: "ubuntu",
    },
    { sessions, sftpClients: new Map() },
  );
  assert.equal(rejected, null);

  // Same profile isolation applies to SFTP fallback.
  const sftpConnB = makeFakeConn("sftp-bastion-b");
  const sftpConnA = makeFakeConn("sftp-bastion-a");
  const sftpClients = new Map([
    ["sftp-b", {
      client: sftpConnB,
      __netcattyRefHolder: {
        connRef: {
          conn: sftpConnB,
          state: "live",
          endpoint: {
            hostId: "host-profile-b",
            hostname: "10.0.0.5",
            port: 22,
            username: "ubuntu",
          },
        },
      },
    }],
    ["sftp-a", {
      client: sftpConnA,
      __netcattyRefHolder: {
        connRef: {
          conn: sftpConnA,
          state: "live",
          endpoint: {
            hostId: "host-profile-a",
            hostname: "10.0.0.5",
            port: 22,
            username: "ubuntu",
          },
        },
      },
    }],
  ]);

  const resolvedSftp = resolveRemoteTransportForTarget(
    {
      sftpId: "sftp-a-closed",
      hostId: "host-profile-a",
      hostname: "10.0.0.5",
      port: 22,
      username: "ubuntu",
    },
    { sessions: new Map(), sftpClients },
  );
  assert.equal(resolvedSftp?.conn, sftpConnA);

  sftpClients.delete("sftp-a");
  const rejectedSftp = resolveRemoteTransportForTarget(
    {
      sftpId: "sftp-a-closed",
      hostId: "host-profile-a",
      hostname: "10.0.0.5",
      port: 22,
      username: "ubuntu",
    },
    { sessions: new Map(), sftpClients },
  );
  assert.equal(rejectedSftp, null);
});

test("resolveRemoteTransportForTarget resolves managed SFTP transport from __netcattyRefHolder.connRef", () => {
  resetSshTransportRegistryForTests();
  try {
    const conn = makeFakeConn("sftp-managed");
    const transport = createTransport({
      conn,
      endpoint: {
        hostId: "host-sftp-1",
        hostname: "10.1.2.3",
        port: 22,
        username: "deploy",
        protocol: "ssh",
      },
      idleTtlMs: 10,
    });
    const refHolder = { id: "sftp-1", __sshLeaseKind: "sftp" };
    borrowTransport(transport, {
      kind: "sftp",
      holder: refHolder,
      leaseId: "sftp:sftp-1",
    });

    const sftpClient = {
      client: conn,
      __netcattyRefHolder: refHolder,
      __netcattyTransportManaged: true,
    };
    const sftpClients = new Map([["sftp-1", sftpClient]]);

    const resolved = resolveRemoteTransportForTarget(
      {
        sftpId: "sftp-1",
        hostId: "host-sftp-1",
        hostname: "10.1.2.3",
        port: 22,
        username: "deploy",
      },
      { sessions: new Map(), sftpClients },
    );

    assert.equal(resolved?.conn, conn);
    assert.equal(resolved?.transport, transport);

    // Borrowing an editor lease keeps the transport live even after SFTP closes.
    const editorHolder = { id: "ssh-bridge:test" };
    borrowTransport(resolved.transport, { kind: "forward", holder: editorHolder });
    returnTransport(refHolder);
    assert.equal(transport.state, "live");
    assert.equal(transport.leases.size, 1);

    returnTransport(editorHolder);
  } finally {
    resetSshTransportRegistryForTests();
  }
});

test("bridgeChannelStreams applies backpressure across stdout, stderr, and stdin", async () => {
  const makeBackpressureChannel = ({ blockWrites = false, highWaterMark = 1024 } = {}) => {
    let blocked = blockWrites;
    let pendingWriteCb = null;
    const received = [];
    let exitCode = null;

    const stream = new Duplex({
      highWaterMark,
      read() {},
      write(chunk, _enc, cb) {
        received.push(Buffer.from(chunk));
        if (blocked) {
          pendingWriteCb = cb;
        } else {
          cb();
        }
      },
    });
    stream.stderr = new Duplex({
      highWaterMark,
      read() {},
      write(chunk, _enc, cb) {
        stream.stderrReceived.push(Buffer.from(chunk));
        if (stream.stderrBlocked) {
          stream.stderrPendingCb = cb;
        } else {
          cb();
        }
      },
    });
    stream.stderrBlocked = blockWrites;
    stream.stderrPendingCb = null;
    stream.stderrReceived = [];
    stream.exit = (code) => {
      exitCode = code;
    };
    stream.getExitCode = () => exitCode;
    stream.getReceived = () => Buffer.concat(received);
    stream.getStderrReceived = () => Buffer.concat(stream.stderrReceived);
    stream.unblock = () => {
      blocked = false;
      if (pendingWriteCb) {
        const cb = pendingWriteCb;
        pendingWriteCb = null;
        cb();
      }
    };
    stream.unblockStderr = () => {
      stream.stderrBlocked = false;
      if (stream.stderrPendingCb) {
        const cb = stream.stderrPendingCb;
        stream.stderrPendingCb = null;
        cb();
      }
    };
    return stream;
  };

  // 1. remote -> client stdout backpressure
  const client = makeBackpressureChannel({ blockWrites: true, highWaterMark: 1024 });
  const remote = makeBackpressureChannel({ blockWrites: true, highWaterMark: 1024 });
  bridgeChannelStreams(client, remote);

  const chunk64k = Buffer.alloc(64 * 1024, 0x41);
  // Push 4 MiB into remote readable side while client writable is blocked.
  const totalChunks = 64;
  for (let i = 0; i < totalChunks; i += 1) {
    remote.push(chunk64k);
  }
  remote.push(null);

  await new Promise((r) => setImmediate(r));
  // Backpressure must pause remote before draining all 4 MiB into client's writable queue.
  assert.equal(remote.isPaused(), true);
  assert.ok(
    client.writableLength < 256 * 1024,
    `expected client writable buffer to stay bounded, got ${client.writableLength}`,
  );

  // Same for remote.stderr -> client.stderr
  for (let i = 0; i < 16; i += 1) {
    remote.stderr.push(Buffer.alloc(16 * 1024, 0x45));
  }
  remote.stderr.push(null);
  await new Promise((r) => setImmediate(r));
  assert.equal(remote.stderr.isPaused(), true);
  assert.ok(client.stderr.writableLength < 64 * 1024);

  // Same for client -> remote stdin
  for (let i = 0; i < 16; i += 1) {
    client.push(Buffer.alloc(16 * 1024, 0x42));
  }
  client.push(null);
  await new Promise((r) => setImmediate(r));
  assert.equal(client.isPaused(), true);
  assert.ok(remote.writableLength < 64 * 1024);

  // Unblock all destinations and verify full delivery + exit code.
  const done = new Promise((resolve) => client.once("finish", resolve));
  const remoteDone = new Promise((resolve) => remote.once("finish", resolve));
  remote.emit("exit", 0);
  client.unblock();
  client.unblockStderr();
  remote.unblock();

  await Promise.all([done, remoteDone]);
  assert.equal(client.getReceived().length, totalChunks * chunk64k.length);
  assert.equal(client.getStderrReceived().length, 16 * 16 * 1024);
  assert.equal(remote.getReceived().length, 16 * 16 * 1024);
  assert.equal(client.getExitCode(), 0);
});

test("bridgeChannelStreams waits for backpressured stderr to finish before forwarding EOF/close", async () => {
  let stderrBlocked = true;
  let stderrPendingCb = null;
  const stderrChunks = [];
  let clientEndedBeforeStderrComplete = false;
  let clientClosed = false;
  let exitCode = null;
  const totalStderrBytes = 240 * 1024;

  const client = new Duplex({
    highWaterMark: 1024,
    read() {},
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  client.stderr = new Duplex({
    highWaterMark: 1024,
    read() {},
    write(chunk, _enc, cb) {
      stderrChunks.push(Buffer.from(chunk));
      if (stderrBlocked) {
        stderrPendingCb = cb;
      } else {
        cb();
      }
    },
  });
  client.exit = (code) => {
    exitCode = code;
  };
  client.close = () => {
    clientClosed = true;
  };
  client.on("finish", () => {
    const receivedSoFar = Buffer.concat(stderrChunks).length;
    if (receivedSoFar < totalStderrBytes) {
      clientEndedBeforeStderrComplete = true;
    }
  });

  const remote = new Duplex({ highWaterMark: 1024, read() {}, write(_c, _e, cb) { cb(); } });
  remote.stderr = new Duplex({ highWaterMark: 1024, read() {}, write(_c, _e, cb) { cb(); } });

  bridgeChannelStreams(client, remote);

  // Push 240 KiB to stderr (backpressured), then immediately end stdout + exit + close remote.
  for (let i = 0; i < 15; i += 1) {
    remote.stderr.push(Buffer.alloc(16 * 1024, 0x45));
  }
  remote.stderr.push(null);
  remote.push(null); // stdout finishes immediately
  remote.emit("exit", 0);
  remote.emit("close", 0);

  await new Promise((r) => setImmediate(r));
  // Client must NOT be ended or closed while stderr is still paused with buffered data.
  assert.equal(client.writableEnded, false);
  assert.equal(clientClosed, false);
  assert.equal(remote.stderr.isPaused(), true);

  // Unblock stderr and wait for client channel to finish.
  const finished = new Promise((resolve) => client.once("finish", resolve));
  stderrBlocked = false;
  if (stderrPendingCb) {
    const cb = stderrPendingCb;
    stderrPendingCb = null;
    cb();
  }
  await finished;

  assert.equal(clientEndedBeforeStderrComplete, false);
  assert.equal(Buffer.concat(stderrChunks).length, totalStderrBytes);
  assert.equal(exitCode, 0);
});

test("attachClientChannelMultiplexer catches synchronous remote open throws and closes client on upstream drop", () => {
  const client = new EventEmitter();
  let clientEnded = false;
  client.end = () => {
    clientEnded = true;
  };

  const remoteConn = new EventEmitter();
  remoteConn._sock = { destroyed: false };
  remoteConn.exec = () => {
    throw new Error("Not connected");
  };

  attachClientChannelMultiplexer(client, remoteConn);
  client.emit("ready");

  const session = new EventEmitter();
  client.emit("session", () => session);

  const stderrOut = [];
  let exitCode = null;
  let streamEnded = false;
  let streamClosed = false;
  const clientStream = new EventEmitter();
  clientStream.stderr = {
    write: (msg) => stderrOut.push(String(msg)),
  };
  clientStream.exit = (code) => {
    exitCode = code;
  };
  clientStream.end = () => {
    streamEnded = true;
  };
  clientStream.close = () => {
    streamClosed = true;
  };

  // Synchronous throw from remoteConn.exec must be caught cleanly, not crash the worker.
  assert.doesNotThrow(() => {
    session.emit("exec", () => clientStream, () => {}, { command: "echo hi" });
  });
  assert.equal(exitCode, 1);
  assert.equal(streamEnded, true);
  assert.equal(streamClosed, true);
  assert.match(stderrOut.join(""), /Not connected/);

  // Upstream transport closing must close the external bridge client.
  assert.equal(clientEnded, false);
  remoteConn.emit("close");
  assert.equal(clientEnded, true);
});

test("attachClientChannelMultiplexer cancels late reverse-forward listens that complete after client close", () => {
  const client = new EventEmitter();
  client.end = () => {};

  let pendingForwardCb = null;
  const unforwarded = [];
  const remoteConn = new EventEmitter();
  remoteConn._sock = { destroyed: false };
  remoteConn.exec = () => {};
  remoteConn.forwardIn = (bindAddr, bindPort, cb) => {
    pendingForwardCb = cb;
  };
  remoteConn.unforwardIn = (bindAddr, bindPort, cb) => {
    unforwarded.push({ bindAddr, bindPort });
    cb?.();
  };

  attachClientChannelMultiplexer(client, remoteConn);
  client.emit("ready");

  let accepted = false;
  let rejected = false;
  client.emit(
    "request",
    () => { accepted = true; },
    () => { rejected = true; },
    "tcpip-forward",
    { bindAddr: "127.0.0.1", bindPort: 0 },
  );
  assert.equal(typeof pendingForwardCb, "function");

  // External client closes BEFORE upstream forwardIn replies.
  client.emit("close");

  // Upstream reply arrives late with assigned port 43210 -> must immediately unforwardIn.
  pendingForwardCb(null, 43210);

  assert.equal(accepted, false);
  assert.equal(rejected, true);
  assert.deepEqual(unforwarded, [{ bindAddr: "127.0.0.1", bindPort: 43210 }]);
});
