const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createConnectionRef,
  acquireConnectionRef,
  releaseConnectionRef,
  transferConnectionRef,
  consumePendingShellReconnectRisk,
  findReusableSession,
  createTransport,
  borrowTransport,
  returnTransport,
  discardTransport,
  discardAllTransports,
  findTransportByEndpoint,
  resolveTransportForReuse,
  beginTransportDial,
  waitForTransportDial,
  completeTransportDial,
  failTransportDial,
  getTransportStats,
  setDefaultTransportIdleTtlMs,
  getDefaultTransportIdleTtlMs,
  buildEndpointKey,
  buildConnectionReuseEndpoint,
  normalizeEndpoint,
  endpointAllowsReuse,
  fingerprintAuth,
  resetSshTransportRegistryForTests,
  markEndpointNoIdlePark,
  endpointAllowsIdlePark,
  DEFAULT_SSH_TRANSPORT_IDLE_TTL_MS,
  DEFAULT_MAX_IDLE_SSH_TRANSPORTS,
  LEASE_KINDS,
} = require("./sshConnectionPool.cjs");

function makeConn() {
  return {
    ended: 0,
    _sock: { destroyed: false },
    end() { this.ended += 1; },
  };
}

function makeChainConn() {
  return {
    ended: 0,
    end() { this.ended += 1; },
  };
}

function makeLifecycleConn({ emitCloseFromEnd = false } = {}) {
  const conn = new EventEmitter();
  conn.ended = 0;
  conn._sock = { destroyed: false };
  conn.end = () => {
    conn.ended += 1;
    if (emitCloseFromEnd) conn.emit("close");
  };
  return conn;
}

/** Product default: TTL 0 parks until quit (never auto-reclaim). */
function useParkForever() {
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
}

/**
 * Short positive TTL with fake timers so tests can fire idle reclaim.
 * Returns the timer list.
 */
function useShortTtlTimers(ttlMs = 1) {
  const timers = [];
  resetSshTransportRegistryForTests({
    defaultIdleTtlMs: ttlMs,
    setTimeout: (fn, ms) => {
      const handle = { fn, ms, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      if (handle) handle.cleared = true;
    },
  });
  return timers;
}

function fireIdleTimers(timers) {
  for (const t of [...timers]) {
    if (!t.cleared && typeof t.fn === "function") t.fn();
  }
}

test.beforeEach(() => {
  useParkForever();
});

test.afterEach(() => {
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
});

test("concurrent compatible opens share one in-flight physical dial", async () => {
  const endpoint = {
    hostId: "host-1",
    hostname: "same.example",
    username: "alice",
    authType: "password",
    password: "secret",
  };
  let physicalDials = 0;
  let releaseDial;
  const dialGate = new Promise((resolve) => { releaseDial = resolve; });

  const open = async () => {
    const coordination = beginTransportDial(endpoint, { kind: "shell" });
    if (coordination.role === "reuse") return coordination.transport;
    if (coordination.role === "join") return waitForTransportDial(coordination);

    physicalDials += 1;
    await dialGate;
    const transport = createTransport({ conn: makeConn(), endpoint });
    completeTransportDial(coordination, transport);
    return transport;
  };

  const first = open();
  const second = open();
  assert.equal(physicalDials, 1, "only the leader may create the physical SSH connection");
  releaseDial();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left, right);

  const sequential = beginTransportDial(endpoint, { kind: "shell" });
  assert.equal(sequential.role, "reuse");
  assert.equal(sequential.transport, left);
});

test("in-flight dials isolate endpoint, profile, credentials, and ForwardAgent policy", () => {
  const base = {
    hostId: "host-1",
    hostname: "same.example",
    username: "alice",
    authType: "password",
    password: "secret",
    agentForwarding: false,
  };
  const leader = beginTransportDial(base, { kind: "shell" });
  assert.equal(leader.role, "leader");
  assert.equal(beginTransportDial({ ...base }, { kind: "shell" }).role, "join");

  assert.equal(
    beginTransportDial({ ...base, hostname: "other.example" }, { kind: "shell" }).role,
    "leader",
  );
  assert.equal(
    beginTransportDial({ ...base, hostId: "host-2" }, { kind: "shell" }).role,
    "leader",
  );
  assert.equal(
    beginTransportDial({ ...base, password: "rotated" }, { kind: "shell" }).role,
    "leader",
  );
  assert.equal(
    beginTransportDial({ ...base, agentForwarding: true }, { kind: "shell" }).role,
    "leader",
  );
});

test("automatic key/password dials coalesce only when every possible credential matches", () => {
  const base = {
    hostId: "host-auto",
    hostname: "auto.example",
    username: "alice",
    authType: "auto",
    privateKey: "configured-private-key",
    password: "fallback-password-v1",
  };
  const leader = beginTransportDial(base, { kind: "shell" });
  assert.equal(leader.role, "leader");
  assert.equal(
    beginTransportDial({ ...base }, { kind: "channel" }).role,
    "join",
    "identical automatic opens should still share one pending physical dial",
  );
  assert.equal(
    beginTransportDial({ ...base, password: "fallback-password-v2" }, { kind: "channel" }).role,
    "leader",
    "a rotated fallback password must not join a dial whose final auth method is not known yet",
  );
});

test("channel opens can join a ForwardAgent leader but not the reverse", () => {
  const base = {
    hostId: "host-1",
    hostname: "same.example",
    username: "alice",
  };
  const forwardAgentLeader = beginTransportDial(
    { ...base, agentForwarding: true },
    { kind: "shell" },
  );
  assert.equal(forwardAgentLeader.role, "leader");
  assert.equal(
    beginTransportDial({ ...base, agentForwarding: false }, { kind: "channel" }).role,
    "join",
  );

  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  const noForwardAgentLeader = beginTransportDial(
    { ...base, agentForwarding: false },
    { kind: "channel" },
  );
  assert.equal(noForwardAgentLeader.role, "leader");
  assert.equal(
    beginTransportDial({ ...base, agentForwarding: true }, { kind: "shell" }).role,
    "leader",
  );
});

test("a channel waiter can use a leader transport that negotiated ForwardAgent off", async () => {
  const requestedByLeader = {
    hostId: "host-agent-downgrade",
    hostname: "agent-downgrade.example",
    username: "alice",
    agentForwarding: true,
  };
  const leader = beginTransportDial(requestedByLeader, { kind: "shell" });
  const channelWaiter = beginTransportDial({
    ...requestedByLeader,
    agentForwarding: false,
  }, { kind: "channel" });
  assert.equal(channelWaiter.role, "join");

  const transport = createTransport({
    conn: makeConn(),
    endpoint: { ...requestedByLeader, agentForwarding: false },
  });
  assert.equal(completeTransportDial(leader, transport), true);
  assert.equal(await waitForTransportDial(channelWaiter), transport);
  await assert.rejects(waitForTransportDial(leader), /incompatible/i);
});

test("cancelled in-flight waiter does not cancel the shared physical dial", async () => {
  const endpoint = { hostname: "same.example", username: "alice" };
  const leader = beginTransportDial(endpoint, { kind: "shell" });
  const joined = beginTransportDial(endpoint, { kind: "shell" });
  const controller = new AbortController();
  const waiting = waitForTransportDial(joined, { signal: controller.signal });
  controller.abort(new Error("caller cancelled"));
  await assert.rejects(waiting, /caller cancelled/);

  const transport = createTransport({ conn: makeConn(), endpoint });
  assert.equal(completeTransportDial(leader, transport), true);
  assert.equal(beginTransportDial(endpoint, { kind: "shell" }).transport, transport);
});

test("failed in-flight dial releases the slot so a later open can retry", async () => {
  const endpoint = { hostname: "retry.example", username: "alice" };
  const leader = beginTransportDial(endpoint, { kind: "shell" });
  const joined = beginTransportDial(endpoint, { kind: "shell" });
  const waiting = waitForTransportDial(joined);
  assert.equal(failTransportDial(leader, new Error("authentication failed")), true);
  await assert.rejects(waiting, /authentication failed/);

  const retry = beginTransportDial(endpoint, { kind: "shell" });
  assert.equal(retry.role, "leader");
});

test("TERM-SSHD last lease ends the transport instead of idle-parking", () => {
  const conn = makeConn();
  conn._remoteVer = "TERM-SSHD";
  const owner = { remoteSshVersion: "TERM-SSHD" };
  const connRef = createConnectionRef(owner, conn, []);
  assert.equal(connRef.allowIdlePark, false);
  assert.equal(endpointAllowsIdlePark(connRef.endpoint, "TERM-SSHD"), false);

  const ended = releaseConnectionRef(owner);
  assert.equal(ended, true);
  assert.equal(conn.ended, 1);
  assert.equal(connRef.state, "dead");
  assert.equal(connRef.endedReason, "no-idle-park");
});

test("TERM-SSHD last shell with an SFTP lease refuses later shell reuse", () => {
  const conn = makeConn();
  conn._remoteVer = "TERM-SSHD";
  const endpoint = { hostname: "blj.yd.com.cn", username: "test", port: 22 };
  const owner = { stream: {}, remoteSshVersion: "TERM-SSHD", _reuseEndpoint: endpoint };
  const sftp = { id: "sftp", __sshLeaseKind: "sftp" };
  const transport = createConnectionRef(owner, conn, []);
  acquireConnectionRef(sftp, transport);
  assert.equal(releaseConnectionRef(owner), false);
  assert.equal(transport.state, "live");
  assert.equal(transport.allowShellReuse, false);
  assert.equal(findTransportByEndpoint(transport.endpoint, { kind: "shell" }), null);
  assert.equal(findTransportByEndpoint(transport.endpoint, { kind: "channel" }), transport);
});

test("an endpoint denylisted after a dead parked shell does not idle-park later transports", () => {
  const endpoint = { hostname: "bastion.example", username: "alice", port: 22 };
  markEndpointNoIdlePark(endpoint);
  assert.equal(endpointAllowsIdlePark(endpoint, "OpenSSH_9.0"), false);

  const conn = makeConn();
  conn._remoteVer = "OpenSSH_9.0";
  const transport = createTransport({ conn, endpoint });
  assert.equal(transport.allowIdlePark, false);

  const holder = {};
  borrowTransport(transport, { kind: "shell", holder });
  assert.equal(releaseConnectionRef(holder), true);
  assert.equal(transport.state, "dead");
  assert.equal(conn.ended, 1);
});

test("releaseConnectionRef parks on last channel when TTL is 0 (until quit)", () => {
  const conn = makeConn();
  const chain = [makeChainConn(), makeChainConn()];
  const owner = {};
  const reused = {};

  const connRef = createConnectionRef(owner, conn, chain);
  assert.equal(connRef.count, 1);

  acquireConnectionRef(reused, connRef);
  assert.equal(connRef.count, 2);
  assert.equal(reused.connRef, connRef);

  let ended = releaseConnectionRef(reused);
  assert.equal(ended, false);
  assert.equal(conn.ended, 0);
  assert.equal(reused.connRef, null);

  // Last lease parks (TTL 0 = never auto-end).
  ended = releaseConnectionRef(owner);
  assert.equal(ended, false);
  assert.equal(conn.ended, 0);
  assert.equal(connRef.state, "idle");
  assert.equal(owner.connRef, null);

  assert.equal(discardTransport(connRef), true);
  assert.equal(conn.ended, 1);
  assert.equal(chain[0].ended, 1);
  assert.equal(chain[1].ended, 1);
});

test("releaseConnectionRef keeps siblings alive when the owner closes first", () => {
  const timers = useShortTtlTimers(1);
  const conn = makeConn();
  const owner = {};
  const reused = {};
  const connRef = createConnectionRef(owner, conn, []);
  acquireConnectionRef(reused, connRef);

  assert.equal(releaseConnectionRef(owner), false);
  assert.equal(conn.ended, 0, "connection must survive for the remaining copy");

  // Last holder parks; fire TTL to end.
  assert.equal(releaseConnectionRef(reused), false);
  assert.equal(connRef.state, "idle");
  fireIdleTimers(timers);
  assert.equal(conn.ended, 1);
});

test("releaseConnectionRef is idempotent per session", () => {
  const conn = makeConn();
  const owner = {};
  const connRef = createConnectionRef(owner, conn, []);
  acquireConnectionRef({}, connRef); // bump count to 2 so a double release can't reach 0 by itself

  assert.equal(releaseConnectionRef(owner), false);
  assert.equal(releaseConnectionRef(owner), false);
  assert.equal(connRef.count, 1);
  assert.equal(conn.ended, 0);
});

test("releaseConnectionRef on a session without a descriptor is a safe no-op", () => {
  assert.equal(releaseConnectionRef({}), false);
  assert.equal(releaseConnectionRef(null), false);
  assert.equal(releaseConnectionRef(undefined), false);
});

test("last shell close marks reconnect risk while an SFTP lease keeps the transport live", () => {
  const owner = { id: "shell", stream: {} };
  const sftp = { id: "sftp", __sshLeaseKind: "sftp" };
  const transport = createConnectionRef(owner, makeConn(), []);
  acquireConnectionRef(sftp, transport);

  assert.equal(releaseConnectionRef(owner), false);
  assert.deepEqual(consumePendingShellReconnectRisk(transport), {
    oldShellPids: [],
    hasUnknownOldShell: true,
  });
  assert.equal(consumePendingShellReconnectRisk(transport), false);
});

test("single-channel connection parks on release when TTL is 0", () => {
  const conn = makeConn();
  const chain = [makeChainConn()];
  const owner = {};
  const transport = createConnectionRef(owner, conn, chain);

  assert.equal(releaseConnectionRef(owner), false);
  assert.equal(transport.state, "idle");
  assert.equal(conn.ended, 0);
  assert.equal(discardTransport(transport), true);
  assert.equal(conn.ended, 1);
  assert.equal(chain[0].ended, 1);
});

test("findReusableSession returns a live interactive SSH shell session", () => {
  const sessions = new Map();
  const source = {
    conn: { _sock: { destroyed: false } },
    stream: {},
    connRef: { count: 1, state: "live" },
  };
  sessions.set("src", source);

  assert.equal(findReusableSession(sessions, "src"), source);
});

test("findReusableSession rejects sessions missing a usable connection", () => {
  const sessions = new Map();

  sessions.set("no-stream", { conn: {}, connRef: { count: 1, state: "live" } });
  assert.equal(findReusableSession(sessions, "no-stream"), null);

  sessions.set("no-ref", { conn: {}, stream: {} });
  assert.equal(findReusableSession(sessions, "no-ref"), null);

  sessions.set("no-conn", { stream: {}, connRef: { count: 1, state: "live" } });
  assert.equal(findReusableSession(sessions, "no-conn"), null);

  sessions.set("dead", {
    conn: { _sock: { destroyed: true } },
    stream: {},
    connRef: { count: 1, state: "live" },
  });
  assert.equal(findReusableSession(sessions, "dead"), null);
});

test("findReusableSession handles missing inputs gracefully", () => {
  assert.equal(findReusableSession(null, "x"), null);
  assert.equal(findReusableSession(new Map(), ""), null);
  assert.equal(findReusableSession(new Map(), "absent"), null);
});

test("findReusableSession enforces an exact target endpoint match", () => {
  const sessions = new Map();
  const source = {
    conn: { _sock: { destroyed: false } },
    stream: {},
    connRef: { count: 1, state: "live" },
    _reuseEndpoint: { hostname: "10.0.0.1", port: 22, username: "alice" },
  };
  sessions.set("src", source);

  assert.equal(
    findReusableSession(sessions, "src", { hostname: "10.0.0.1", port: 22, username: "alice" }),
    source,
  );
  assert.equal(
    findReusableSession(sessions, "src", { hostname: "10.0.0.1", username: "alice" }),
    source,
  );
  assert.equal(findReusableSession(sessions, "src", { hostname: "10.0.0.2", port: 22, username: "alice" }), null);
  assert.equal(findReusableSession(sessions, "src", { hostname: "10.0.0.1", port: 2222, username: "alice" }), null);
  assert.equal(findReusableSession(sessions, "src", { hostname: "10.0.0.1", port: 22, username: "bob" }), null);

  sessions.set("root-src", {
    conn: { _sock: { destroyed: false } },
    stream: {},
    connRef: { count: 1, state: "live" },
    _reuseEndpoint: { hostname: "10.0.0.9", port: 22, username: "root" },
  });
  assert.ok(findReusableSession(sessions, "root-src", { hostname: "10.0.0.9" }));
});

test("findReusableSession refuses reuse when the source has no recorded endpoint", () => {
  const sessions = new Map();
  sessions.set("src", {
    conn: { _sock: { destroyed: false } },
    stream: {},
    connRef: { count: 1, state: "live" },
  });
  assert.equal(findReusableSession(sessions, "src", { hostname: "10.0.0.1" }), null);
  assert.ok(findReusableSession(sessions, "src"));
});

// ---------------------------------------------------------------------------
// Transport registry + idle park
// ---------------------------------------------------------------------------

test("default idle TTL constant is 5 minutes", () => {
  assert.equal(DEFAULT_SSH_TRANSPORT_IDLE_TTL_MS, 5 * 60_000);
  assert.equal(DEFAULT_MAX_IDLE_SSH_TRANSPORTS, 128);
});

test("TTL-zero idle pool enforces a hard global limit without ending active transports", () => {
  resetSshTransportRegistryForTests({
    defaultIdleTtlMs: 0,
    maxIdleTransports: 3,
  });

  const activeConn = makeConn();
  const active = createTransport({
    conn: activeConn,
    endpoint: { hostname: "active.example", username: "root" },
  });
  borrowTransport(active, { holder: {} });

  const parked = [];
  for (let index = 0; index < 5; index += 1) {
    const conn = makeConn();
    const holder = {};
    const transport = createTransport({
      conn,
      endpoint: { hostname: `idle-${index}.example`, username: "root" },
    });
    borrowTransport(transport, { holder });
    returnTransport(holder);
    parked.push({ conn, transport });
  }

  assert.deepEqual(getTransportStats(), {
    transports: 4,
    pendingDials: 0,
    live: 1,
    idle: 3,
    leases: 1,
    defaultIdleTtlMs: 0,
  });
  assert.equal(active.state, "live");
  assert.equal(activeConn.ended, 0, "a leased transport must never be evicted");
  assert.deepEqual(parked.map(({ conn }) => conn.ended), [1, 1, 0, 0, 0]);
  assert.deepEqual(parked.map(({ transport }) => transport.state), [
    "dead",
    "dead",
    "idle",
    "idle",
    "idle",
  ]);
});

test("idle endpoint hits refresh LRU order before the next eviction", () => {
  resetSshTransportRegistryForTests({
    defaultIdleTtlMs: 0,
    maxIdleTransports: 2,
  });

  const park = (hostname) => {
    const endpoint = { hostname, username: "root" };
    const conn = makeConn();
    const holder = {};
    const transport = createTransport({ conn, endpoint });
    borrowTransport(transport, { holder });
    returnTransport(holder);
    return { conn, endpoint, transport };
  };

  const first = park("first.example");
  const second = park("second.example");
  assert.equal(findTransportByEndpoint(first.endpoint), first.transport);
  const third = park("third.example");

  assert.equal(first.conn.ended, 0);
  assert.equal(second.conn.ended, 1, "the untouched oldest idle transport is evicted");
  assert.equal(third.conn.ended, 0);
  assert.equal(findTransportByEndpoint(first.endpoint), first.transport);
  assert.equal(findTransportByEndpoint(second.endpoint), null);
  assert.equal(findTransportByEndpoint(third.endpoint), third.transport);
});

test("borrow and return make a previously idle transport the newest LRU entry", () => {
  resetSshTransportRegistryForTests({
    defaultIdleTtlMs: 0,
    maxIdleTransports: 2,
  });

  const park = (hostname) => {
    const conn = makeConn();
    const holder = {};
    const transport = createTransport({
      conn,
      endpoint: { hostname, username: "root" },
    });
    borrowTransport(transport, { holder });
    returnTransport(holder);
    return { conn, transport };
  };

  const first = park("first.example");
  const second = park("second.example");
  const borrowed = {};
  borrowTransport(first.transport, { holder: borrowed });
  const third = park("third.example");

  assert.equal(second.conn.ended, 0, "capacity ignores the active borrowed transport");
  returnTransport(borrowed);

  assert.equal(first.conn.ended, 0);
  assert.equal(second.conn.ended, 1, "returning the borrowed transport evicts the oldest idle one");
  assert.equal(third.conn.ended, 0);
  assert.equal(first.transport.state, "idle");
});

test("buildEndpointKey normalizes port and username defaults", () => {
  assert.equal(
    buildEndpointKey({ hostname: "a.example", port: 22, username: "root" }),
    buildEndpointKey({ hostname: "a.example" }),
  );
  assert.notEqual(
    buildEndpointKey({ hostname: "a.example", username: "alice" }),
    buildEndpointKey({ hostname: "a.example", username: "bob" }),
  );
  assert.notEqual(
    buildEndpointKey({ hostname: "a.example", jumpFingerprint: "bastion" }),
    buildEndpointKey({ hostname: "a.example", jumpFingerprint: "other" }),
  );
});

test("buildEndpointKey distinguishes jump host chains", () => {
  assert.notEqual(
    buildEndpointKey({
      hostname: "target",
      jumpHosts: [{ hostname: "bastion-a", port: 22, username: "j" }],
    }),
    buildEndpointKey({
      hostname: "target",
      jumpHosts: [{ hostname: "bastion-b", port: 22, username: "j" }],
    }),
  );
});

test("buildEndpointKey scopes vault hostId so different profiles never share", () => {
  assert.notEqual(
    buildEndpointKey({ hostId: "host-a", hostname: "same.example", username: "root" }),
    buildEndpointKey({ hostId: "host-b", hostname: "same.example", username: "root" }),
  );
  // Missing hostId still indexes under a distinct profile slot ("-").
  assert.notEqual(
    buildEndpointKey({ hostname: "same.example", username: "root" }),
    buildEndpointKey({ hostId: "host-a", hostname: "same.example", username: "root" }),
  );
});

test("fingerprintAuth changes when credential material rotates under same keyId", () => {
  const keyBase = {
    hostname: "h.example",
    username: "alice",
    authType: "key",
    keyId: "key-1",
  };
  assert.notEqual(
    fingerprintAuth({ ...keyBase, privateKey: "-----BEGIN OLD-----" }),
    fingerprintAuth({ ...keyBase, privateKey: "-----BEGIN NEW-----" }),
  );
  assert.notEqual(
    fingerprintAuth({ authType: "password", password: "secret-a" }),
    fingerprintAuth({ authType: "password", password: "secret-b" }),
  );
  assert.notEqual(
    fingerprintAuth({ authType: "certificate", certificate: "old-cert", privateKey: "k" }),
    fingerprintAuth({ authType: "certificate", certificate: "new-cert", privateKey: "k" }),
  );
  // Same material is stable.
  assert.equal(
    fingerprintAuth({ ...keyBase, privateKey: "same" }),
    fingerprintAuth({ ...keyBase, privateKey: "same" }),
  );
  // Automatic auth fingerprints every credential that may be selected. This
  // remains stable for an unchanged key/password policy and invalidates when
  // either the key or its fallback password rotates.
  const autoWithPub = {
    authType: "auto",
    keyId: "k1",
    publicKey: "ssh-ed25519 AAAA",
    privateKey: "-----BEGIN-----",
    password: "pw",
  };
  assert.equal(
    fingerprintAuth(autoWithPub),
    fingerprintAuth({ ...autoWithPub }),
  );
  assert.notEqual(
    fingerprintAuth(autoWithPub),
    fingerprintAuth({ ...autoWithPub, password: "rotated-password" }),
  );
  // password-only auto: password rotation invalidates.
  assert.notEqual(
    fingerprintAuth({ authType: "auto", password: "old" }),
    fingerprintAuth({ authType: "auto", password: "new" }),
  );
});

test("forwarding socket changes invalidate shell reuse without blocking channel reuse", () => {
  const base = {
    hostname: "h.example",
    username: "alice",
    authType: "password",
    password: "secret",
    agentForwarding: true,
  };
  const apple = { ...base, forwardingAgentSocket: "/tmp/apple-agent.sock" };
  const bitwarden = {
    ...base,
    forwardingAgentSocket: "/Users/alice/.bitwarden-ssh-agent.sock",
  };
  assert.equal(
    fingerprintAuth(apple),
    fingerprintAuth(bitwarden),
  );
  assert.equal(buildEndpointKey(apple), buildEndpointKey(bitwarden));
  assert.equal(endpointAllowsReuse(bitwarden, apple, "shell"), false);
  assert.equal(endpointAllowsReuse(
    { ...base, agentForwarding: false },
    apple,
    "channel",
  ), true);

  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  const transport = createTransport({ conn: makeConn(), endpoint: apple });
  assert.equal(
    findTransportByEndpoint({ ...base, agentForwarding: false }),
    transport,
  );
  assert.equal(findTransportByEndpoint(bitwarden, { kind: "shell" }), null);
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
});

test("automatic key success reuses an unchanged endpoint without exposing credentials", () => {
  const endpoint = buildConnectionReuseEndpoint({
    hostId: "auto-key-profile",
    hostname: "auto-key.example",
    username: "alice",
    authMethod: "auto",
    privateKey: "private-key-secret",
    publicKey: "ssh-ed25519 public-key-material",
    password: "unused-fallback-secret",
  });
  const endpointKey = buildEndpointKey(endpoint);
  const transport = createTransport({ conn: makeConn(), endpoint });

  assert.equal(findTransportByEndpoint({ ...endpoint }), transport);
  assert.equal(beginTransportDial({ ...endpoint }, { kind: "shell" }).role, "reuse");
  for (const secret of ["private-key-secret", "public-key-material", "unused-fallback-secret"]) {
    assert.equal(endpointKey.includes(secret), false);
  }
});

test("TTL-zero automatic password fallback is not reused after password rotation", () => {
  const firstEndpoint = buildConnectionReuseEndpoint({
    hostId: "auto-fallback-profile",
    hostname: "auto-fallback.example",
    username: "alice",
    authMethod: "auto",
    privateKey: "rejected-private-key",
    password: "accepted-password-v1",
  });
  const rotatedEndpoint = buildConnectionReuseEndpoint({
    hostId: "auto-fallback-profile",
    hostname: "auto-fallback.example",
    username: "alice",
    authMethod: "auto",
    privateKey: "rejected-private-key",
    password: "accepted-password-v2",
  });
  const conn = makeConn();
  const holder = {};
  const transport = createTransport({ conn, endpoint: firstEndpoint });
  borrowTransport(transport, { kind: "shell", holder });
  returnTransport(holder);

  assert.equal(transport.state, "idle");
  assert.equal(conn.ended, 0, "TTL zero intentionally keeps the old transport parked");
  assert.equal(findTransportByEndpoint(firstEndpoint), transport);
  assert.equal(findTransportByEndpoint(rotatedEndpoint), null);
  assert.equal(beginTransportDial(rotatedEndpoint, { kind: "shell" }).role, "leader");
});

test("endpoint key securely covers jump, proxy, agent, and SSH security policy", () => {
  const base = buildConnectionReuseEndpoint({
    hostId: "target-id",
    hostname: "target.example",
    username: "alice",
    authMethod: "key",
    privateKey: "target-private-key",
    passphrase: "target-passphrase",
    useSshAgent: true,
    identityAgent: "/run/user/1000/agent-a.sock",
    identitiesOnly: true,
    agentPublicKeys: ["ssh-ed25519 TARGET-A"],
    verifyHostKeys: true,
    legacyAlgorithms: false,
    skipEcdsaHostKey: false,
    algorithmOverrides: { kex: ["curve25519-sha256"] },
    proxy: {
      type: "socks5",
      host: "proxy.example",
      port: 1080,
      identityId: "proxy-identity-a",
      username: "proxy-user",
      password: "proxy-secret-a",
    },
    jumpHosts: [{
      hostId: "jump-id",
      hostname: "jump.example",
      username: "jump-user",
      authMethod: "password",
      password: "jump-secret-a",
      requiresMfa: true,
      verifyHostKeys: true,
      legacyAlgorithms: false,
      skipEcdsaHostKey: false,
      algorithmOverrides: { serverHostKey: ["ssh-ed25519"] },
      proxy: {
        type: "http",
        host: "jump-proxy.example",
        port: 8080,
        username: "jump-proxy-user",
        password: "jump-proxy-secret-a",
      },
    }],
  });
  const baseKey = buildEndpointKey(base);
  const variants = [
    { ...base, identityAgent: "/run/user/1000/agent-b.sock" },
    { ...base, identitiesOnly: false },
    { ...base, agentPublicKeys: ["ssh-ed25519 TARGET-B"] },
    { ...base, verifyHostKeys: false },
    { ...base, algorithmOverrides: { kex: ["diffie-hellman-group14-sha256"] } },
    { ...base, proxy: { ...base.proxy, password: "proxy-secret-b" } },
    { ...base, proxy: { ...base.proxy, identityId: "proxy-identity-b" } },
    { ...base, jumpHosts: [{ ...base.jumpHosts[0], password: "jump-secret-b" }] },
    { ...base, jumpHosts: [{ ...base.jumpHosts[0], verifyHostKeys: false }] },
    { ...base, jumpHosts: [{
      ...base.jumpHosts[0],
      proxy: { ...base.jumpHosts[0].proxy, password: "jump-proxy-secret-b" },
    }] },
  ];

  for (const variant of variants) {
    assert.notEqual(buildEndpointKey(variant), baseKey);
  }
  for (const secret of [
    "target-private-key",
    "target-passphrase",
    "proxy-secret-a",
    "jump-secret-a",
    "jump-proxy-secret-a",
  ]) {
    assert.equal(baseKey.includes(secret), false, `endpoint key must not expose ${secret}`);
  }
});

test("endpoint key changes when known-host trust content changes", () => {
  const base = {
    hostId: "known-host-profile",
    hostname: "known-host.example",
    port: 22,
    username: "alice",
    authMethod: "password",
    password: "secret",
    verifyHostKeys: true,
  };
  const first = buildEndpointKey(buildConnectionReuseEndpoint({
    ...base,
    knownHosts: [{ hostname: "known-host.example", port: 22, publicKey: "ssh-ed25519 AAAA_FIRST" }],
  }));
  const rotated = buildEndpointKey(buildConnectionReuseEndpoint({
    ...base,
    knownHosts: [{ hostname: "known-host.example", port: 22, publicKey: "ssh-ed25519 AAAA_ROTATED" }],
  }));

  assert.notEqual(rotated, first);

  const jumpFirst = buildEndpointKey(buildConnectionReuseEndpoint({
    ...base,
    jumpHosts: [{ hostname: "bastion.example", port: 2222 }],
    knownHosts: [{
      hostname: "[bastion.example]:2222",
      port: 2222,
      publicKey: "ssh-ed25519 AAAA_JUMP_FIRST",
    }],
  }));
  const jumpRotatedEndpoint = buildConnectionReuseEndpoint({
    ...base,
    jumpHosts: [{ hostname: "bastion.example", port: 2222 }],
    knownHosts: [{
      hostname: "[bastion.example]:2222",
      port: 2222,
      publicKey: "ssh-ed25519 AAAA_JUMP_ROTATED",
    }],
  });
  assert.notEqual(buildEndpointKey(jumpRotatedEndpoint), jumpFirst);
  assert.equal(
    JSON.stringify(normalizeEndpoint(jumpRotatedEndpoint)).includes("AAAA_JUMP_ROTATED"),
    false,
  );
});

test("endpoint key changes when an identity file changes in place", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-pool-key-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const identityPath = path.join(dir, "id_ed25519");
  fs.writeFileSync(identityPath, "first-private-key");
  const endpoint = buildConnectionReuseEndpoint({
    hostname: "identity-file.example",
    username: "alice",
    authMethod: "key",
    identityFilePaths: [identityPath],
  });
  const first = buildEndpointKey(endpoint);

  fs.writeFileSync(identityPath, "rotated-private-key");
  const second = buildEndpointKey(endpoint);
  assert.notEqual(second, first);
  assert.equal(first.includes("first-private-key"), false);
  assert.equal(second.includes("rotated-private-key"), false);
});

test("auto-auth endpoint changes when the inline private key rotates", () => {
  const base = {
    hostId: "inline-key-profile",
    hostname: "inline-key.example",
    username: "alice",
    authMethod: "auto",
    publicKey: "stale-public-key-metadata",
  };
  const first = buildEndpointKey(buildConnectionReuseEndpoint({
    ...base,
    privateKey: "first-private-key",
  }));
  const rotated = buildEndpointKey(buildConnectionReuseEndpoint({
    ...base,
    privateKey: "rotated-private-key",
  }));

  assert.notEqual(rotated, first);
  assert.equal(first.includes("first-private-key"), false);
  assert.equal(rotated.includes("rotated-private-key"), false);
});

test("Terminal and SFTP aliases build the same reuse endpoint semantics", () => {
  const options = {
    hostId: "shared-profile",
    hostname: "shared.example",
    username: "alice",
    authMethod: "certificate",
    keyId: "key-1",
    privateKey: "private",
    publicKey: "public",
    certificate: "certificate",
    passphrase: "passphrase",
    identityFilePaths: ["/keys/id"],
    useSshAgent: true,
    identityAgent: "SSH_AUTH_SOCK",
    identitiesOnly: true,
    addKeysToAgent: "confirm",
    useKeychain: true,
    agentPublicKeys: ["ssh-ed25519 SELECTED"],
    verifyHostKeys: true,
    legacyAlgorithms: true,
    skipEcdsaHostKey: true,
    algorithmOverrides: { hmac: ["hmac-sha2-256"] },
    jumpHosts: [{ hostname: "jump", password: "jump-password" }],
    proxy: { type: "http", host: "proxy", port: 8080, password: "proxy-password" },
  };
  assert.equal(
    buildEndpointKey(buildConnectionReuseEndpoint(options)),
    buildEndpointKey(buildConnectionReuseEndpoint({
      ...options,
      authType: options.authMethod,
      authMethod: undefined,
    })),
  );
});

test("connection reuse identity changes with the effective keepalive policy", () => {
  const base = { hostname: "keepalive.example", username: "root", port: 22 };
  const enabled = buildConnectionReuseEndpoint({
    ...base,
    keepaliveInterval: 30,
    keepaliveCountMax: 10,
  });
  const disabled = buildConnectionReuseEndpoint({
    ...base,
    keepaliveInterval: 0,
    keepaliveCountMax: 0,
  });

  assert.notEqual(buildEndpointKey(enabled), buildEndpointKey(disabled));
  assert.equal(endpointAllowsReuse(enabled, disabled, "shell"), false);
});

test("connection endpoint can record negotiated agent forwarding instead of the request", () => {
  const endpoint = buildConnectionReuseEndpoint(
    { hostname: "agent.example", username: "root", agentForwarding: true },
    { agentForwarding: false },
  );
  assert.equal(normalizeEndpoint(endpoint).agentForwarding, false);
});

test("channel reuse can borrow a normal SSH transport for sudo SFTP", () => {
  const base = { hostname: "sudo.example", username: "root", port: 22 };
  const normalShell = buildConnectionReuseEndpoint(base, { sftpSudo: false });
  const sudoSftp = buildConnectionReuseEndpoint(base, { sftpSudo: true });

  assert.notEqual(buildEndpointKey(normalShell), buildEndpointKey(sudoSftp));
  assert.equal(endpointAllowsReuse(sudoSftp, normalShell, "channel"), true);
  assert.equal(endpointAllowsReuse(sudoSftp, normalShell, "shell"), false);
});

test("endpointAllowsReuse: shell exact vs channel asymmetric for agentForwarding", () => {
  const base = { hostname: "a.example", username: "root", port: 22 };
  // Channel (default): request needs ForwardAgent, existing never enabled it -> reject.
  assert.equal(
    endpointAllowsReuse({ ...base, agentForwarding: true }, { ...base, agentForwarding: false }),
    false,
  );
  // Channel: request does not need ForwardAgent; existing with it is fine (SFTP/PF).
  assert.equal(
    endpointAllowsReuse({ ...base, agentForwarding: false }, { ...base, agentForwarding: true }),
    true,
  );
  // Shell: disabling ForwardAgent must not reattach to a warm agent-forward conn.
  assert.equal(
    endpointAllowsReuse(
      { ...base, agentForwarding: false },
      { ...base, agentForwarding: true },
      "shell",
    ),
    false,
  );
  assert.equal(
    endpointAllowsReuse(
      { ...base, agentForwarding: true },
      { ...base, agentForwarding: true },
      "shell",
    ),
    true,
  );
  // agentForwarding does not change the shared endpoint key (park index stays stable).
  assert.equal(
    buildEndpointKey({ ...base, agentForwarding: true }),
    buildEndpointKey({ ...base, agentForwarding: false }),
  );
});

test("findTransportByEndpoint shell kind refuses mismatched agentForwarding", () => {
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  const holder = { id: "s1" };
  const withFwd = createTransport({
    conn: makeConn(),
    endpoint: { hostname: "fwd.example", username: "root", agentForwarding: true },
  });
  borrowTransport(withFwd, { kind: "shell", holder, leaseId: "shell:s1" });
  returnTransport(holder); // park idle forever

  // Shell open after user disables ForwardAgent must not reuse.
  assert.equal(
    findTransportByEndpoint(
      { hostname: "fwd.example", username: "root", agentForwarding: false },
      { kind: "shell" },
    ),
    null,
  );
  // SFTP/PF channel reuse may still borrow the ForwardAgent transport.
  assert.ok(
    findTransportByEndpoint({ hostname: "fwd.example", username: "root", agentForwarding: false }),
  );
  assert.ok(
    findTransportByEndpoint(
      { hostname: "fwd.example", username: "root", agentForwarding: true },
      { kind: "shell" },
    ),
  );
  discardTransport(withFwd);
});

test("last return parks with positive TTL then ends when timer fires", () => {
  const timers = useShortTtlTimers(60_000);

  const conn = makeConn();
  const holder = { id: "shell-1" };
  const transport = createTransport({
    conn,
    endpoint: { hostname: "10.0.0.1", username: "alice" },
  });
  borrowTransport(transport, { kind: LEASE_KINDS.shell, holder });

  const result = returnTransport(holder);
  assert.equal(result.released, true);
  assert.equal(result.ended, false);
  assert.equal(result.idle, true);
  assert.equal(conn.ended, 0);
  assert.equal(transport.state, "idle");
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 60_000);

  timers[0].fn();
  assert.equal(conn.ended, 1);
  assert.equal(transport.state, "dead");
});

test("idle reclaim timer does not keep the app process alive", () => {
  let unrefCalls = 0;
  resetSshTransportRegistryForTests({
    defaultIdleTtlMs: 60_000,
    setTimeout: () => ({
      unref() { unrefCalls += 1; },
    }),
    clearTimeout: () => {},
  });
  const transport = createTransport({ conn: makeConn() });
  const holder = {};
  borrowTransport(transport, { holder });

  returnTransport(holder);

  assert.equal(unrefCalls, 1);
});

test("TTL 0 parks forever without scheduling a timer", () => {
  const timers = [];
  resetSshTransportRegistryForTests({
    defaultIdleTtlMs: 0,
    setTimeout: (fn, ms) => {
      const handle = { fn, ms, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      if (handle) handle.cleared = true;
    },
  });

  const conn = makeConn();
  const transport = createTransport({ conn, endpoint: { hostname: "forever.example" } });
  const holder = {};
  borrowTransport(transport, { holder });
  const result = returnTransport(holder);
  assert.equal(result.idle, true);
  assert.equal(result.ended, false);
  assert.equal(timers.length, 0, "never-reclaim must not schedule idle end");
  assert.equal(conn.ended, 0);
  assert.equal(transport.state, "idle");
  assert.ok(findTransportByEndpoint({ hostname: "forever.example" }));
});

test("borrow while idle cancels park and reuses the same conn", () => {
  const timers = useShortTtlTimers(60_000);

  const conn = makeConn();
  const endpoint = { hostname: "10.0.0.2", port: 22, username: "root" };
  const transport = createTransport({ conn, endpoint });
  const first = {};
  borrowTransport(transport, { kind: LEASE_KINDS.shell, holder: first });
  returnTransport(first);
  assert.equal(transport.state, "idle");
  assert.equal(timers[0].cleared, false);

  const found = findTransportByEndpoint(endpoint);
  assert.equal(found, transport);

  const second = {};
  borrowTransport(found, { kind: LEASE_KINDS.sftp, holder: second, leaseId: "sftp:panel-1" });
  assert.equal(transport.state, "live");
  assert.equal(timers[0].cleared, true);
  assert.equal(conn.ended, 0);
  assert.equal(transport.count, 1);
  assert.equal(second.connRef, transport);
});

test("findTransportByEndpoint prefers live transport over idle", () => {
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 60_000 });
  const endpoint = { hostname: "shared.example", username: "u" };

  const idleConn = makeConn();
  const idleTransport = createTransport({ conn: idleConn, endpoint });
  const idleHolder = {};
  borrowTransport(idleTransport, { holder: idleHolder });
  returnTransport(idleHolder);
  assert.equal(idleTransport.state, "idle");

  const liveConn = makeConn();
  const liveTransport = createTransport({ conn: liveConn, endpoint });
  borrowTransport(liveTransport, { holder: {} });

  assert.equal(findTransportByEndpoint(endpoint), liveTransport);
});

test("sftp and shell leases share one transport until both return", () => {
  const timers = useShortTtlTimers(1);
  const conn = makeConn();
  const session = { id: "term-1", _reuseEndpoint: { hostname: "h", port: 22, username: "root" } };
  const transport = createConnectionRef(session, conn, []);
  const sftpHolder = { id: "sftp-1", __sshLeaseKind: LEASE_KINDS.sftp };
  acquireConnectionRef(sftpHolder, transport);
  assert.equal(transport.count, 2);

  assert.equal(releaseConnectionRef(session), false);
  assert.equal(conn.ended, 0);
  assert.equal(releaseConnectionRef(sftpHolder), false);
  assert.equal(transport.state, "idle");
  fireIdleTimers(timers);
  assert.equal(conn.ended, 1);
});

test("resolveTransportForReuse finds idle transport by endpoint without a session", () => {
  const timers = useShortTtlTimers(30_000);

  const conn = makeConn();
  const endpoint = { hostname: "parked.example", username: "ops" };
  const transport = createTransport({ conn, endpoint });
  const holder = {};
  borrowTransport(transport, { holder });
  returnTransport(holder);

  const resolved = resolveTransportForReuse({ endpoint });
  assert.equal(resolved, transport);
  assert.equal(resolved.state, "idle");
  assert.ok(timers.length >= 1);
});

test("findTransportByEndpoint ends transports whose socket is destroyed", () => {
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  const endpoint = { hostId: "h1", hostname: "dead.example", username: "root" };
  const conn = makeConn();
  const transport = createTransport({ conn, endpoint });
  const holder = {};
  borrowTransport(transport, { holder });
  returnTransport(holder);
  assert.equal(transport.state, "idle");
  conn._sock.destroyed = true;
  assert.equal(findTransportByEndpoint(endpoint), null);
  assert.equal(conn.ended, 1);
  assert.equal(getTransportStats().transports, 0);
});

test("discardTransport force-ends and unregisters", () => {
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 60_000 });
  const conn = makeConn();
  const endpoint = { hostname: "x.example" };
  const transport = createTransport({ conn, endpoint });
  borrowTransport(transport, { holder: {} });

  assert.equal(discardTransport(transport), true);
  assert.equal(conn.ended, 1);
  assert.equal(findTransportByEndpoint(endpoint), null);
  assert.equal(getTransportStats().transports, 0);
});

test("discardAllTransports clears the registry", () => {
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 60_000 });
  const a = createTransport({ conn: makeConn(), endpoint: { hostname: "a" } });
  const b = createTransport({ conn: makeConn(), endpoint: { hostname: "b" } });
  borrowTransport(a, { holder: {} });
  borrowTransport(b, { holder: {} });
  assert.equal(discardAllTransports(), 2);
  assert.equal(getTransportStats().transports, 0);
});

test("active transport error unregisters leases and closes its jump chain once", () => {
  useParkForever();
  const conn = makeLifecycleConn({ emitCloseFromEnd: true });
  const chain = makeChainConn();
  const holder = {};
  const transport = createTransport({
    conn,
    chainConnections: [chain],
    endpoint: { hostname: "active-error.example", username: "alice" },
  });
  borrowTransport(transport, { holder, kind: "sftp" });

  conn.emit("error", new Error("remote transport failed"));

  assert.equal(getTransportStats().transports, 0);
  assert.equal(getTransportStats().leases, 0);
  assert.equal(holder.connRef, null);
  assert.equal(holder._sshTransportLeaseId, null);
  assert.equal(conn.ended, 1);
  assert.equal(chain.ended, 1);
  assert.equal(transport.state, "dead");
});

test("remote close unregisters a TTL-zero idle transport and its jump chain once", () => {
  useParkForever();
  const conn = makeLifecycleConn();
  const chain = makeChainConn();
  const holder = {};
  const transport = createTransport({
    conn,
    chainConnections: [chain],
    endpoint: { hostname: "idle-close.example", username: "alice" },
  });
  borrowTransport(transport, { holder, kind: "shell" });
  returnTransport(holder);
  assert.equal(getTransportStats().idle, 1);

  conn._sock.destroyed = true;
  conn.emit("close");
  conn.emit("close");

  assert.equal(getTransportStats().transports, 0);
  assert.equal(getTransportStats().idle, 0);
  assert.equal(conn.ended, 0, "a remote close must not call end on the closed socket again");
  assert.equal(chain.ended, 1);
  assert.equal(transport.state, "dead");
});

test("setDefaultTransportIdleTtlMs updates default and reschedules idle transports", () => {
  const timers = [];
  let now = 10_000;
  resetSshTransportRegistryForTests({
    defaultIdleTtlMs: 60_000,
    now: () => now,
    setTimeout: (fn, ms) => {
      const handle = { fn, ms, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      if (handle) handle.cleared = true;
    },
  });

  const conn = makeConn();
  const transport = createTransport({ conn, endpoint: { hostname: "resched.example" } });
  const holder = {};
  borrowTransport(transport, { holder });
  returnTransport(holder);
  assert.equal(transport.state, "idle");
  assert.equal(timers[0].ms, 60_000);

  now += 250;
  setDefaultTransportIdleTtlMs(5_000);
  assert.equal(getDefaultTransportIdleTtlMs(), 5_000);
  assert.equal(timers[0].cleared, true, "old idle timer must be cancelled");
  const last = timers[timers.length - 1];
  assert.equal(last.ms, 4_750, "reschedule must preserve elapsed idle time");
  assert.equal(transport.idleTtlMs, 5_000);
});

test("createConnectionRef indexes endpoint from session._reuseEndpoint including jumpHosts and hostId", () => {
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 60_000 });
  const conn = makeConn();
  const session = {
    id: "s1",
    _reuseEndpoint: {
      hostId: "vault-host-1",
      hostname: "indexed.example",
      port: 2222,
      username: "deploy",
      jumpHosts: [{ hostname: "bastion", port: 22, username: "jump" }],
    },
  };
  createConnectionRef(session, conn, []);
  const found = findTransportByEndpoint({
    hostId: "vault-host-1",
    hostname: "indexed.example",
    port: 2222,
    username: "deploy",
    jumpHosts: [{ hostname: "bastion", port: 22, username: "jump" }],
  });
  assert.ok(found);
  assert.equal(found.conn, conn);
  assert.equal(
    findTransportByEndpoint({
      hostId: "vault-host-1",
      hostname: "indexed.example",
      port: 2222,
      username: "deploy",
    }),
    null,
    "missing jump chain must not match",
  );
  assert.equal(
    findTransportByEndpoint({
      hostId: "other-host",
      hostname: "indexed.example",
      port: 2222,
      username: "deploy",
      jumpHosts: [{ hostname: "bastion", port: 22, username: "jump" }],
    }),
    null,
    "different vault hostId must not match",
  );
});

test("borrowTransport rejects bare non-registry connRef objects", () => {
  const bare = { count: 1, conn: makeConn(), chainConnections: [] };
  assert.throws(
    () => acquireConnectionRef({ id: "x" }, bare),
    /not a registry transport/,
  );
});

test("transferConnectionRef rebinds a lease without changing count", () => {
  const timers = useShortTtlTimers(1);
  const conn = makeConn();
  const transport = createTransport({ conn, endpoint: { hostname: "t.example" } });
  const temp = {};
  const session = { id: "shell-copy" };
  borrowTransport(transport, { kind: LEASE_KINDS.shell, holder: temp });
  assert.equal(transport.count, 1);

  assert.equal(transferConnectionRef(temp, session), true);
  assert.equal(transport.count, 1);
  assert.equal(temp.connRef, null);
  assert.equal(session.connRef, transport);
  assert.ok(session._sshTransportLeaseId);

  assert.equal(releaseConnectionRef(session), false);
  assert.equal(transport.state, "idle");
  fireIdleTimers(timers);
  assert.equal(conn.ended, 1);
});
