"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const bridge = require("./sftpBridge.cjs");
const { buildConnectionReuseEndpoint, normalizeEndpoint } = require("./sshConnectionPool.cjs");

test('exact-session-only browse refuses the dedicated-login path on single-channel hosts', async () => {
  let dialed = false;
  bridge.init({ sessions: new Map([['terminal', {
    singleChannelSsh: true, conn: { sftp() { throw new Error('must not borrow'); } },
    async _openDedicatedSftp() { dialed = true; return { sftpId: 'wrong' }; },
  }]]), sftpClients: new Map(), electronModule: {} });
  await assert.rejects(bridge.openSftpForSession(null, { sessionId: 'terminal', reuseExactSessionOnly: true }),
    { code: 'ERR_SFTP_SINGLE_CHANNEL_BASTION' });
  assert.equal(dialed, false);
});

test('exact-session-only browse never borrows a different live session', async () => {
  let borrowed = false;
  bridge.init({ sessions: new Map([['other', { conn: { sftp() { borrowed = true; } } }]]),
    sftpClients: new Map(), electronModule: {} });
  await assert.rejects(bridge.openSftpForSession(null, { sessionId: 'missing', reuseExactSessionOnly: true }), /not found/);
  assert.equal(borrowed, false);
});

test('exact-session-only browse uses authenticated password/proxy identity without reconstructing credentials', async () => {
  const options = { hostname: 'host', username: 'me', password: 'test-only-password',
    authMethod: 'password', proxy: { type: 'socks5', host: 'proxy', port: 1080 } };
  let opened = 0; let ended = false;
  const channel = { readdir() {}, stat() {}, mkdir() {}, unlink() {}, end() { ended = true; } };
  const conn = { sftp(callback) { opened++; callback(null, channel); } };
  const clients = new Map();
  bridge.init({ sessions: new Map([['terminal', {
    conn, _reuseEndpoint: normalizeEndpoint(buildConnectionReuseEndpoint(options)),
  }]]), sftpClients: clients, electronModule: {} });
  const result = await bridge.openSftpForSession(null, {
    sessionId: 'terminal', reuseExactSessionOnly: true, fileProtocol: 'sftp',
    expectedEndpoint: { hostname: 'host', username: 'me' },
  });
  assert.equal(result.sourceSessionId, 'terminal');
  assert.equal(opened, 1);
  await bridge.closeSftp(null, { sftpId: result.sftpId });
  assert.equal(ended, true);
});

test("GUI vault reconnect finds the dedicated terminal dial without a source-session hint", async (t) => {
  t.mock.method(require("node:net").Socket.prototype, "connect", () => {
    throw new Error("Unexpected fresh vault dial instead of the terminal profile");
  });
  const options = {
    hostId: "vault-gateway", hostname: "gateway.example", username: "gateway/target/root",
    password: "test-only-password", authMethod: "password", port: 22, fileProtocol: "sftp",
  };
  let opened = 0;
  const clients = new Map([["gui-dedicated", {}]]);
  bridge.init({ sessions: new Map([["live-terminal", {
    singleChannelSsh: true, remoteSshVersion: "TERM-SSHD",
    _reuseEndpoint: normalizeEndpoint({ ...buildConnectionReuseEndpoint(options), singleChannelSsh: true }),
    _sftpReuseEndpoint: null,
    conn: { sftp() { throw new Error("terminal channel must not be borrowed"); } },
    async _openDedicatedSftp(payload) {
      opened++;
      assert.equal(payload.sessionId, "live-terminal");
      return { sftpId: "gui-dedicated", sourceSessionId: "live-terminal", fileProtocol: "sftp" };
    },
  }]]), sftpClients: clients, electronModule: {} });
  assert.equal((await bridge.openSftp({ sender: { isDestroyed: () => false } }, options)).sftpId, "gui-dedicated");
  assert.equal(opened, 1);
});

for (const code of ["ERR_HOST_KEY_UNVERIFIED", "ERR_SFTP_SOURCE_SESSION_CLOSED", "ABORT_ERR"]) {
  test(`GUI dedicated dial propagates ${code} without fresh-login fallback`, async (t) => {
    let freshDials = 0;
    t.mock.method(require("node:net").Socket.prototype, "connect", () => {
      freshDials++;
      throw new Error("Unexpected fresh connection after dedicated-dial rejection");
    });
    const options = { hostname: "gateway.example", username: "root", password: "test-only", authMethod: "password", fileProtocol: "sftp" };
    const failure = Object.assign(new Error("dedicated trust or lifecycle rejection"), { code });
    const session = {
      singleChannelSsh: true,
      _reuseEndpoint: normalizeEndpoint({ ...buildConnectionReuseEndpoint(options), singleChannelSsh: true }),
      conn: { sftp() { throw new Error("must not borrow terminal"); } },
      async _openDedicatedSftp() {
        // Lifecycle cleanup may remove the capability while an open is pending.
        delete session._openDedicatedSftp;
        throw failure;
      },
    };
    bridge.init({ sessions: new Map([["terminal", session]]), sftpClients: new Map(), electronModule: {} });
    await assert.rejects(bridge.openSftp({ sender: { isDestroyed: () => false } }, options), error => error === failure);
    assert.equal(freshDials, 0);
  });
}

test("ordinary reusable-channel failures retain fresh-login fallback", async (t) => {
  let freshDials = 0;
  let borrowedChannels = 0;
  t.mock.method(require("node:net").Socket.prototype, "connect", () => {
    freshDials++;
    throw new Error("fresh-login fallback reached");
  });
  const options = { hostname: "ordinary.example", username: "root", password: "test-only", authMethod: "password", fileProtocol: "sftp", useSshAgent: false };
  const endpoint = normalizeEndpoint(buildConnectionReuseEndpoint(options));
  const conn = Object.assign(new (require("node:events").EventEmitter)(), {
    sftp(callback) { borrowedChannels++; callback(new Error("channel failed")); },
  });
  bridge.init({ sessions: new Map([["ordinary", {
    _reuseEndpoint: endpoint, _sftpReuseEndpoint: endpoint, conn,
  }]]), sftpClients: new Map(), electronModule: {} });
  await assert.rejects(bridge.openSftp({ sender: { isDestroyed: () => false } }, options), /fresh-login fallback reached/);
  assert.ok(borrowedChannels > 0);
  assert.equal(freshDials, 1);
});

for (const mismatch of [null, "hostId", "hostname", "username", "password", "jumpHosts", "proxy", "agentForwarding"]) {
  test(`single-channel endpoint validation selects a dedicated dial only for matching identity (${mismatch})`, async () => {
    const options = {
      hostId: "gateway-target", hostname: "gateway.example", username: "gateway/target/root",
      password: "test-only-password", authMethod: "password", port: 22,
      jumpHosts: [{ hostname: "jump.example", username: "jump-user", password: "jump-test" }],
    };
    const requested = { ...options };
    if (mismatch === "hostId") requested.hostId = "other-profile";
    if (mismatch === "hostname") requested.hostname = "other.example";
    if (mismatch === "username") requested.username = "another-user";
    if (mismatch === "password") requested.password = "different-test-password";
    if (mismatch === "jumpHosts") requested.jumpHosts = [{ ...options.jumpHosts[0], hostname: "other-jump.example" }];
    if (mismatch === "proxy") requested.proxy = { type: "http", host: "proxy.example", port: 8080 };
    if (mismatch === "agentForwarding") requested.agentForwarding = true;
    let dedicatedDials = 0;
    const clients = new Map([["dedicated", {}]]);
    bridge.init({ sessions: new Map([["terminal", {
      singleChannelSsh: true, remoteSshVersion: "TERM-SSHD",
      _reuseEndpoint: normalizeEndpoint({ ...buildConnectionReuseEndpoint(options), singleChannelSsh: true }),
      conn: { sftp() { throw new Error("must not borrow a terminal channel"); } },
      async _openDedicatedSftp() { dedicatedDials++; return { sftpId: "dedicated", sourceSessionId: "terminal" }; },
    }]]), sftpClients: clients, electronModule: {} });
    const result = bridge.openSftpForSession(null, {
      sessionId: "terminal", expectedEndpoint: requested, requireExactSourceSession: true,
    });
    if (mismatch) {
      await assert.rejects(result, { code: "ERR_SFTP_SOURCE_ROUTE_MISMATCH" });
      assert.equal(dedicatedDials, 0);
    } else {
      assert.equal((await result).sftpId, "dedicated");
      assert.equal(dedicatedDials, 1);
    }
  });
}

for (const flag of [true, false]) {
  test(`single-channel session opens a dedicated SFTP connection (runtime flag=${flag})`, async () => {
    let terminalChannels = 0;
    const clients = new Map([["dedicated", {}]]);
    const controller = new AbortController();
    const payload = { sessionId: "terminal", abortSignal: controller.signal, fileProtocol: "sftp" };
    const session = {
      singleChannelSsh: flag, remoteSshVersion: "TERM-SSHD",
      conn: { sftp() { terminalChannels++; throw new Error("terminal must remain untouched"); } },
      async _openDedicatedSftp(received) {
        assert.equal(received, payload);
        return { sftpId: "dedicated", sourceSessionId: "terminal", fileProtocol: "sftp" };
      },
    };
    bridge.init({ sessions: new Map([["terminal", session]]), sftpClients: clients, electronModule: {} });
    assert.deepEqual(await bridge.openSftpForSession(null, payload), {
      sftpId: "dedicated", sourceSessionId: "terminal", fileProtocol: "sftp",
    });
    assert.equal(terminalChannels, 0);
    assert.equal(clients.get("dedicated").__netcattySourceSessionId, "terminal");
  });
}

test("legacy single-channel sessions retain the protection when no dial profile exists", async () => {
  bridge.init({ sessions: new Map([["terminal", {
    singleChannelSsh: true, conn: { sftp() { throw new Error("must not open"); } },
  }]]), sftpClients: new Map(), electronModule: {} });
  await assert.rejects(bridge.openSftpForSession(null, { sessionId: "terminal" }), {
    code: "ERR_SFTP_SINGLE_CHANNEL_BASTION",
  });
});

test("dedicated opens restore auto-detected filename encoding across MCP operations", async () => {
  const iconv = require("iconv-lite");
  const name = "\u4e2d\u6587.txt";
  const path = `/${name}`;
  const clients = new Map();
  const paths = [];
  let opened = 0;
  const session = {
    singleChannelSsh: true,
    conn: { sftp() { throw new Error("must not borrow terminal"); } },
    async _openDedicatedSftp() {
      const sftpId = `encoding-dedicated-${++opened}`;
      clients.set(sftpId, { end: async () => {}, sftp: {
        mkdir() {}, unlink() {},
        readdir(_path, callback) { callback(null, [{ filename: name, filenameRaw: iconv.encode(name, "gb18030"), attrs: { mode: 0o100644, size: 7, mtime: 1 } }]); },
        stat(encodedPath, callback) { paths.push(encodedPath); callback(null, { mode: 0o100644, size: 7, mtime: 1 }); },
      } });
      return { sftpId };
    },
  };
  bridge.init({ sessions: new Map([["encoding-terminal", session]]), sftpClients: clients, electronModule: {} });
  const key = "dedicated-encoding-regression";
  try {
    const first = await bridge.openSftpForSession(null, { sessionId: "encoding-terminal", encodingStateKey: key });
    const list = await bridge.listSftp(null, { sftpId: first.sftpId, path: "/", encoding: "auto" });
    assert.equal(list[0].name, name);
    assert.equal(bridge.getResolvedFilenameEncoding(first.sftpId), "gb18030");
    await bridge.closeSftp(null, { sftpId: first.sftpId, encodingStateKey: key });
    const second = await bridge.openSftpForSession(null, { sessionId: "encoding-terminal", encodingStateKey: key });
    await bridge.statSftp(null, { sftpId: second.sftpId, path, encoding: "auto" });
    assert.deepEqual(paths, [iconv.encode(path, "gb18030")]);
    await bridge.closeSftp(null, { sftpId: second.sftpId });
  } finally {
    bridge.clearSftpEncodingState(key);
  }
});

for (const keepaliveInterval of [0, 60]) for (const initialTrust of [[], [{ hostname: "gateway.example", port: 22, keyType: "ssh-rsa", fingerprint: "SHA256:old" }]]) {
  test(`GUI dedicated dial follows newly saved accepted key (previous records=${initialTrust.length}, keepalive=${keepaliveInterval})`, async (t) => {
    t.mock.method(require("node:net").Socket.prototype, "connect", () => { throw new Error("unexpected fresh login"); });
    const accepted = { hostname: "gateway.example", port: 22, keyType: "ssh-rsa", fingerprint: "SHA256:accepted" };
    const options = { hostname: accepted.hostname, username: "root", password: "captured", authMethod: "password", knownHosts: initialTrust, keepaliveInterval };
    const session = { singleChannelSsh: true, conn: { sftp() { throw new Error("must not borrow"); } }, _reuseEndpoint: normalizeEndpoint(buildConnectionReuseEndpoint(options)) };
    const sessions = new Map([["terminal", session]]);
    let dials = 0;
    require("./sshBridge/sessionSftpDial.cjs").attachSessionSftpDial(session, options, {
      sessions, sessionId: "terminal", sender: { isDestroyed: () => false }, acceptedHostKeys: [accepted],
      openSftp: async () => { dials++; return { sftpId: "saved-trust" }; },
    });
    bridge.init({ sessions, sftpClients: new Map(), electronModule: {} });
    assert.equal((await bridge.openSftp(null, { ...options, knownHosts: [accepted] })).sftpId, "saved-trust");
    assert.equal(dials, 1);
    for (const knownHosts of [[], [{ ...accepted, fingerprint: "SHA256:other" }], [{ ...accepted, port: 2222 }]]) {
      await assert.rejects(bridge.openSftp(null, { ...options, knownHosts }), { code: "ERR_HOST_KEY_UNVERIFIED" });
    }
    assert.equal(dials, 1);
  });
}

test("dedicated GUI trust checks verified jump even when target verification is disabled", async () => {
  const accepted = { hostname: "jump.example", port: 22, keyType: "ssh-rsa", fingerprint: "SHA256:jump" };
  const options = { hostname: "target.example", verifyHostKeys: false, jumpHosts: [{ hostname: "jump.example", verifyHostKeys: true }] };
  const session = {};
  let dials = 0;
  require("./sshBridge/sessionSftpDial.cjs").attachSessionSftpDial(session, options, {
    sessions: new Map([["terminal", session]]), sessionId: "terminal", acceptedHostKeys: [accepted],
    openSftp: async () => { dials++; return { sftpId: "jump-trust" }; },
  });
  assert.equal(session._matchesDedicatedSftpEndpoint({ ...options, knownHosts: [accepted] }), true);
  await session._openDedicatedSftp({ expectedEndpoint: { ...options, knownHosts: [accepted] } });
  await assert.rejects(session._openDedicatedSftp({ expectedEndpoint: { ...options, knownHosts: [] } }), { code: "ERR_HOST_KEY_UNVERIFIED" });
  assert.equal(dials, 1);
});
