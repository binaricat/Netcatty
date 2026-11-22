"use strict";

// --- merged from sshBridge.connectionTimeout.test.cjs ---
{
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function loadBridgeWithMockedSsh2(t) {
  const bridgePath = require.resolve("./sshBridge.cjs");
  const authHelperPath = require.resolve("./sshAuthHelper.cjs");
  const originalLoad = Module._load;

  class MockSSHClient extends EventEmitter {
    constructor() {
      super();
      MockSSHClient.instances.push(this);
      this._sock = {
        timeouts: [],
        setTimeout: (ms) => {
          this._sock.timeouts.push(ms);
        },
      };
      this.connectOpts = null;
      this.destroyed = false;
      this.ended = false;
    }

    connect(opts) {
      this.connectOpts = opts;
      setImmediate(() => {
        this.emit("connect");
        if (MockSSHClient.emitSocketTimeout) this.emit("timeout");
      });
    }

    end() {
      this.ended = true;
    }

    destroy() {
      this.destroyed = true;
    }
  }
  MockSSHClient.instances = [];
  MockSSHClient.emitSocketTimeout = true;

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "ssh2") {
      return {
        Client: MockSSHClient,
        utils: { parseKey: () => new Error("no key") },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  delete require.cache[bridgePath];
  delete require.cache[authHelperPath];
  const bridge = require("./sshBridge.cjs");

  t.after(() => {
    delete require.cache[bridgePath];
    delete require.cache[authHelperPath];
    Module._load = originalLoad;
  });

  return { bridge, MockSSHClient };
}

function makeSender() {
  return {
    id: 1,
    isDestroyed: () => false,
    sent: [],
    send(channel, payload) {
      this.sent.push({ channel, payload });
    },
  };
}

function registerStartHandler(bridge, sessions) {
  bridge.init({ sessions, electronModule: {} });
  const ipcMain = {
    handlers: new Map(),
    handle(channel, handler) {
      this.handlers.set(channel, handler);
    },
    on() {},
  };
  bridge.registerHandlers(ipcMain);
  return ipcMain.handlers.get("netcatty:start");
}

function collectAuthMethods(authHandler, maxSteps = 16) {
  const labels = [];
  let methodsLeft = null;
  for (let i = 0; i < maxSteps; i += 1) {
    let offered = null;
    authHandler(methodsLeft, false, (method) => {
      offered = method;
    });
    if (!offered) break;
    labels.push(typeof offered === "string" ? offered : offered.type);
    methodsLeft = ["publickey", "password", "keyboard-interactive", "agent"];
  }
  return labels;
}

async function withFakeDefaultKey(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-auto-auth-"));
  const sshDir = path.join(home, ".ssh");
  fs.mkdirSync(sshDir);
  fs.writeFileSync(
    path.join(sshDir, "id_rsa"),
    "-----BEGIN RSA PRIVATE KEY-----\nMIIBfake-auto-auth\n-----END RSA PRIVATE KEY-----\n",
  );
  const originalHomedir = os.homedir;
  const originalAgentSocket = process.env.SSH_AUTH_SOCK;
  os.homedir = () => home;
  delete process.env.SSH_AUTH_SOCK;
  try {
    return await run();
  } finally {
    os.homedir = originalHomedir;
    if (originalAgentSocket === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = originalAgentSocket;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test("SSH start automatic mode tries local keys before its saved password", async (t) => {
  await withFakeDefaultKey(async () => {
    const { bridge, MockSSHClient } = loadBridgeWithMockedSsh2(t);
    const start = registerStartHandler(bridge, new Map());

    await assert.rejects(
      () => start(
        { sender: makeSender() },
        {
          sessionId: "ssh-auto-auth",
          hostname: "192.0.2.9",
          username: "alice",
          port: 22,
          authMethod: "auto",
          password: "saved-secret",
          knownHosts: [],
        },
      ),
      /Connection timeout/,
    );

    const labels = collectAuthMethods(MockSSHClient.instances[0].connectOpts.authHandler);
    assert.ok(labels.includes("publickey"), `expected publickey; got ${labels.join(",")}`);
    assert.ok(labels.indexOf("publickey") < labels.indexOf("password"), labels.join(","));
    assert.ok(labels.indexOf("publickey") < labels.indexOf("keyboard-interactive"), labels.join(","));
    // Default hosts keep password before keyboard-interactive.
    assert.ok(labels.indexOf("password") < labels.indexOf("keyboard-interactive"), labels.join(","));
  });
});

test("SSH start keeps TCP dial and auth readiness as separate timeout phases", async (t) => {
  const { bridge, MockSSHClient } = loadBridgeWithMockedSsh2(t);
  const sessions = new Map();
  const start = registerStartHandler(bridge, sessions);
  const sender = makeSender();

  await assert.rejects(
    () => start(
      { sender },
      {
        sessionId: "ssh-timeout",
        hostname: "192.0.2.10",
        username: "alice",
        port: 22,
        password: "secret",
        knownHosts: [],
      },
    ),
    /Connection timeout to 192\.0\.2\.10/,
  );

  assert.equal(MockSSHClient.instances.length, 1);
  const client = MockSSHClient.instances[0];
  assert.equal(client.connectOpts.timeout, 20_000);
  assert.equal(client.connectOpts.readyTimeout, 0);
  assert.deepEqual(client._sock.timeouts, [0]);
  assert.ok(sender.sent.some((message) => (
    message.channel === "netcatty:chain:progress"
    && message.payload.sessionId === "ssh-timeout"
    && message.payload.status === "tcp-connected"
  )));
  assert.ok(sender.sent.some((message) => (
    message.channel === "netcatty:exit"
    && message.payload.sessionId === "ssh-timeout"
    && message.payload.reason === "timeout"
  )));
});

test("SSH start applies configured TCP and authentication timeouts", async (t) => {
  const { bridge, MockSSHClient } = loadBridgeWithMockedSsh2(t);
  const start = registerStartHandler(bridge, new Map());

  await assert.rejects(
    () => start(
      { sender: makeSender() },
      {
        sessionId: "ssh-custom-timeout",
        hostname: "192.0.2.20",
        username: "alice",
        port: 22,
        password: "secret",
        knownHosts: [],
        sshTcpConnectTimeoutMs: 45_000,
        sshAuthReadyTimeoutMs: 300_000,
      },
    ),
    /Connection timeout to 192\.0\.2\.20/,
  );

  assert.equal(MockSSHClient.instances.length, 1);
  assert.equal(MockSSHClient.instances[0].connectOpts.timeout, 45_000);
  assert.equal(MockSSHClient.instances[0].connectOpts.readyTimeout, 0);
});

test("SSH authentication timeout starts only after TCP connects", async (t) => {
  const { bridge, MockSSHClient } = loadBridgeWithMockedSsh2(t);
  MockSSHClient.emitSocketTimeout = false;
  const start = registerStartHandler(bridge, new Map());
  const startedAt = Date.now();
  let guardTimer;
  const guard = new Promise((_, reject) => {
    guardTimer = setTimeout(
      () => reject(new Error("Authentication timeout test exceeded 3 seconds")),
      3_000,
    );
  });

  try {
    await assert.rejects(
      Promise.race([
        start(
          { sender: makeSender() },
          {
            sessionId: "ssh-auth-timeout",
            hostname: "192.0.2.30",
            username: "alice",
            port: 22,
            password: "secret",
            knownHosts: [],
            sshTcpConnectTimeoutMs: 45_000,
            sshAuthReadyTimeoutMs: 1_000,
          },
        ),
        guard,
      ]),
      /Connection timeout to 192\.0\.2\.30/,
    );
  } finally {
    clearTimeout(guardTimer);
  }

  assert.ok(Date.now() - startedAt >= 900);
  assert.equal(MockSSHClient.instances[0].connectOpts.timeout, 45_000);
});
}

// --- merged from sshBridge.connectionTimeouts.test.cjs ---
{
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  SSH_AUTH_READY_TIMEOUT_MS,
  SSH_TCP_CONNECT_TIMEOUT_MS,
  resolveSshConnectionTimeouts,
} = require("./sshBridge/startSession.cjs");

test("SSH bridge uses default connection timeouts", () => {
  assert.deepEqual(resolveSshConnectionTimeouts({}), {
    tcpConnectTimeoutMs: SSH_TCP_CONNECT_TIMEOUT_MS,
    authReadyTimeoutMs: SSH_AUTH_READY_TIMEOUT_MS,
  });
});

test("SSH bridge accepts valid custom connection timeouts", () => {
  assert.deepEqual(resolveSshConnectionTimeouts({
    sshTcpConnectTimeoutMs: 45_000,
    sshAuthReadyTimeoutMs: 300_000,
  }), {
    tcpConnectTimeoutMs: 45_000,
    authReadyTimeoutMs: 300_000,
  });
});

test("SSH bridge rejects invalid custom connection timeouts", () => {
  assert.deepEqual(resolveSshConnectionTimeouts({
    sshTcpConnectTimeoutMs: 0,
    sshAuthReadyTimeoutMs: 3_600_001,
  }), {
    tcpConnectTimeoutMs: SSH_TCP_CONNECT_TIMEOUT_MS,
    authReadyTimeoutMs: SSH_AUTH_READY_TIMEOUT_MS,
  });
});
}
