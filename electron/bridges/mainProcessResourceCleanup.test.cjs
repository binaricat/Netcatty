"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const test = require("node:test");

const { isolateCliDiscoveryFile } = require("./cliDiscoveryTestIsolation.cjs");
isolateCliDiscoveryFile();

const aiBridge = require("./aiBridge.cjs");
const sftpBridge = require("./sftpBridge.cjs");
const {
  _bindPortForwardChannelsForTests: bindPortForwardChannels,
  _clearPortForwardTunnelsForTests: clearPortForwardTunnels,
  _seedPortForwardTunnelForTests: seedPortForwardTunnel,
} = require("./portForwardingBridge.cjs");

function loadFreshMcpBridge() {
  const bridgePath = require.resolve("./mcpServerBridge.cjs");
  delete require.cache[bridgePath];
  return require("./mcpServerBridge.cjs");
}

function readBytes(socket, count) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const onData = (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= count) {
        cleanup();
        resolve(Buffer.concat(chunks, total));
      }
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      resolve(Buffer.concat(chunks, total));
    };
    const cleanup = () => {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

test("aiBridge.cleanup does not cold-load OpenCode modules when they were never loaded", (t) => {
  const driverPath = require.resolve("./aiBridge/sdk/opencodeDriver.cjs");
  const v2Path = require.resolve("./aiBridge/sdk/opencodeV2.cjs");
  const prevDriver = require.cache[driverPath];
  const prevV2 = require.cache[v2Path];
  delete require.cache[driverPath];
  delete require.cache[v2Path];
  t.after(() => {
    if (prevDriver) require.cache[driverPath] = prevDriver;
    else delete require.cache[driverPath];
    if (prevV2) require.cache[v2Path] = prevV2;
    else delete require.cache[v2Path];
  });

  aiBridge.cleanup();

  assert.equal(require.cache[driverPath], undefined, "opencodeDriver.cjs must not be loaded on quit");
  assert.equal(require.cache[v2Path], undefined, "opencodeV2.cjs must not be loaded on quit");
});

test("aiBridge.cleanup resets cached OpenCode list-server pool when driver is loaded", (t) => {
  const driverPath = require.resolve("./aiBridge/sdk/opencodeDriver.cjs");
  const v2Path = require.resolve("./aiBridge/sdk/opencodeV2.cjs");
  const prevDriver = require.cache[driverPath];
  const prevV2 = require.cache[v2Path];
  let driverResets = 0;
  let v2Resets = 0;

  require.cache[driverPath] = {
    id: driverPath,
    filename: driverPath,
    loaded: true,
    exports: {
      resetOpenCodeListServerPool: () => {
        driverResets += 1;
      },
    },
  };
  require.cache[v2Path] = {
    id: v2Path,
    filename: v2Path,
    loaded: true,
    exports: {
      resetOpenCodeV2ListServerPool: () => {
        v2Resets += 1;
      },
    },
  };

  t.after(() => {
    if (prevDriver) require.cache[driverPath] = prevDriver;
    else delete require.cache[driverPath];
    if (prevV2) require.cache[v2Path] = prevV2;
    else delete require.cache[v2Path];
  });

  aiBridge.cleanup();
  assert.equal(driverResets, 1);
  assert.equal(v2Resets, 0, "opencodeDriver.resetOpenCodeListServerPool owns v2 cleanup when driver is loaded");

  delete require.cache[driverPath];
  aiBridge.cleanup();
  assert.equal(v2Resets, 1, "falls back to opencodeV2 reset when only v2 was loaded");
});

test("SOCKS5 dynamic forward detaches handshake data listener on connect and failure", async (t) => {
  clearPortForwardTunnels();
  const tunnelId = "socks5-detach-test";
  const tunnelState = {
    ruleId: "rule-socks5-detach",
    status: "connecting",
    subscribers: new Map(),
    pipes: new Set(),
  };
  seedPortForwardTunnel(tunnelId, tunnelState);

  const streams = [];
  const conn = {
    forwardOut(_srcIP, _srcPort, targetHost, targetPort, cb) {
      assert.equal(targetHost, "127.0.0.1");
      assert.equal(targetPort, 80);
      const stream = new PassThrough();
      streams.push(stream);
      cb(null, stream);
    },
    end() {},
  };

  t.after(async () => {
    for (const s of streams) {
      try { s.destroy(); } catch { /* ignore */ }
    }
    if (tunnelState.server) {
      await new Promise((resolve) => tunnelState.server.close(resolve));
      tunnelState.server = null;
    }
    clearPortForwardTunnels();
  });

  await bindPortForwardChannels({
    type: "dynamic",
    conn,
    tunnelId,
    tunnelState,
    sender: {
      id: 1,
      isDestroyed: () => false,
      send: () => {},
      once: () => {},
      removeListener: () => {},
    },
    bindAddress: "127.0.0.1",
    localPort: 0,
    remoteHost: "",
    remotePort: 0,
    chainConnections: [],
    sendStatus: () => {},
  });

  const nextServerSocket = () => new Promise((resolve) => {
    tunnelState.server.once("connection", resolve);
  });

  const { port } = tunnelState.server.address();

  // 1) Happy-path SOCKS5 handshake: verify handshake listener is detached before piping.
  const firstServerSocketPromise = nextServerSocket();
  const client = net.createConnection({ host: "127.0.0.1", port });
  t.after(() => client.destroy());
  await new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });

  const serverSocket = await firstServerSocketPromise;
  assert.ok(serverSocket);
  assert.equal(serverSocket.listenerCount("data"), 1, "handshake listener attached before greeting");

  client.write(Buffer.from([0x05, 0x01, 0x00]));
  const greetingReply = await readBytes(client, 2);
  assert.deepEqual(greetingReply, Buffer.from([0x05, 0x00]));

  client.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0x00, 0x50]));
  const connectReply = await readBytes(client, 10);
  assert.equal(connectReply[0], 0x05);
  assert.equal(connectReply[1], 0x00);

  // Only the .pipe(stream) data listener should remain; onHandshakeData must be removed.
  assert.equal(serverSocket.listenerCount("data"), 1, "handshake listener must be detached after onConnect");

  const payload = Buffer.from([0xff, 0x00, 0x01, 0x02, 0x03, 0x04]);
  const receivedOnStream = new Promise((resolve) => {
    streams[0].once("data", resolve);
  });
  client.write(payload);
  assert.deepEqual(await receivedOnStream, payload);
  client.end();

  // 2) Failure-path SOCKS5 handshake: unsupported auth method detaches listener.
  const secondServerSocketPromise = nextServerSocket();
  const badClient = net.createConnection({ host: "127.0.0.1", port });
  t.after(() => badClient.destroy());
  await new Promise((resolve, reject) => {
    badClient.once("connect", resolve);
    badClient.once("error", reject);
  });

  const badServerSocket = await secondServerSocketPromise;
  badClient.write(Buffer.from([0x05, 0x01, 0x02]));
  const badReply = await readBytes(badClient, 2);
  assert.deepEqual(badReply, Buffer.from([0x05, 0xff]));
  assert.equal(badServerSocket.listenerCount("data"), 0, "handshake listener must be detached on failure");
});

test("cleanupScopedMetadata forwards worker SFTP encoding cleanup only when worker is running", async (t) => {
  const sent = [];
  let running = true;
  const bridge = loadFreshMcpBridge();
  t.after(() => bridge.cleanup());

  const clearedPrefixes = [];
  const originalClearByPrefix = sftpBridge.clearSftpEncodingStateByPrefix;
  sftpBridge.clearSftpEncodingStateByPrefix = (prefix) => {
    clearedPrefixes.push(prefix);
    return originalClearByPrefix(prefix);
  };
  t.after(() => {
    sftpBridge.clearSftpEncodingStateByPrefix = originalClearByPrefix;
  });

  bridge.init({
    sessions: new Map(),
    electronModule: null,
    terminalWorkerManager: {
      isRunning: () => running,
      send(channel, payload, options) {
        sent.push({ channel, payload, options });
      },
      request() {
        return Promise.resolve({ ok: true });
      },
    },
  });

  await bridge.cleanupScopedMetadata("chat-active");
  assert.deepEqual(clearedPrefixes, ["chat:chat-active:session:"]);
  const sftpClears = () => sent.filter((entry) => entry.channel === "netcatty:sftp:clearEncodingStateByPrefix");
  assert.deepEqual(sftpClears(), [{
    channel: "netcatty:sftp:clearEncodingStateByPrefix",
    payload: { prefix: "chat:chat-active:session:" },
    options: {},
  }]);

  // When the worker is not running, cleanup must not cold-spawn it via send().
  running = false;
  await bridge.cleanupScopedMetadata("chat-idle");
  assert.deepEqual(clearedPrefixes, [
    "chat:chat-active:session:",
    "chat:chat-idle:session:",
  ]);
  assert.equal(sftpClears().length, 1, "must not send to a stopped terminal worker");
});

test("terminal worker registers netcatty:sftp:clearEncodingStateByPrefix listener", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../terminalWorker/process.cjs"),
    "utf8",
  );
  assert.match(
    source,
    /ipcMain\.on\(\s*["']netcatty:sftp:clearEncodingStateByPrefix["']/,
  );
  assert.match(
    source,
    /sftpBridge\.clearSftpEncodingStateByPrefix\?\.\(payload\.prefix\)/,
  );
});

test("electron main will-quit cleans up fileWatcherBridge", () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../main.cjs"),
    "utf8",
  );
  assert.match(
    source,
    /app\.on\(\s*["']will-quit["'][\s\S]*getFileWatcherBridge\(\)\.cleanup\?\.\(\)/,
  );
});
