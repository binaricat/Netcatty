const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const passphraseHandler = require("./passphraseHandler.cjs");
const keyboardInteractiveHandler = require("./keyboardInteractiveHandler.cjs");
const {
  beginTransportDial,
  failTransportDial,
  getTransportStats,
  resetSshTransportRegistryForTests,
} = require("./sshConnectionPool.cjs");
const {
  startPortForward,
  stopPortForward,
  stopPortForwardByRuleId,
  getPortForwardStatus,
  subscribePortForward,
  listPortForwards,
  cancelTunnel,
  publishTunnelStatus,
  shouldFinalizeTunnelClose,
  isReusableTunnelStatus,
  _bindPortForwardChannelsForTests: bindPortForwardChannels,
} = require("./portForwardingBridge.cjs");

function createEncryptedKey(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-port-forward-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const keyPath = path.join(dir, "id_ed25519");
  const result = spawnSync("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "secret",
    "-f",
    keyPath,
    "-C",
    "netcatty-test",
  ], { encoding: "utf8" });

  if (result.status !== 0) {
    t.skip("ssh-keygen is unavailable");
    return null;
  }

  return keyPath;
}

function createSender() {
  return createCapturingSender();
}

function createCapturingSender(onSend = () => {}, id = 1) {
  return {
    id,
    isDestroyed: () => false,
    send: (channel, payload) => onSend(channel, payload),
  };
}

test("only live or connecting tunnels are reusable", () => {
  assert.equal(isReusableTunnelStatus("active"), true);
  assert.equal(isReusableTunnelStatus("connecting"), true);
  assert.equal(isReusableTunnelStatus("error"), false);
  assert.equal(isReusableTunnelStatus("inactive"), false);
});

test("status publication removes destroyed renderer subscribers", () => {
  const received = [];
  const destroyed = {
    id: 1,
    isDestroyed: () => true,
    send: () => assert.fail("destroyed renderer must not receive status"),
  };
  const healthy = createCapturingSender((channel, payload) => {
    received.push({ channel, payload });
  }, 2);
  const tunnel = {
    subscribers: new Map([
      [destroyed.id, destroyed],
      [healthy.id, healthy],
    ]),
  };

  publishTunnelStatus("pf-prune-subscribers", tunnel, "active");

  assert.deepEqual(Array.from(tunnel.subscribers.keys()), [healthy.id]);
  assert.equal(received.length, 1);
  assert.equal(received[0]?.payload.status, "active");
});

test("failed active tunnel cleanup publishes an error instead of a false inactive state", async () => {
  let wouldPublishDuringCleanup;
  const statuses = [];
  const tunnel = {
    status: "active",
    server: {
      close() {
        throw new Error("server close failed");
      },
    },
    conn: {
      end() {
        wouldPublishDuringCleanup = shouldFinalizeTunnelClose(tunnel);
      },
    },
  };

  await assert.rejects(
    () => cancelTunnel("pf-active-cleanup-failure", tunnel, (status, error) => {
      statuses.push({ status, error });
    }),
    /server close failed/,
  );
  assert.equal(wouldPublishDuringCleanup, false);
  assert.equal(shouldFinalizeTunnelClose(tunnel), false);
  assert.equal(tunnel.status, "error");
  assert.deepEqual(statuses, [{ status: "error", error: "server: server close failed" }]);
});

test("cancelling a tunnel clears its pending keyboard-interactive request", async () => {
  const tunnelId = "pf-keyboard-interactive-cancel";
  const requestId = keyboardInteractiveHandler.generateRequestId("port-forward");
  const finishCalls = [];
  keyboardInteractiveHandler.storeRequest(
    requestId,
    (responses) => finishCalls.push(responses),
    1,
    tunnelId,
  );

  await cancelTunnel(tunnelId, {}, () => {});

  assert.deepEqual(finishCalls, [[]]);
  assert.equal(keyboardInteractiveHandler.getRequests().has(requestId), false);
});

test("stopping a pending remote forward invalidates its connection immediately", async () => {
  let finishForward;
  let endCalls = 0;
  let unforwardCalls = 0;
  const conn = {
    forwardIn(_bind, _port, callback) {
      finishForward = callback;
    },
    unforwardIn(_bind, _port, callback) {
      unforwardCalls += 1;
      callback(null);
    },
    end() { endCalls += 1; },
    on() {},
    removeListener() {},
  };
  const tunnelId = "pf-remote-pending-stop";
  const tunnel = {
    tunnelId,
    conn,
    status: "connecting",
    cancelled: false,
    sshTransportManaged: false,
    chainConnections: [],
  };
  const binding = bindPortForwardChannels({
    type: "remote",
    conn,
    tunnelId,
    tunnelState: tunnel,
    sender: createSender(),
    bindAddress: "127.0.0.1",
    localPort: 22022,
    remoteHost: "127.0.0.1",
    remotePort: 22,
    chainConnections: [],
    sendStatus() {},
  });

  const stopping = cancelTunnel(tunnelId, tunnel, () => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(unforwardCalls, 0);
  assert.equal(endCalls, 1, "cancel must invalidate the transport that owns the pending callback");

  finishForward(null);
  assert.deepEqual(await binding, { tunnelId, success: false, cancelled: true });
  await stopping;
  assert.equal(unforwardCalls, 0, "a late response on an invalidated transport must be ignored");
  assert.equal(endCalls, 1, "cleanup must not end the invalidated connection twice");
});

test("stopping a remote forward whose bind callback hangs discards the connection", async () => {
  let endCalls = 0;
  let unforwardCalls = 0;
  const conn = {
    forwardIn() {},
    unforwardIn() { unforwardCalls += 1; },
    end() { endCalls += 1; },
    on() {},
    removeListener() {},
  };
  const tunnelId = "pf-remote-hung-bind-stop";
  const tunnel = {
    tunnelId,
    conn,
    status: "connecting",
    cancelled: false,
    sshTransportManaged: false,
    chainConnections: [],
    _remoteForwardStartCleanupTimeoutMs: 5,
  };
  const binding = bindPortForwardChannels({
    type: "remote",
    conn,
    tunnelId,
    tunnelState: tunnel,
    sender: createSender(),
    bindAddress: "127.0.0.1",
    localPort: 22023,
    remoteHost: "127.0.0.1",
    remotePort: 22,
    chainConnections: [],
    sendStatus() {},
  });

  await Promise.race([
    cancelTunnel(tunnelId, tunnel, () => {}),
    new Promise((_, reject) => setTimeout(() => reject(new Error("cancel did not settle")), 100)),
  ]);
  assert.equal(unforwardCalls, 0);
  assert.equal(endCalls, 1);

  // The bind request itself remains pending because the fake server never
  // calls back; it must not keep the test process alive.
  void binding.catch(() => {});
});

test("port forwarding can be stopped while waiting for a key passphrase", async (t) => {
  const keyPath = createEncryptedKey(t);
  if (!keyPath) return;
  const privateKey = fs.readFileSync(keyPath, "utf8");

  const sent = [];
  let passphraseRequest;
  const promptStarted = new Promise((resolve) => {
    passphraseRequest = resolve;
  });

  const tunnelId = "pf-rule-cancel-1";
  const event = {
    sender: createCapturingSender((channel, payload) => {
      sent.push({ channel, payload });
      if (channel === "netcatty:passphrase-request") {
        passphraseRequest(payload);
      }
    }),
  };
  const startPromise = startPortForward(event, {
    ruleId: "rule-cancel-1",
    tunnelId,
    type: "local",
    localPort: 0,
    bindAddress: "127.0.0.1",
    remoteHost: "127.0.0.1",
    remotePort: 80,
    hostname: "example.test",
    username: "alice",
    privateKey,
    keyId: "key-1",
  });

  const request = await promptStarted;
  assert.deepEqual(await getPortForwardStatus(event, { tunnelId }), {
    tunnelId,
    status: "connecting",
    type: "local",
  });
  assert.deepEqual(await listPortForwards(), [{
    ruleId: "rule-cancel-1",
    tunnelId,
    type: "local",
    status: "connecting",
  }]);

  const adoptedStatuses = [];
  const adoptedEvent = {
    sender: createCapturingSender((channel, payload) => {
      if (channel === "netcatty:portforward:status") adoptedStatuses.push(payload);
    }, 2),
  };
  assert.deepEqual(await subscribePortForward(adoptedEvent, { tunnelId }), {
    tunnelId,
    status: "connecting",
    type: "local",
  });

  assert.deepEqual(await stopPortForward(event, { tunnelId }), {
    tunnelId,
    success: true,
  });
  assert.equal(adoptedStatuses.length, 1);
  assert.equal(adoptedStatuses[0].tunnelId, tunnelId);
  assert.equal(adoptedStatuses[0].status, "inactive");
  assert.equal(adoptedStatuses[0].error, null);
  assert.equal(adoptedStatuses[0].ruleId, "rule-cancel-1");
  assert.equal(typeof adoptedStatuses[0].epoch, "string");
  assert.equal(typeof adoptedStatuses[0].revision, "number");
  assert.equal(adoptedStatuses[0].cleanupRequired, false);
  assert.deepEqual(await getPortForwardStatus(event, { tunnelId }), {
    tunnelId,
    status: "inactive",
  });

  assert.deepEqual(await startPromise, {
    tunnelId,
    success: false,
    cancelled: true,
  });
  assert.ok(sent.some((event) =>
    event.channel === "netcatty:passphrase-cancelled" &&
    event.payload.requestId === request.requestId
  ));
  assert.deepEqual(await getPortForwardStatus(event, { tunnelId }), {
    tunnelId,
    status: "inactive",
  });
});

test("port forwarding can be stopped while waiting for a matching shared transport dial", async (t) => {
  resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 });
  t.after(() => resetSshTransportRegistryForTests({ defaultIdleTtlMs: 0 }));
  const publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestPublicKey";
  const endpoint = {
    hostId: "host-shared-wait",
    hostname: "shared-wait.test",
    port: 22,
    username: "alice",
    jumpHosts: [],
    proxy: null,
    authType: "publickey",
    keyId: "key-shared-wait",
    certificate: "",
    requiresMfa: false,
    verifyHostKeys: false,
    useSshAgent: false,
    agentForwarding: false,
    publicKey,
  };
  const leader = beginTransportDial(endpoint, { kind: "channel" });
  t.after(() => failTransportDial(leader, new Error("test cleanup")));
  const tunnelId = "pf-shared-wait";
  const event = { sender: createSender() };

  const started = startPortForward(event, {
    tunnelId,
    ruleId: "rule-shared-wait",
    type: "local",
    localPort: 0,
    bindAddress: "127.0.0.1",
    remoteHost: "127.0.0.1",
    remotePort: 80,
    hostname: endpoint.hostname,
    hostId: endpoint.hostId,
    port: endpoint.port,
    username: endpoint.username,
    authMethod: endpoint.authType,
    keyId: endpoint.keyId,
    publicKey,
    verifyHostKeys: false,
    useSshAgent: false,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(getTransportStats().pendingDials, 1, "PF joins the matching authenticated identity");
  assert.deepEqual(await getPortForwardStatus(event, { tunnelId }), {
    tunnelId,
    status: "connecting",
    type: "local",
  });
  assert.deepEqual(await stopPortForward(event, { tunnelId }), { tunnelId, success: true });
  assert.deepEqual(await started, { tunnelId, success: false, cancelled: true });
  assert.equal(getTransportStats().pendingDials, 1, "stopping a waiter does not cancel the dial leader");
});

test("port forwarding stops when the key passphrase prompt is cancelled", async (t) => {
  const keyPath = createEncryptedKey(t);
  if (!keyPath) return;
  const privateKey = fs.readFileSync(keyPath, "utf8");

  const originalRequestPassphrase = passphraseHandler.requestPassphrase;
  t.after(() => {
    passphraseHandler.requestPassphrase = originalRequestPassphrase;
  });
  passphraseHandler.requestPassphrase = async () => ({ cancelled: true });

  const tunnelId = "pf-rule-cancel-2";
  const event = { sender: createSender() };
  const result = await startPortForward(event, {
    tunnelId,
    type: "local",
    localPort: 0,
    bindAddress: "127.0.0.1",
    remoteHost: "127.0.0.1",
    remotePort: 80,
    hostname: "example.test",
    username: "alice",
    privateKey,
    keyId: "key-1",
  });

  assert.deepEqual(result, {
    tunnelId,
    success: false,
    cancelled: true,
  });
  assert.deepEqual(await getPortForwardStatus(event, { tunnelId }), {
    tunnelId,
    status: "inactive",
  });
});

test("concurrent starts reuse the existing tunnel for the same rule", async (t) => {
  const keyPath = createEncryptedKey(t);
  if (!keyPath) return;
  const privateKey = fs.readFileSync(keyPath, "utf8");

  let promptCount = 0;
  let firstPromptStarted;
  const promptStarted = new Promise((resolve) => {
    firstPromptStarted = resolve;
  });
  const event = {
    sender: createCapturingSender((channel) => {
      if (channel === "netcatty:passphrase-request") {
        promptCount++;
        firstPromptStarted();
      }
    }),
  };
  const secondEvent = {
    sender: createCapturingSender((channel) => {
      if (channel === "netcatty:portforward:status") {
        throw new Error("renderer closed during send");
      }
    }, 2),
  };
  const thirdWindowEvents = [];
  const thirdEvent = {
    sender: createCapturingSender((channel, payload) => {
      thirdWindowEvents.push({ channel, payload });
    }, 3),
  };
  const payload = {
    ruleId: "shared-rule",
    type: "local",
    localPort: 0,
    bindAddress: "127.0.0.1",
    remoteHost: "127.0.0.1",
    remotePort: 80,
    hostname: "example.test",
    username: "alice",
    privateKey,
    keyId: "key-shared",
  };

  const firstStart = startPortForward(event, {
    ...payload,
    tunnelId: "pf-shared-rule-first",
  });
  await promptStarted;

  const secondStart = await startPortForward(secondEvent, {
    ...payload,
    tunnelId: "pf-shared-rule-second",
  });
  const thirdStart = await startPortForward(thirdEvent, {
    ...payload,
    tunnelId: "pf-shared-rule-third",
  });

  assert.deepEqual(secondStart, {
    tunnelId: "pf-shared-rule-first",
    success: true,
    reused: true,
    status: "connecting",
  });
  assert.deepEqual(thirdStart, {
    tunnelId: "pf-shared-rule-first",
    success: true,
    reused: true,
    status: "connecting",
  });
  assert.equal(promptCount, 1);
  assert.deepEqual(await listPortForwards(), [{
    ruleId: "shared-rule",
    tunnelId: "pf-shared-rule-first",
    type: "local",
    status: "connecting",
  }]);

  assert.equal((await stopPortForwardByRuleId(event, { ruleId: "shared-rule" })).stopped, 1);
  assert.ok(thirdWindowEvents.some(({ channel, payload }) => (
    channel === "netcatty:portforward:status" &&
    payload.tunnelId === "pf-shared-rule-first" &&
    payload.status === "inactive"
  )));
  assert.equal((await firstStart).cancelled, true);
});

test("stop by rule id only cancels the matching passphrase prompt", async (t) => {
  const keyPath = createEncryptedKey(t);
  if (!keyPath) return;
  const privateKey = fs.readFileSync(keyPath, "utf8");

  const sent = [];
  const requests = [];
  let resolveBothPrompts;
  const bothPromptsStarted = new Promise((resolve) => {
    resolveBothPrompts = resolve;
  });
  const event = {
    sender: createCapturingSender((channel, payload) => {
      sent.push({ channel, payload });
      if (channel === "netcatty:passphrase-request") {
        requests.push(payload);
        if (requests.length === 2) {
          resolveBothPrompts();
        }
      }
    }),
  };

  const firstTunnelId = "pf-rule-1";
  const secondTunnelId = "pf-rule-long-1";
  const firstStart = startPortForward(event, {
    ruleId: "rule",
    tunnelId: firstTunnelId,
    type: "local",
    localPort: 0,
    bindAddress: "127.0.0.1",
    remoteHost: "127.0.0.1",
    remotePort: 80,
    hostname: "first.example",
    username: "alice",
    privateKey,
    keyId: "key-1",
  });
  const secondStart = startPortForward(event, {
    ruleId: "rule-long",
    tunnelId: secondTunnelId,
    type: "local",
    localPort: 0,
    bindAddress: "127.0.0.1",
    remoteHost: "127.0.0.1",
    remotePort: 80,
    hostname: "second.example",
    username: "alice",
    privateKey,
    keyId: "key-2",
  });

  await bothPromptsStarted;
  const firstRequest = requests.find((request) => request.hostname === "first.example");
  const secondRequest = requests.find((request) => request.hostname === "second.example");
  assert.ok(firstRequest);
  assert.ok(secondRequest);

  assert.deepEqual(await stopPortForwardByRuleId(event, { ruleId: "rule" }), {
    stopped: 1,
    failed: 0,
    errors: [],
  });
  assert.deepEqual(await firstStart, {
    tunnelId: firstTunnelId,
    success: false,
    cancelled: true,
  });
  assert.ok(sent.some((event) =>
    event.channel === "netcatty:passphrase-cancelled" &&
    event.payload.requestId === firstRequest.requestId
  ));
  assert.equal(sent.some((event) =>
    event.channel === "netcatty:passphrase-cancelled" &&
    event.payload.requestId === secondRequest.requestId
  ), false);
  assert.deepEqual(await getPortForwardStatus(event, { tunnelId: secondTunnelId }), {
    tunnelId: secondTunnelId,
    status: "connecting",
    type: "local",
  });

  assert.deepEqual(await stopPortForward(event, { tunnelId: secondTunnelId }), {
    tunnelId: secondTunnelId,
    success: true,
  });
  assert.deepEqual(await secondStart, {
    tunnelId: secondTunnelId,
    success: false,
    cancelled: true,
  });
});

test("stop by rule id reports cleanup failures and keeps the tunnel retryable", async (t) => {
  const keyPath = createEncryptedKey(t);
  if (!keyPath) return;
  const privateKey = fs.readFileSync(keyPath, "utf8");
  let passphraseRequest;
  const promptStarted = new Promise((resolve) => {
    passphraseRequest = resolve;
  });
  const event = {
    sender: createCapturingSender((channel, payload) => {
      if (channel === "netcatty:passphrase-request") passphraseRequest(payload);
    }),
  };
  const tunnelId = "pf-rule-cleanup-failure";
  const startPromise = startPortForward(event, {
    ruleId: "cleanup-failure-rule",
    tunnelId,
    type: "local",
    localPort: 0,
    bindAddress: "127.0.0.1",
    remoteHost: "127.0.0.1",
    remotePort: 80,
    hostname: "cleanup-failure.example",
    username: "alice",
    privateKey,
    keyId: "cleanup-failure-key",
  });
  await promptStarted;

  const originalAbort = AbortController.prototype.abort;
  AbortController.prototype.abort = function abortFailure() {
    throw new Error("abort failed");
  };
  t.after(() => {
    AbortController.prototype.abort = originalAbort;
  });

  assert.deepEqual(await stopPortForwardByRuleId(event, { ruleId: "cleanup-failure-rule" }), {
    stopped: 0,
    failed: 1,
    errors: ["passphrase prompt: abort failed"],
  });
  assert.deepEqual(await getPortForwardStatus(event, { tunnelId }), {
    tunnelId,
    status: "error",
    type: "local",
    error: "passphrase prompt: abort failed",
  });

  assert.deepEqual(await startPortForward(event, {
    ruleId: "cleanup-failure-rule",
    tunnelId: "pf-rule-cleanup-failure-retry",
    type: "local",
    localPort: 0,
    bindAddress: "127.0.0.1",
    remoteHost: "127.0.0.1",
    remotePort: 80,
    hostname: "cleanup-failure.example",
    username: "alice",
    privateKey,
    keyId: "cleanup-failure-key",
  }), {
    tunnelId,
    success: false,
    blockedByCleanup: true,
    error: "The existing tunnel could not be cleaned up. Stop it successfully before restarting.",
  });

  AbortController.prototype.abort = originalAbort;
  assert.deepEqual(await stopPortForwardByRuleId(event, { ruleId: "cleanup-failure-rule" }), {
    stopped: 1,
    failed: 0,
    errors: [],
  });
  assert.deepEqual(await startPromise, {
    tunnelId,
    success: false,
    cancelled: true,
  });
});
