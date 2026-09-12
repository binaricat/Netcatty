const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { readFileSync } = require("node:fs");
const Module = require("node:module");

const passphraseHandler = require("./passphraseHandler.cjs");
const {
  createConnectionRef,
  releaseConnectionRef,
  setDefaultTransportIdleTtlMs,
  resetSshTransportRegistryForTests,
} = require("./sshConnectionPool.cjs");

function loadSftpBridgeWithProxySocket(proxySocket, overrides = {}) {
  const bridgePath = require.resolve("./sftpBridge.cjs");
  const openConnectionPath = require.resolve("./sftpBridge/openConnection.cjs");
  delete require.cache[bridgePath];
  // Reload openConnection when we need to wrap createOpenConnectionApi so the
  // bridge picks up a patched connectSudoSftp (session-backed sudo tests).
  if (overrides.connectSudoSftp) {
    delete require.cache[openConnectionPath];
  }

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "./proxyUtils.cjs") {
      return {
        createProxySocket: async () => proxySocket,
      };
    }
    if (request === "ssh2" && overrides.SSHClient) {
      const ssh2 = originalLoad.call(this, request, parent, isMain);
      return {
        ...ssh2,
        Client: overrides.SSHClient,
      };
    }
    if (
      overrides.connectSudoSftp
      && (request === "./sftpBridge/openConnection.cjs"
        || request === openConnectionPath
        || (typeof request === "string" && request.endsWith("/sftpBridge/openConnection.cjs")))
    ) {
      const mod = originalLoad.call(this, request, parent, isMain);
      const originalCreate = mod.createOpenConnectionApi;
      return {
        ...mod,
        createOpenConnectionApi(ctx) {
          const api = originalCreate(ctx);
          return {
            ...api,
            connectSudoSftp: overrides.connectSudoSftp,
          };
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require("./sftpBridge.cjs");
  } finally {
    Module._load = originalLoad;
  }
}

function createFakeSftpChannel() {
  return {
    ended: false,
    readdir: () => {},
    stat: () => {},
    mkdir: () => {},
    unlink: () => {},
    end() {
      this.ended = true;
    },
    on() {},
  };
}

class FailingSshClient extends EventEmitter {
  constructor() {
    super();
    this.ended = false;
    FailingSshClient.instances.push(this);
  }

  connect() {
    queueMicrotask(() => {
      const err = new Error("jump connect failed");
      err.level = "client-socket";
      this.emit("error", err);
    });
  }

  end() {
    this.ended = true;
  }

  forwardOut() {
    throw new Error("forwardOut should not be called");
  }
}
FailingSshClient.instances = [];

function createSender() {
  return {
    id: 1,
    isDestroyed: () => false,
    send: () => {},
  };
}

test("openSftp clears its authentication timer when SSH becomes ready", () => {
  const source = readFileSync(require.resolve("./sftpBridge/openConnection.cjs"), "utf8");
  assert.match(
    source,
    /sshClient\.once\('ready', \(\) => \{\s*clearAuthReadyTimer\(\);\s*cleanup\(\);/,
  );
});

test("openSftp forwards target hostId to keyboard-interactive prompts", () => {
  const source = readFileSync(require.resolve("./sftpBridge/openConnection.cjs"), "utf8");
  assert.match(
    source,
    /const kiHandler = createKeyboardInteractiveHandler\(\{\s*sender: event\.sender,\s*sessionId: connId,\s*hostId: options\.hostId,/,
  );
});

test("openSftp cleans an opened proxy socket when target key passphrase is cancelled", async (t) => {
  const originalRequestPassphrase = passphraseHandler.requestPassphrase;
  t.after(() => {
    passphraseHandler.requestPassphrase = originalRequestPassphrase;
  });
  passphraseHandler.requestPassphrase = async () => ({ cancelled: true });

  const proxySocket = {
    ended: false,
    destroyed: false,
    end() {
      this.ended = true;
    },
    destroy() {
      this.destroyed = true;
    },
  };
  const bridge = loadSftpBridgeWithProxySocket(proxySocket);

  await assert.rejects(
    bridge.openSftp(
      { sender: createSender() },
      {
        sessionId: "sftp-cleanup-test",
        hostname: "target.example",
        port: 22,
        username: "alice",
        proxy: {
          type: "socks5",
          host: "proxy.example",
          port: 1080,
        },
        privateKey: "-----BEGIN ENCRYPTED PRIVATE KEY-----\nkey\n-----END ENCRYPTED PRIVATE KEY-----",
        keyId: "target-key",
      },
    ),
    /Passphrase entry cancelled/,
  );

  assert.equal(proxySocket.ended, true);
  assert.equal(proxySocket.destroyed, true);
});

test("openSftp cleans a jump proxy socket when the first jump connection fails", async () => {
  FailingSshClient.instances = [];
  const proxySocket = {
    ended: false,
    destroyed: false,
    end() {
      this.ended = true;
    },
    destroy() {
      this.destroyed = true;
    },
  };
  const bridge = loadSftpBridgeWithProxySocket(proxySocket, {
    SSHClient: FailingSshClient,
  });

  await assert.rejects(
    bridge.openSftp(
      { sender: createSender() },
      {
        sessionId: "sftp-jump-cleanup-test",
        hostname: "target.example",
        port: 22,
        username: "alice",
        jumpHosts: [
          {
            hostname: "jump.example",
            port: 22,
            username: "jump",
            proxy: {
              type: "socks5",
              host: "proxy.example",
              port: 1080,
            },
          },
        ],
      },
    ),
    /jump connect failed/,
  );

  assert.equal(proxySocket.ended, true);
  assert.equal(proxySocket.destroyed, true);
  assert.equal(FailingSshClient.instances[0]?.ended, true);
});

test("openSftpForSession holds a shared SSH connection until the SFTP handle closes", async () => {
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 60_000 });
  const bridge = loadSftpBridgeWithProxySocket(null);
  const sftpClients = new Map();
  const fakeSftp = {
    ended: false,
    readdir: () => {},
    stat: () => {},
    mkdir: () => {},
    unlink: () => {},
    end() {
      this.ended = true;
    },
  };
  const conn = {
    ended: false,
    _sock: { destroyed: false },
    sftp(cb) {
      cb(null, fakeSftp);
    },
    end() {
      this.ended = true;
    },
  };
  const session = {
    conn,
    stream: {},
  };
  createConnectionRef(session, conn, []);
  const transport = session.connRef;
  const sessions = new Map([["session-1", session]]);
  bridge.init({ sftpClients, sessions, electronModule: {} });

  const opened = await bridge.openSftpForSession(null, { sessionId: "session-1" });

  assert.equal(opened.ok, true);
  assert.equal(transport.count, 2);
  // Drop the terminal lease; SFTP still holds the shared transport.
  assert.equal(releaseConnectionRef(session), false);
  assert.equal(conn.ended, false);
  assert.equal(transport.count, 1);

  await bridge.closeSftp(null, { sftpId: opened.sftpId });

  assert.equal(fakeSftp.ended, true);
  // Last lease parks (does not force-end) while idle TTL remains.
  assert.equal(conn.ended, false);
  assert.equal(transport.state, "idle");
  assert.equal(transport.count, 0);
  setDefaultTransportIdleTtlMs(60_000);
});

test("openSftpForSession honors session.sftpFileProtocol when payload omits fileProtocol", async () => {
  const bridge = loadSftpBridgeWithProxySocket(null);
  const sftpClients = new Map();
  let sftpCalls = 0;
  const fakeSftp = {
    ended: false,
    readdir: () => {},
    stat: () => {},
    mkdir: () => {},
    unlink: () => {},
    end() {
      this.ended = true;
    },
  };
  const conn = {
    ended: false,
    sftp(cb) {
      sftpCalls += 1;
      cb(null, fakeSftp);
    },
    end() {
      this.ended = true;
    },
  };
  // Forced SFTP: session preference must prevent SCP fallback even without payload.fileProtocol
  const session = {
    conn,
    stream: {},
    sftpFileProtocol: "sftp",
  };
  const sessions = new Map([["session-proto", session]]);
  bridge.init({ sftpClients, sessions, electronModule: {} });

  const opened = await bridge.openSftpForSession(null, { sessionId: "session-proto" });
  assert.equal(opened.ok, true);
  assert.equal(opened.fileProtocol, "sftp");
  assert.equal(sftpCalls, 1);
  assert.equal(sftpClients.get(opened.sftpId)?.__netcattyFileProtocol, "sftp");
  await bridge.closeSftp(null, { sftpId: opened.sftpId });
});

test("openSftpForSession rejects sudo with forced SCP before opening a channel", async () => {
  let sudoCalls = 0;
  let sftpCalls = 0;
  const bridge = loadSftpBridgeWithProxySocket(null, {
    connectSudoSftp: async () => {
      sudoCalls += 1;
      throw new Error("connectSudoSftp should not run for scp+sudo");
    },
  });
  const sftpClients = new Map();
  const conn = {
    sftp(cb) {
      sftpCalls += 1;
      cb(null, createFakeSftpChannel());
    },
    end() {},
  };
  const session = {
    conn,
    stream: {},
    sftpFileProtocol: "scp",
  };
  bridge.init({
    sftpClients,
    sessions: new Map([["session-sudo-scp", session]]),
    electronModule: {},
  });

  await assert.rejects(
    () => bridge.openSftpForSession(null, {
      sessionId: "session-sudo-scp",
      sudo: true,
      fileProtocol: "scp",
      password: "secret",
    }),
    /Sudo Mode is not supported with File Protocol set to SCP/i,
  );
  assert.equal(sudoCalls, 0);
  assert.equal(sftpCalls, 0);
  assert.equal(sftpClients.size, 0);
});

test("openSftpForSession fails clearly instead of silently dropping sudo mode", async () => {
  let sudoCalls = 0;
  let sftpCalls = 0;
  const bridge = loadSftpBridgeWithProxySocket(null, {
    connectSudoSftp: async () => {
      sudoCalls += 1;
      throw new Error("SFTP sudo failed with exit code 127. sftp-server not found");
    },
  });
  const sftpClients = new Map();
  const fakeSftp = createFakeSftpChannel();
  const conn = {
    sftp(cb) {
      sftpCalls += 1;
      cb(null, fakeSftp);
    },
    end() {},
  };
  const session = { conn, stream: {} };
  bridge.init({
    sftpClients,
    sessions: new Map([["session-sudo-127", session]]),
    electronModule: {},
  });

  await assert.rejects(
    () => bridge.openSftpForSession(null, {
      sessionId: "session-sudo-127",
      sudo: true,
      password: "secret",
    }),
    /exit code 127.*sftp-server not found/i,
  );
  assert.equal(sudoCalls, 1);
  assert.equal(sftpCalls, 0);
  assert.equal(sftpClients.size, 0);
});

test("openSftpForSession does not fall back to standard SFTP on non-127 sudo errors", async () => {
  let sftpCalls = 0;
  const bridge = loadSftpBridgeWithProxySocket(null, {
    connectSudoSftp: async () => {
      throw new Error("SFTP sudo failed with exit code 1. The password may be incorrect");
    },
  });
  const sftpClients = new Map();
  const conn = {
    sftp(cb) {
      sftpCalls += 1;
      cb(null, createFakeSftpChannel());
    },
    end() {},
  };
  const session = { conn, stream: {} };
  bridge.init({
    sftpClients,
    sessions: new Map([["session-sudo-auth", session]]),
    electronModule: {},
  });

  await assert.rejects(
    () => bridge.openSftpForSession(null, {
      sessionId: "session-sudo-auth",
      sudo: true,
      password: "wrong",
    }),
    /exit code 1/i,
  );
  assert.equal(sftpCalls, 0);
  assert.equal(sftpClients.size, 0);
});

test("openSftpForSession keeps sudo mode when connectSudoSftp succeeds", async () => {
  const sudoWrapper = createFakeSftpChannel();
  let closeBound = false;
  sudoWrapper.on = (event, cb) => {
    if (event === "close") closeBound = true;
    return sudoWrapper;
  };
  const bridge = loadSftpBridgeWithProxySocket(null, {
    connectSudoSftp: async () => sudoWrapper,
  });
  const sftpClients = new Map();
  let sftpCalls = 0;
  const conn = {
    sftp(cb) {
      sftpCalls += 1;
      cb(null, createFakeSftpChannel());
    },
    end() {},
  };
  const session = { conn, stream: {} };
  bridge.init({
    sftpClients,
    sessions: new Map([["session-sudo-ok", session]]),
    electronModule: {},
  });

  const opened = await bridge.openSftpForSession(null, {
    sessionId: "session-sudo-ok",
    sudo: true,
    password: "secret",
  });

  assert.equal(opened.ok, true);
  assert.equal(sftpCalls, 0);
  const client = sftpClients.get(opened.sftpId);
  assert.equal(client?.__netcattySudoMode, true);
  assert.equal(client?.sftp, sudoWrapper);
  assert.equal(closeBound, true);
  await bridge.closeSftp(null, { sftpId: opened.sftpId });
});
