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

const { createSshChannelBridge } = require("./sshChannelBridge.cjs");
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
