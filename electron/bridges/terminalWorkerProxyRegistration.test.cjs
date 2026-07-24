const assert = require("node:assert/strict");
const test = require("node:test");

const terminalBridge = require("./terminalBridge.cjs");
const sshBridge = require("./sshBridge.cjs");
const keyboardInteractiveHandler = require("./keyboardInteractiveHandler.cjs");
const passphraseHandler = require("./passphraseHandler.cjs");
const hostKeyVerifier = require("./hostKeyVerifier.cjs");
const sftpBridge = require("./sftpBridge.cjs");
const transferBridge = require("./transferBridge.cjs");
const compressUploadBridge = require("./compressUploadBridge.cjs");
const fileWatcherBridge = require("./fileWatcherBridge.cjs");
const { createSystemManagerBridge } = require("./systemManagerBridge.cjs");

function createFakeIpcMain() {
  return {
    handlers: new Map(),
    listeners: new Map(),
    handle(channel, handler) {
      this.handlers.set(channel, handler);
    },
    on(channel, listener) {
      this.listeners.set(channel, listener);
    },
  };
}

function createFakeWorkerManager() {
  const requests = [];
  const sends = [];
  return {
    requests,
    sends,
    request(channel, payload, options) {
      requests.push({ channel, payload, options });
      return Promise.resolve({ ok: true, channel });
    },
    send(channel, payload, options) {
      sends.push({ channel, payload, options });
    },
  };
}

const fakeEvent = { sender: { id: 42 } };

test("terminal worker mode proxies all terminal starts and control commands", async () => {
  const ipcMain = createFakeIpcMain();
  const terminalWorkerManager = createFakeWorkerManager();

  terminalBridge.registerHandlers(ipcMain, { terminalWorkerManager });

  for (const channel of [
    "netcatty:local:start",
    "netcatty:telnet:start",
    "netcatty:mosh:start",
    "netcatty:et:start",
    "netcatty:serial:start",
    "netcatty:close:await",
  ]) {
    assert.equal(ipcMain.handlers.has(channel), true, `${channel} should be proxied as a request`);
    await ipcMain.handlers.get(channel)(fakeEvent, { sessionId: channel });
  }

  for (const channel of [
    "netcatty:write",
    "netcatty:interrupt",
    "netcatty:resize",
    "netcatty:pty:clear",
    "netcatty:flow",
    "netcatty:flow:ack",
    "netcatty:close",
  ]) {
    assert.equal(ipcMain.listeners.has(channel), true, `${channel} should be proxied as a send`);
    ipcMain.listeners.get(channel)(fakeEvent, { sessionId: channel });
  }

  assert.deepEqual(
    terminalWorkerManager.requests.map((entry) => entry.channel),
    [
      "netcatty:local:start",
      "netcatty:telnet:start",
      "netcatty:mosh:start",
      "netcatty:et:start",
      "netcatty:serial:start",
      "netcatty:close:await",
    ],
  );
  assert.deepEqual(
    terminalWorkerManager.sends.map((entry) => entry.channel),
    [
      "netcatty:write",
      "netcatty:interrupt",
      "netcatty:resize",
      "netcatty:pty:clear",
      "netcatty:flow",
      "netcatty:flow:ack",
      "netcatty:close",
    ],
  );
});

test("terminal worker mode proxies SSH session and remote helper requests", async () => {
  const ipcMain = createFakeIpcMain();
  const terminalWorkerManager = createFakeWorkerManager();

  sshBridge.registerHandlers(ipcMain, { terminalWorkerManager });

  for (const channel of [
    "netcatty:start",
    "netcatty:ssh:exec",
    "netcatty:ssh:pwd",
    "netcatty:ssh:remoteInfo",
    "netcatty:ssh:distroInfo",
    "netcatty:ssh:readRemoteHistory",
    "netcatty:ssh:listdir",
    "netcatty:ssh:stats",
    "netcatty:ssh:setEncoding",
  ]) {
    assert.equal(ipcMain.handlers.has(channel), true, `${channel} should be proxied`);
    await ipcMain.handlers.get(channel)(fakeEvent, { sessionId: "ssh-1" });
  }

  assert.deepEqual(
    terminalWorkerManager.requests.map((entry) => entry.channel),
    [
      "netcatty:start",
      "netcatty:ssh:exec",
      "netcatty:ssh:pwd",
      "netcatty:ssh:remoteInfo",
      "netcatty:ssh:distroInfo",
      "netcatty:ssh:readRemoteHistory",
      "netcatty:ssh:listdir",
      "netcatty:ssh:stats",
      "netcatty:ssh:setEncoding",
    ],
  );
});

test("terminal worker mode keeps main-process keyboard-interactive responses in the main process", async () => {
  const ipcMain = createFakeIpcMain();
  const terminalWorkerManager = createFakeWorkerManager();
  const requestId = keyboardInteractiveHandler.generateRequestId("port-forward");
  let receivedResponses = null;

  keyboardInteractiveHandler.storeRequest(
    requestId,
    (responses) => {
      receivedResponses = responses;
    },
    fakeEvent.sender.id,
    "tunnel-1",
  );
  sshBridge.registerHandlers(ipcMain, { terminalWorkerManager });

  const result = await ipcMain.handlers.get("netcatty:keyboard-interactive:respond")(
    fakeEvent,
    { requestId, responses: ["123456"], cancelled: false },
  );

  const remainedPending = keyboardInteractiveHandler.getRequests().has(requestId);
  if (remainedPending) {
    keyboardInteractiveHandler.handleResponse(fakeEvent, {
      requestId,
      responses: [],
      cancelled: true,
    });
  }

  assert.deepEqual(result, { success: true });
  assert.deepEqual(receivedResponses, ["123456"]);
  assert.equal(remainedPending, false);
  assert.equal(terminalWorkerManager.requests.length, 0);
});

test("terminal worker mode keeps main-process passphrase responses in the main process", async () => {
  const ipcMain = createFakeIpcMain();
  const terminalWorkerManager = createFakeWorkerManager();
  const sent = [];
  const sender = {
    id: fakeEvent.sender.id,
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  };
  const responsePromise = passphraseHandler.requestPassphrase(
    sender,
    "/tmp/test-key",
    "test-key",
    "example.com",
    false,
  );
  const requestId = sent[0].payload.requestId;
  sshBridge.registerHandlers(ipcMain, { terminalWorkerManager });

  const wrongResult = await ipcMain.handlers.get("netcatty:passphrase:respond")(
    { sender: { id: fakeEvent.sender.id + 1 } },
    { requestId, passphrase: "stolen", cancelled: false },
  );
  assert.deepEqual(wrongResult, { success: false, error: "Wrong sender" });
  assert.equal(passphraseHandler.getRequests().has(requestId), true);

  const result = await ipcMain.handlers.get("netcatty:passphrase:respond")(
    fakeEvent,
    { requestId, passphrase: "secret", cancelled: false },
  );

  assert.deepEqual(result, { success: true });
  assert.deepEqual(await responsePromise, { passphrase: "secret" });
  assert.equal(passphraseHandler.getRequests().has(requestId), false);
  assert.equal(terminalWorkerManager.requests.length, 0);
});

test("terminal worker mode keeps main-process host-key responses in the main process", async () => {
  const ipcMain = createFakeIpcMain();
  const terminalWorkerManager = createFakeWorkerManager();
  const sent = [];
  const sender = {
    id: fakeEvent.sender.id,
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  };
  const responsePromise = hostKeyVerifier.requestHostKeyVerification(sender, {
    sessionId: "tunnel-1",
    hostname: "example.com",
    port: 22,
    status: "unknown",
  });
  const requestId = sent[0].payload.requestId;
  sshBridge.registerHandlers(ipcMain, { terminalWorkerManager });

  const wrongResult = await ipcMain.handlers.get("netcatty:host-key:respond")(
    { sender: { id: fakeEvent.sender.id + 1 } },
    { requestId, accept: true, addToKnownHosts: false },
  );
  assert.deepEqual(wrongResult, { success: false, error: "Wrong sender" });
  assert.equal(hostKeyVerifier.getRequests().has(requestId), true);

  const result = await ipcMain.handlers.get("netcatty:host-key:respond")(
    fakeEvent,
    { requestId, accept: true, addToKnownHosts: false },
  );

  assert.deepEqual(result, { success: true });
  assert.deepEqual(await responsePromise, { accept: true, addToKnownHosts: false });
  assert.equal(hostKeyVerifier.getRequests().has(requestId), false);
  assert.equal(terminalWorkerManager.requests.length, 0);
});

test("terminal worker mode forwards worker-owned authentication responses", async () => {
  const ipcMain = createFakeIpcMain();
  const terminalWorkerManager = createFakeWorkerManager();
  sshBridge.registerHandlers(ipcMain, { terminalWorkerManager });

  for (const channel of [
    "netcatty:keyboard-interactive:respond",
    "netcatty:passphrase:respond",
    "netcatty:host-key:respond",
  ]) {
    const result = await ipcMain.handlers.get(channel)(fakeEvent, { requestId: `worker-${channel}` });
    assert.deepEqual(result, { ok: true, channel });
  }

  assert.deepEqual(
    terminalWorkerManager.requests.map((entry) => entry.channel),
    [
      "netcatty:keyboard-interactive:respond",
      "netcatty:passphrase:respond",
      "netcatty:host-key:respond",
    ],
  );
});

test("terminal worker mode proxies SFTP and surrounding file operations", async () => {
  const ipcMain = createFakeIpcMain();
  const terminalWorkerManager = createFakeWorkerManager();

  sftpBridge.registerHandlers(ipcMain, { terminalWorkerManager });
  transferBridge.registerHandlers(ipcMain, { terminalWorkerManager });
  compressUploadBridge.registerHandlers(ipcMain, { terminalWorkerManager });
  fileWatcherBridge.registerHandlers(ipcMain, { terminalWorkerManager });

  for (const channel of [
    "netcatty:sftp:openForSession",
    "netcatty:sftp:list",
    "netcatty:sftp:write",
    "netcatty:sftp:downloadToLocal",
    "netcatty:sftp:uploadLocal",
    "netcatty:sftp:close",
    "netcatty:transfer:start",
    "netcatty:transfer:cancel",
    "netcatty:compress:start",
    "netcatty:compress:checkSupport",
    "netcatty:filewatch:start",
    "netcatty:filewatch:registerTempFile",
  ]) {
    assert.equal(ipcMain.handlers.has(channel), true, `${channel} should be proxied`);
    await ipcMain.handlers.get(channel)(fakeEvent, { sessionId: "ssh-1", sftpId: "sftp-1" });
  }

  assert.deepEqual(
    terminalWorkerManager.requests.map((entry) => entry.channel),
    [
      "netcatty:sftp:openForSession",
      "netcatty:sftp:list",
      "netcatty:sftp:write",
      "netcatty:sftp:downloadToLocal",
      "netcatty:sftp:uploadLocal",
      "netcatty:sftp:close",
      "netcatty:transfer:start",
      "netcatty:transfer:cancel",
      "netcatty:compress:start",
      "netcatty:compress:checkSupport",
      "netcatty:filewatch:start",
      "netcatty:filewatch:registerTempFile",
    ],
  );
});

test("terminal worker mode proxies system management requests", async () => {
  const ipcMain = createFakeIpcMain();
  const terminalWorkerManager = createFakeWorkerManager();
  const systemManagerBridge = createSystemManagerBridge({
    getSessions: () => new Map(),
    execOnEtSession: () => {},
    ensureMoshStatsConnection: () => {},
    process,
  });

  systemManagerBridge.registerHandlers(ipcMain, { terminalWorkerManager });

  for (const channel of [
    "netcatty:system:probeCapabilities",
    "netcatty:system:listProcesses",
    "netcatty:system:setupOsc7Tracking",
    "netcatty:system:listTmuxSessions",
    "netcatty:system:listDockerContainers",
  ]) {
    assert.equal(ipcMain.handlers.has(channel), true, `${channel} should be proxied`);
    await ipcMain.handlers.get(channel)(fakeEvent, { sessionId: "ssh-1" });
  }

  assert.deepEqual(
    terminalWorkerManager.requests.map((entry) => entry.channel),
    [
      "netcatty:system:probeCapabilities",
      "netcatty:system:listProcesses",
      "netcatty:system:setupOsc7Tracking",
      "netcatty:system:listTmuxSessions",
      "netcatty:system:listDockerContainers",
    ],
  );
});
