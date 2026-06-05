const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { createMoshStatsConnectionApi } = require("./moshStatsConnection.cjs");

// The connection is created inside an async flow (after credentials are
// resolved, which may touch the filesystem), so the fake SSH client appears a
// few microtasks/immediates after ensureMoshStatsConnection() is called.
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Minimal fake ssh2 Client. Records connect() opts and lets the test drive
// the lifecycle via emitReady / emitError.
class FakeSSHClient extends EventEmitter {
  constructor() {
    super();
    FakeSSHClient.instances.push(this);
    this.connectOpts = null;
    this.ended = false;
  }

  connect(opts) {
    this.connectOpts = opts;
    return this;
  }

  end() {
    this.ended = true;
  }

  emitReady() {
    this.emit("ready");
  }

  emitError(err) {
    this.emit("error", err);
  }
}
FakeSSHClient.instances = [];

function makeApi(overrides = {}) {
  FakeSSHClient.instances = [];
  const sessions = overrides.sessions || new Map();
  const logs = [];
  const api = createMoshStatsConnectionApi({
    get sessions() {
      return sessions;
    },
    SSHClient: overrides.SSHClient || FakeSSHClient,
    sshUtils: overrides.sshUtils || {
      // Default: treat any non-empty string as a parseable key.
      parseKey: (key) => (key && key.length > 0 ? { ok: true } : new Error("bad key")),
    },
    NetcattyAgent: overrides.NetcattyAgent || class {},
    buildAlgorithms: overrides.buildAlgorithms || (() => ({ algos: true })),
    getSshAgentSocket: overrides.getSshAgentSocket || (() => null),
    readFileNoFollow: overrides.readFileNoFollow || (async () => null),
    expandIdentityFilePath: overrides.expandIdentityFilePath || ((p) => p),
    isAutoFillablePasswordChallenge:
      overrides.isAutoFillablePasswordChallenge || (() => false),
    hostKeyVerifier: overrides.hostKeyVerifier || {
      // Default: classify everything as trusted so password tests connect.
      describeHostKey: () => ({ keyType: "ssh-ed25519", fingerprint: "fp" }),
      classifyHostKey: () => ({ status: "trusted" }),
    },
    // Default: the system known_hosts vouches for nothing, so trust comes
    // solely from the Netcatty classifier above. Individual tests override this
    // to exercise the system-known_hosts fallback.
    isHostKeyTrustedBySystem:
      "isHostKeyTrustedBySystem" in overrides
        ? overrides.isHostKeyTrustedBySystem
        : () => false,
    log: (...args) => logs.push(args),
  });
  return { api, sessions, logs };
}

test("reuses an already-established companion (moshStatsConn) without reconnecting", async () => {
  const existing = { exec() {} };
  const { api } = makeApi();
  const session = { moshStatsConn: existing, moshStatsAuth: { hostname: "h", password: "p" } };

  const result = await api.ensureMoshStatsConnection(session, "sid");

  assert.equal(result, existing);
  assert.equal(FakeSSHClient.instances.length, 0);
});

test("gives up (no connection) when there is no usable non-interactive auth", async () => {
  const { api } = makeApi();
  // Only an interactively-typed password would have worked; nothing stored.
  const session = { moshStatsAuth: { hostname: "h", username: "u" } };

  const result = await api.ensureMoshStatsConnection(session, "sid");

  assert.equal(result, null);
  assert.equal(session.moshStatsConnFailed, true);
  assert.equal(FakeSSHClient.instances.length, 0);
});

test("missing moshStatsAuth is transient (handshake not yet swapped), not a permanent failure", async () => {
  const { api, sessions } = makeApi();
  // Session is connected (renderer polls) but the handshake hasn't swapped to
  // mosh-client yet, so moshStatsAuth is not assigned.
  const session = {};
  sessions.set("sid", session);

  const result = await api.ensureMoshStatsConnection(session, "sid");

  assert.equal(result, null);
  // Must NOT be permanently disabled — a later poll (after the swap sets
  // moshStatsAuth) has to be able to establish the companion.
  assert.notEqual(session.moshStatsConnFailed, true);
  assert.equal(FakeSSHClient.instances.length, 0);

  // Once auth becomes available, a subsequent poll connects.
  session.moshStatsAuth = { hostname: "h", username: "u", password: "p" };
  api.ensureMoshStatsConnection(session, "sid");
  await tick();
  assert.equal(FakeSSHClient.instances.length, 1);
});

test("connects with a stored password and adopts the connection on ready", async () => {
  const { api, sessions } = makeApi();
  const session = { moshStatsAuth: { hostname: "example.com", port: 2222, username: "alice", password: "secret" } };
  sessions.set("sid", session);

  const pending = api.ensureMoshStatsConnection(session, "sid");
  await tick();
  // One connection attempt with the password and host wired in.
  assert.equal(FakeSSHClient.instances.length, 1);
  const client = FakeSSHClient.instances[0];
  assert.equal(client.connectOpts.host, "example.com");
  assert.equal(client.connectOpts.port, 2222);
  assert.equal(client.connectOpts.username, "alice");
  assert.equal(client.connectOpts.password, "secret");

  client.emitReady();
  const result = await pending;

  assert.equal(result, client);
  // Stored ONLY on moshStatsConn, never on session.conn (keeps the companion
  // invisible to getSessionPwd / SFTP / MCP exec).
  assert.equal(session.moshStatsConn, client);
  assert.equal(session.conn, undefined);
});

test("ET stats companion uses ET-specific session fields", async () => {
  const { api, sessions } = makeApi();
  const session = { etStatsAuth: { hostname: "example.com", port: 2222, username: "alice", password: "secret" } };
  sessions.set("sid", session);

  const pending = api.ensureEtStatsConnection(session, "sid");
  await tick();
  assert.equal(FakeSSHClient.instances.length, 1);
  const client = FakeSSHClient.instances[0];
  assert.equal(client.connectOpts.host, "example.com");
  assert.equal(client.connectOpts.port, 2222);
  assert.equal(client.connectOpts.username, "alice");
  assert.equal(client.connectOpts.password, "secret");

  client.emitReady();
  const result = await pending;

  assert.equal(result, client);
  assert.equal(session.etStatsConn, client);
  assert.equal(session.moshStatsConn, undefined);
  assert.equal(session.conn, undefined);
});

test("ET stats companion caches permanent failures on ET-specific fields", async () => {
  const { api, sessions } = makeApi();
  const session = { etStatsAuth: { hostname: "h", username: "u", password: "p" } };
  sessions.set("sid", session);

  const p1 = api.ensureEtStatsConnection(session, "sid");
  await tick();
  const authErr = new Error("All configured authentication methods failed");
  authErr.level = "client-authentication";
  FakeSSHClient.instances[0].emitError(authErr);
  assert.equal(await p1, null);
  assert.equal(session.etStatsConnFailed, true);

  const r2 = await api.ensureEtStatsConnection(session, "sid");
  assert.equal(r2, null);
  assert.equal(FakeSSHClient.instances.length, 1);
});

test("uses a parseable private key and passphrase, not password fallback only", async () => {
  const { api, sessions } = makeApi();
  const session = {
    moshStatsAuth: {
      hostname: "h",
      username: "u",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----",
      passphrase: "pw",
    },
  };
  sessions.set("sid", session);

  api.ensureMoshStatsConnection(session, "sid");
  await tick();
  const client = FakeSSHClient.instances[0];
  assert.equal(client.connectOpts.privateKey, session.moshStatsAuth.privateKey);
  assert.equal(client.connectOpts.passphrase, "pw");
});

test("skips an unparseable (e.g. encrypted, wrong passphrase) private key", async () => {
  const { api, sessions } = makeApi({
    sshUtils: { parseKey: () => new Error("encrypted") },
  });
  const session = {
    moshStatsAuth: { hostname: "h", username: "u", privateKey: "enc", password: "fallback" },
  };
  sessions.set("sid", session);

  api.ensureMoshStatsConnection(session, "sid");
  await tick();
  const client = FakeSSHClient.instances[0];
  // Falls back to the stored password instead of offering the bad key.
  assert.equal(client.connectOpts.privateKey, undefined);
  assert.equal(client.connectOpts.password, "fallback");
});

test("reads identity files non-interactively when no inline key is present", async () => {
  const reads = [];
  const { api, sessions } = makeApi({
    readFileNoFollow: async (p) => {
      reads.push(p);
      return "FILEKEY";
    },
    sshUtils: { parseKey: (k) => (k === "FILEKEY" ? { ok: true } : new Error("no")) },
  });
  const session = {
    moshStatsAuth: { hostname: "h", username: "u", identityFilePaths: ["~/.ssh/id_ed25519"] },
  };
  sessions.set("sid", session);

  api.ensureMoshStatsConnection(session, "sid");
  await tick();
  await tick(); // allow chained async identity read + client creation

  assert.deepEqual(reads, ["~/.ssh/id_ed25519"]);
  const client = FakeSSHClient.instances[0];
  assert.equal(client.connectOpts.privateKey, "FILEKEY");
});

test("falls back to ssh-agent when a socket is available and no inline creds", async () => {
  // The system ssh used by the Mosh handshake authenticates via the local
  // agent by default, so the companion should too — regardless of the
  // agentForwarding (remote forwarding) setting.
  for (const agentForwarding of [true, false, undefined]) {
    const { api, sessions } = makeApi({
      getSshAgentSocket: () => "/tmp/agent.sock",
    });
    const session = { moshStatsAuth: { hostname: "h", username: "u", agentForwarding } };
    sessions.set("sid", session);

    api.ensureMoshStatsConnection(session, "sid");
    await tick();
    const client = FakeSSHClient.instances[0];
    assert.equal(client.connectOpts.agent, "/tmp/agent.sock");
  }
});

test("does not attempt a connection when no agent socket and no inline creds", async () => {
  const { api } = makeApi({ getSshAgentSocket: () => null });
  const session = { moshStatsAuth: { hostname: "h", username: "u" } };

  const result = await api.ensureMoshStatsConnection(session, "sid");
  assert.equal(result, null);
  assert.equal(FakeSSHClient.instances.length, 0);
});

test("enables keyboard-interactive and auto-fills the saved password for a single prompt", async () => {
  // Use the real auto-fill predicate so this exercises the actual handler.
  const { isAutoFillablePasswordChallenge } = require("../sshAuthHelper.cjs");
  const { api, sessions } = makeApi({ isAutoFillablePasswordChallenge });
  const session = { moshStatsAuth: { hostname: "h", username: "u", password: "secret" } };
  sessions.set("sid", session);

  api.ensureMoshStatsConnection(session, "sid");
  await tick();
  const client = FakeSSHClient.instances[0];
  assert.equal(client.connectOpts.tryKeyboard, true);

  let answered = null;
  client.emit(
    "keyboard-interactive",
    "",
    "",
    "",
    [{ prompt: "Password:", echo: false }],
    (responses) => { answered = responses; },
  );
  assert.deepEqual(answered, ["secret"]);
});

test("keyboard-interactive finishes empty on a 2FA / OTP challenge (no hang, no prompt)", async () => {
  const { isAutoFillablePasswordChallenge } = require("../sshAuthHelper.cjs");
  const { api, sessions } = makeApi({ isAutoFillablePasswordChallenge });
  const session = { moshStatsAuth: { hostname: "h", username: "u", password: "secret" } };
  sessions.set("sid", session);

  api.ensureMoshStatsConnection(session, "sid");
  await tick();
  const client = FakeSSHClient.instances[0];

  let answered = null;
  client.emit(
    "keyboard-interactive",
    "",
    "",
    "",
    [{ prompt: "Verification code:", echo: false }],
    (responses) => { answered = responses; },
  );
  assert.deepEqual(answered, []);
});

test("keyboard-interactive only auto-fills once, then finishes empty to avoid a loop", async () => {
  const { isAutoFillablePasswordChallenge } = require("../sshAuthHelper.cjs");
  const { api, sessions } = makeApi({ isAutoFillablePasswordChallenge });
  const session = { moshStatsAuth: { hostname: "h", username: "u", password: "secret" } };
  sessions.set("sid", session);

  api.ensureMoshStatsConnection(session, "sid");
  await tick();
  const client = FakeSSHClient.instances[0];

  const prompts = [{ prompt: "Password:", echo: false }];
  let first = null;
  let second = null;
  client.emit("keyboard-interactive", "", "", "", prompts, (r) => { first = r; });
  client.emit("keyboard-interactive", "", "", "", prompts, (r) => { second = r; });
  assert.deepEqual(first, ["secret"]);
  assert.deepEqual(second, []); // retry not re-filled with the same wrong password
});

test("does not enable keyboard-interactive when there is no password", async () => {
  const { api, sessions } = makeApi();
  const session = {
    moshStatsAuth: {
      hostname: "h",
      username: "u",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----",
    },
  };
  sessions.set("sid", session);

  api.ensureMoshStatsConnection(session, "sid");
  await tick();
  const client = FakeSSHClient.instances[0];
  assert.notEqual(client.connectOpts.tryKeyboard, true);
});

// Drive an ssh2 function-form authHandler to completion, collecting the
// method names it offers. Each call is answered by invoking the callback,
// then we ask for the next method until it yields false (exhausted).
function drainAuthHandler(authHandler) {
  const offered = [];
  let done = false;
  let guard = 0;
  while (!done && guard++ < 50) {
    let answered = false;
    authHandler([], false, (method) => {
      answered = true;
      if (method === false) {
        done = true;
      } else {
        offered.push(method);
      }
    });
    if (!answered) break;
  }
  return offered;
}

test("verifier is attached for every auth method; gated authHandler only with a password", async () => {
  // Password present -> verifier + gated authHandler attached.
  {
    const { api, sessions } = makeApi();
    const session = { moshStatsAuth: { hostname: "h", username: "u", password: "p" } };
    sessions.set("sid", session);
    api.ensureMoshStatsConnection(session, "sid");
    await tick();
    assert.equal(typeof FakeSSHClient.instances[0].connectOpts.hostVerifier, "function");
    assert.equal(typeof FakeSSHClient.instances[0].connectOpts.authHandler, "function");
  }
  // Key only -> verifier still attached (the host must be vetted); no authHandler.
  {
    const { api, sessions } = makeApi();
    const session = {
      moshStatsAuth: {
        hostname: "h",
        username: "u",
        privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----",
      },
    };
    sessions.set("sid", session);
    api.ensureMoshStatsConnection(session, "sid");
    await tick();
    assert.equal(typeof FakeSSHClient.instances[0].connectOpts.hostVerifier, "function");
    assert.equal(FakeSSHClient.instances[0].connectOpts.authHandler, undefined);
  }
  // Agent only -> verifier still attached; no authHandler.
  {
    const { api, sessions } = makeApi({ getSshAgentSocket: () => "/tmp/agent.sock" });
    const session = { moshStatsAuth: { hostname: "h", username: "u", agentForwarding: true } };
    sessions.set("sid", session);
    api.ensureMoshStatsConnection(session, "sid");
    await tick();
    assert.equal(typeof FakeSSHClient.instances[0].connectOpts.hostVerifier, "function");
    assert.equal(FakeSSHClient.instances[0].connectOpts.authHandler, undefined);
  }
});

test("the verifier rejects the transport for an untrusted host (key auth included)", async () => {
  const hostKeyVerifier = require("../hostKeyVerifier.cjs");
  const { api, sessions } = makeApi({ hostKeyVerifier });
  // Untrusted host: empty known-hosts, key auth and NO password — must still be
  // refused, even though key auth would leak no reusable secret.
  const session = {
    moshStatsAuth: {
      hostname: "unknown.example.com",
      port: 22,
      username: "u",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----",
      knownHosts: [],
    },
  };
  sessions.set("sid", session);
  api.ensureMoshStatsConnection(session, "sid");
  await tick();

  const verify = FakeSSHClient.instances[0].connectOpts.hostVerifier;
  let accepted = null;
  verify(require("node:crypto").randomBytes(32), (ok) => { accepted = ok; });
  // Refuses an unvetted host outright — no auth attempted, no stats command run.
  assert.equal(accepted, false);
});

test("the gated authHandler offers password ONLY when the host key is trusted", async () => {
  const hostKeyVerifier = require("../hostKeyVerifier.cjs");
  const rawKey = require("node:crypto").randomBytes(32);
  const { keyType, fingerprint } = hostKeyVerifier.describeHostKey(rawKey);
  const knownHosts = [
    { id: "k1", hostname: "trusted.example.com", port: 22, keyType, fingerprint, publicKey: "" },
  ];

  // Trusted host: after the verifier runs, password + keyboard-interactive
  // are offered.
  {
    const { api, sessions } = makeApi({ hostKeyVerifier });
    const session = {
      moshStatsAuth: { hostname: "trusted.example.com", port: 22, username: "u", password: "p", knownHosts },
    };
    sessions.set("sid", session);
    api.ensureMoshStatsConnection(session, "sid");
    await tick();
    const { hostVerifier, authHandler } = FakeSSHClient.instances[0].connectOpts;
    hostVerifier(rawKey, () => {}); // verifier runs during transport, sets trust
    const offered = drainAuthHandler(authHandler);
    assert.ok(offered.includes("password"));
    assert.ok(offered.includes("keyboard-interactive"));
  }

  // Untrusted host: password methods are withheld even though a password is
  // saved, so the secret is never sent.
  {
    const { api, sessions } = makeApi({ hostKeyVerifier });
    const session = {
      moshStatsAuth: { hostname: "other.example.com", port: 22, username: "u", password: "p", knownHosts },
    };
    sessions.set("sid", session);
    api.ensureMoshStatsConnection(session, "sid");
    await tick();
    const { hostVerifier, authHandler } = FakeSSHClient.instances[0].connectOpts;
    hostVerifier(rawKey, () => {});
    const offered = drainAuthHandler(authHandler);
    assert.ok(!offered.includes("password"));
    assert.ok(!offered.includes("keyboard-interactive"));
  }
});

test("an explicit private key suppresses the ssh-agent fallback", async () => {
  const { api, sessions } = makeApi({ getSshAgentSocket: () => "/tmp/agent.sock" });
  const session = {
    moshStatsAuth: {
      hostname: "h",
      username: "u",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----",
    },
  };
  sessions.set("sid", session);

  api.ensureMoshStatsConnection(session, "sid");
  await tick();
  const client = FakeSSHClient.instances[0];
  assert.ok(client.connectOpts.privateKey);
  assert.equal(client.connectOpts.agent, undefined);
});

test("a saved password does NOT suppress agent auth (agent offered alongside password)", async () => {
  // A public-key host that authenticates via the agent may still carry a
  // stored password; the companion must offer both so agent auth (tried
  // first by ssh2) can succeed instead of failing on password only.
  const { api, sessions } = makeApi({ getSshAgentSocket: () => "/tmp/agent.sock" });
  const session = { moshStatsAuth: { hostname: "h", username: "u", password: "pw" } };
  sessions.set("sid", session);

  api.ensureMoshStatsConnection(session, "sid");
  await tick();
  const client = FakeSSHClient.instances[0];
  assert.equal(client.connectOpts.agent, "/tmp/agent.sock");
  assert.equal(client.connectOpts.password, "pw");
});

test("concurrent calls share a single in-flight connection attempt", async () => {
  const { api, sessions } = makeApi();
  const session = { moshStatsAuth: { hostname: "h", username: "u", password: "p" } };
  sessions.set("sid", session);

  const p1 = api.ensureMoshStatsConnection(session, "sid");
  const p2 = api.ensureMoshStatsConnection(session, "sid");
  await tick();

  assert.equal(FakeSSHClient.instances.length, 1);
  FakeSSHClient.instances[0].emitReady();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, FakeSSHClient.instances[0]);
  assert.equal(r2, FakeSSHClient.instances[0]);
});

test("auth rejection is permanent: no reconnect on the next poll", async () => {
  const { api, sessions } = makeApi();
  const session = { moshStatsAuth: { hostname: "h", username: "u", password: "p" } };
  sessions.set("sid", session);

  const p1 = api.ensureMoshStatsConnection(session, "sid");
  await tick();
  const authErr = new Error("All configured authentication methods failed");
  authErr.level = "client-authentication";
  FakeSSHClient.instances[0].emitError(authErr);
  assert.equal(await p1, null);
  assert.equal(session.moshStatsConnFailed, true);

  // Second poll must not open a new connection.
  const r2 = await api.ensureMoshStatsConnection(session, "sid");
  assert.equal(r2, null);
  assert.equal(FakeSSHClient.instances.length, 1);
});

test("a transient error allows a reconnect on the next poll", async () => {
  const { api, sessions } = makeApi();
  const session = { moshStatsAuth: { hostname: "h", username: "u", password: "p" } };
  sessions.set("sid", session);

  const p1 = api.ensureMoshStatsConnection(session, "sid");
  await tick();
  const netErr = new Error("connect ETIMEDOUT");
  netErr.level = "client-socket";
  FakeSSHClient.instances[0].emitError(netErr);
  assert.equal(await p1, null);
  assert.notEqual(session.moshStatsConnFailed, true);

  // Next poll is allowed to try again.
  api.ensureMoshStatsConnection(session, "sid");
  await tick();
  assert.equal(FakeSSHClient.instances.length, 2);
});

test("a socket that closes mid-handshake settles the attempt instead of hanging", async () => {
  const { api, sessions } = makeApi();
  const session = { moshStatsAuth: { hostname: "h", username: "u", password: "p" } };
  sessions.set("sid", session);

  const pending = api.ensureMoshStatsConnection(session, "sid");
  await tick();
  // Socket drops during the handshake with no prior "ready" or "error".
  FakeSSHClient.instances[0].emit("close");

  const result = await pending;
  assert.equal(result, null);
  // Transient — must not permanently disable stats, and the promise must clear.
  assert.notEqual(session.moshStatsConnFailed, true);
  assert.equal(session.moshStatsConnPromise, null);

  // The next poll is allowed to retry.
  api.ensureMoshStatsConnection(session, "sid");
  await tick();
  assert.equal(FakeSSHClient.instances.length, 2);
});

test("a connection that becomes ready after the session closed is discarded", async () => {
  const { api, sessions } = makeApi();
  const session = { moshStatsAuth: { hostname: "h", username: "u", password: "p" } };
  sessions.set("sid", session);

  const pending = api.ensureMoshStatsConnection(session, "sid");
  await tick();
  // Session goes away before the handshake completes.
  session.closed = true;
  sessions.delete("sid");
  FakeSSHClient.instances[0].emitReady();

  const result = await pending;
  assert.equal(result, null);
  assert.equal(FakeSSHClient.instances[0].ended, true);
  assert.equal(session.conn, undefined);
  assert.equal(session.moshStatsConn, undefined);
});

test("honors host algorithm settings via buildAlgorithms", async () => {
  const calls = [];
  const { api, sessions } = makeApi({
    buildAlgorithms: (legacy, opts) => {
      calls.push({ legacy, opts });
      return { built: true };
    },
  });
  const overrides = { cipher: ["aes128-cbc"] };
  const session = {
    moshStatsAuth: {
      hostname: "h",
      username: "u",
      password: "p",
      legacyAlgorithms: true,
      skipEcdsaHostKey: true,
      algorithmOverrides: overrides,
    },
  };
  sessions.set("sid", session);

  api.ensureMoshStatsConnection(session, "sid");
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].legacy, true);
  assert.equal(calls[0].opts.skipEcdsaHostKey, true);
  assert.equal(calls[0].opts.algorithmOverrides, overrides);
  assert.deepEqual(FakeSSHClient.instances[0].connectOpts.algorithms, { built: true });
});

test("installs a host-key verifier even for key-only auth (no password)", async () => {
  const { api, sessions } = makeApi();
  const session = {
    moshStatsAuth: {
      hostname: "h",
      username: "u",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----",
    },
  };
  sessions.set("sid", session);

  api.ensureMoshStatsConnection(session, "sid");
  await tick();
  const client = FakeSSHClient.instances[0];
  // Regression (#1198 review): a background companion must verify the host key
  // for EVERY auth method, not only when a password is present.
  assert.equal(typeof client.connectOpts.hostVerifier, "function");
});

test("rejects an untrusted host key for key auth and treats it as permanent", async () => {
  const { api, sessions } = makeApi({
    hostKeyVerifier: {
      describeHostKey: () => ({ keyType: "ssh-ed25519", fingerprint: "live-fp" }),
      classifyHostKey: () => ({ status: "unknown" }),
    },
  });
  const session = {
    moshStatsAuth: {
      hostname: "h",
      username: "u",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----",
    },
  };
  sessions.set("sid", session);

  const pending = api.ensureMoshStatsConnection(session, "sid");
  await tick();
  const client = FakeSSHClient.instances[0];

  // The verifier refuses the transport for an unvetted host, even though the
  // companion would have authenticated with a key (no reusable secret leaked).
  let verdict;
  client.connectOpts.hostVerifier(Buffer.from("rawkey"), (ok) => { verdict = ok; });
  assert.equal(verdict, false);

  // ssh2 then aborts the handshake; an untrusted host must be a permanent
  // failure so we don't reconnect (and re-reject) on every stats poll.
  client.emitError(Object.assign(new Error("handshake failed"), { level: "protocol" }));
  const result = await pending;
  assert.equal(result, null);
  assert.equal(session.moshStatsConnFailed, true);
});

test("accepts a trusted host key and adopts the connection", async () => {
  const { api, sessions } = makeApi({
    hostKeyVerifier: {
      describeHostKey: () => ({ keyType: "ssh-ed25519", fingerprint: "fp" }),
      classifyHostKey: () => ({ status: "trusted" }),
    },
  });
  const session = {
    moshStatsAuth: { hostname: "h", username: "u", password: "secret" },
  };
  sessions.set("sid", session);

  const pending = api.ensureMoshStatsConnection(session, "sid");
  await tick();
  const client = FakeSSHClient.instances[0];

  let verdict;
  client.connectOpts.hostVerifier(Buffer.from("rawkey"), (ok) => { verdict = ok; });
  assert.equal(verdict, true);

  client.emitReady();
  assert.equal(await pending, client);
});

test("trusts a host vouched for ONLY by the system known_hosts (Netcatty snapshot empty)", async () => {
  // Netcatty's in-app vault has no record (classify -> unknown), but the user's
  // system OpenSSH known_hosts already trusts the exact live key — which is
  // what the Mosh handshake's system ssh actually used. The companion must
  // accept it so Mosh stats appear.
  const seen = [];
  const { api, sessions } = makeApi({
    hostKeyVerifier: {
      describeHostKey: () => ({ keyType: "ssh-ed25519", fingerprint: "live-fp" }),
      classifyHostKey: () => ({ status: "unknown" }),
    },
    isHostKeyTrustedBySystem: (args) => {
      seen.push(args);
      return args.hostname === "sys.example.com" && args.fingerprint === "live-fp";
    },
  });
  const session = {
    moshStatsAuth: {
      hostname: "sys.example.com",
      port: 22,
      username: "u",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----",
      knownHosts: [],
    },
  };
  sessions.set("sid", session);

  const pending = api.ensureMoshStatsConnection(session, "sid");
  await tick();
  const client = FakeSSHClient.instances[0];

  let verdict;
  client.connectOpts.hostVerifier(Buffer.from("rawkey"), (ok) => { verdict = ok; });
  assert.equal(verdict, true);
  // The system check was consulted with the live key's fingerprint.
  assert.equal(seen.length, 1);
  assert.equal(seen[0].fingerprint, "live-fp");

  client.emitReady();
  assert.equal(await pending, client);
});

test("rejects (permanently) when NEITHER Netcatty nor the system known_hosts trust the key", async () => {
  const { api, sessions } = makeApi({
    hostKeyVerifier: {
      describeHostKey: () => ({ keyType: "ssh-ed25519", fingerprint: "live-fp" }),
      classifyHostKey: () => ({ status: "unknown" }),
    },
    isHostKeyTrustedBySystem: () => false,
  });
  const session = {
    moshStatsAuth: {
      hostname: "untrusted.example.com",
      port: 22,
      username: "u",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----",
      knownHosts: [],
    },
  };
  sessions.set("sid", session);

  const pending = api.ensureMoshStatsConnection(session, "sid");
  await tick();
  const client = FakeSSHClient.instances[0];

  let verdict;
  client.connectOpts.hostVerifier(Buffer.from("rawkey"), (ok) => { verdict = ok; });
  assert.equal(verdict, false);

  // ssh2 aborts; an untrusted host is a permanent failure (no re-poll loop).
  client.emitError(Object.assign(new Error("handshake failed"), { level: "protocol" }));
  assert.equal(await pending, null);
  assert.equal(session.moshStatsConnFailed, true);
});

test("the system fallback is NOT consulted when Netcatty already trusts the key", async () => {
  // Netcatty says trusted -> accept without even touching the system files.
  let consulted = false;
  const { api, sessions } = makeApi({
    hostKeyVerifier: {
      describeHostKey: () => ({ keyType: "ssh-ed25519", fingerprint: "fp" }),
      classifyHostKey: () => ({ status: "trusted" }),
    },
    isHostKeyTrustedBySystem: () => {
      consulted = true;
      return false;
    },
  });
  const session = { moshStatsAuth: { hostname: "h", username: "u", password: "p", knownHosts: [] } };
  sessions.set("sid", session);

  api.ensureMoshStatsConnection(session, "sid");
  await tick();
  let verdict;
  FakeSSHClient.instances[0].connectOpts.hostVerifier(Buffer.from("rawkey"), (ok) => { verdict = ok; });
  assert.equal(verdict, true);
  assert.equal(consulted, false);
});

test("a Netcatty 'changed' key is NOT rescued by a non-matching system check (key rotation stays rejected)", async () => {
  // Netcatty flags a key rotation (changed). The system check is consulted with
  // the LIVE fingerprint; since the system does not record this exact new key,
  // it returns false and the connection is refused — the mismatch is never
  // silently accepted.
  const { api, sessions } = makeApi({
    hostKeyVerifier: {
      describeHostKey: () => ({ keyType: "ssh-ed25519", fingerprint: "rotated-fp" }),
      classifyHostKey: () => ({ status: "changed", expectedFingerprint: "old-fp" }),
    },
    isHostKeyTrustedBySystem: () => false,
  });
  const session = { moshStatsAuth: { hostname: "h", username: "u", password: "p", knownHosts: [] } };
  sessions.set("sid", session);

  api.ensureMoshStatsConnection(session, "sid");
  await tick();
  let verdict;
  FakeSSHClient.instances[0].connectOpts.hostVerifier(Buffer.from("rawkey"), (ok) => { verdict = ok; });
  assert.equal(verdict, false);
});

test("works when isHostKeyTrustedBySystem is not wired in (optional dependency)", async () => {
  // Backward-compat: an api built without the system-known_hosts dependency
  // must not throw; it simply falls back to the Netcatty-only decision.
  const { api, sessions } = makeApi({
    hostKeyVerifier: {
      describeHostKey: () => ({ keyType: "ssh-ed25519", fingerprint: "fp" }),
      classifyHostKey: () => ({ status: "unknown" }),
    },
    isHostKeyTrustedBySystem: undefined,
  });
  const session = {
    moshStatsAuth: {
      hostname: "h",
      username: "u",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nx\n-----END OPENSSH PRIVATE KEY-----",
      knownHosts: [],
    },
  };
  sessions.set("sid", session);

  api.ensureMoshStatsConnection(session, "sid");
  await tick();
  let verdict;
  FakeSSHClient.instances[0].connectOpts.hostVerifier(Buffer.from("rawkey"), (ok) => { verdict = ok; });
  assert.equal(verdict, false);
});
