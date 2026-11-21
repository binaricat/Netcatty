"use strict";

const { randomUUID } = require("node:crypto");
const net = require("node:net");
const tls = require("node:tls");
const { canonicalizeStreamEndpoint } = require("./byteStreamEndpoint.cjs");
const { openBoundedForwardOut } = require("../bridges/boundedSshChannelOpen.cjs");
const hostKeyVerifier = require("../bridges/hostKeyVerifier.cjs");

// Host-only adapter: authentication uses the established SSH flow, but no
// listener, terminal, shell, startup command, or shared terminal lease exists.
async function openHostByteStream({ sender, connectionOptions, endpoint, signal, assertActive }, bridge) {
  bridge ??= require("../bridges/portForwardingBridge.cjs");
  const target = canonicalizeStreamEndpoint(endpoint);
  const tunnelId = `plugin-stream-${randomUUID()}`;
  const event = { sender };
  let socket;
  let closing;
  const close = () => {
    socket?.destroy();
    hostKeyVerifier.cancelRequestsForSession(tunnelId);
    closing ??= bridge.stopPortForward(event, { tunnelId }).catch(() => {});
    return closing;
  };
  const abort = () => { void close(); };
  signal.throwIfAborted();
  signal.addEventListener("abort", abort, { once: true });
  try {
    await assertActive();
    signal.throwIfAborted();
    const result = await bridge.startPortForward(event, {
      ...connectionOptions, tunnelId, ruleId: undefined,
      type: "local", localPort: 0, bindAddress: "127.0.0.1",
      remoteHost: target.host, remotePort: target.port, reuseTransport: false,
    }, { bindChannels: async ({ conn, tunnelState, chainConnections }) => {
      tunnelState.conn = conn;
      tunnelState.pendingConn = null;
      tunnelState.chainConnections = chainConnections;
      signal.throwIfAborted();
      await assertActive();
      socket = await openBoundedForwardOut(conn, "127.0.0.1", 0, target.host, target.port, { signal, timeoutMs: 10_000 });
      socket.on("error", () => {});
      socket.pause();
      if (target.transport === "tls") {
        socket = tls.connect({ socket, rejectUnauthorized: true, minVersion: "TLSv1.2",
          ...(net.isIP(target.host) ? {} : { servername: target.host }),
          checkServerIdentity: (_name, cert) => tls.checkServerIdentity(target.host, cert),
        });
        await new Promise((resolve, reject) => {
          socket.once("secureConnect", resolve);
          socket.once("error", reject);
          socket.once("close", () => reject(new Error("Host stream TLS connection closed")));
        });
      }
      signal.throwIfAborted();
      await assertActive();
      tunnelState.status = "active";
      return { success: true };
    } });
    if (!result?.success || !socket) throw new Error("Host stream could not connect");
    await assertActive();
    signal.throwIfAborted();
    socket.once("close", () => {
      signal.removeEventListener("abort", abort);
      void close();
    });
    return socket;
  } catch {
    // A cancelled early dial may have published its tunnel after the initial
    // stop; always retry cleanup after start settles.
    socket?.destroy();
    hostKeyVerifier.cancelRequestsForSession(tunnelId);
    await bridge.stopPortForward(event, { tunnelId }).catch(() => {});
    signal.removeEventListener("abort", abort);
    throw new Error("The selected server or destination could not be connected");
  }
}

module.exports = { openHostByteStream };
