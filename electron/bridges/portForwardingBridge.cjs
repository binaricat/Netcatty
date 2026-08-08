/**
 * Port Forwarding Bridge - Handles SSH port forwarding tunnels
 * Extracted from main.cjs for single responsibility
 */

const net = require("node:net");
require("./boringSslDhCompat.cjs").installBoringSslDhCompat();
const { Client: SSHClient } = require("ssh2");
const { NetcattyAgent } = require("./netcattyAgent.cjs");
const keyboardInteractiveHandler = require("./keyboardInteractiveHandler.cjs");
const { connectThroughChain, buildAlgorithms } = require("./sshBridge.cjs");
const { resolveSshConnectionTimeouts } = require("./sshBridge/startSession.cjs");
const hostKeyVerifier = require("./hostKeyVerifier.cjs");
const { createProxySocket, runWhenProxyConnectionReady } = require("./proxyUtils.cjs");
const {
  openBoundedForwardInCallback,
  openBoundedForwardOutCallback,
} = require("./boundedSshChannelOpen.cjs");
const { 
  buildAuthHandler, 
  createKeyboardInteractiveHandler, 
  applyAuthToConnOpts,
  shouldSkipKiPasswordAutoFill,
  findAllDefaultPrivateKeys: findAllDefaultPrivateKeysFromHelper,
  preparePrivateKeyForAuth,
  loadFirstIdentityFileForAuth,
  getAvailableAgentSocket,
  prepareSystemSshAgentForAuth,
  isPassphraseCancelledError,
} = require("./sshAuthHelper.cjs");
const {
  createTransport,
  borrowTransport,
  returnTransport,
  discardTransport,
  findTransportByEndpoint,
  beginTransportDial,
  waitForTransportDial,
  completeTransportDial,
  failTransportDial,
  buildConnectionReuseEndpoint,
  resolveConnectionKeepalivePolicy,
  LEASE_KINDS,
} = require("./sshConnectionPool.cjs");

// Active port forwarding tunnels
const portForwardingTunnels = new Map();

// Process-scoped authority metadata for renderer projections (#2288).
// Epoch changes whenever this module (main or terminal worker) boots.
const PROCESS_EPOCH = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
let runtimeRevision = 0;
/** @type {Map<number, { sender: any, onDestroyed?: () => void }>} */
const runtimeEventSubscribers = new Map();

function bumpRuntimeRevision() {
  runtimeRevision += 1;
  return runtimeRevision;
}

function resolveRuntimePhase(tunnel) {
  if (!tunnel) return "inactive";
  if (tunnel.cleanupInProgress) return "stopping";
  if (tunnel.status === "connecting") return "connecting";
  if (tunnel.status === "error") return "error";
  if (tunnel.status === "active") return "active";
  if (tunnel.status === "inactive") return "inactive";
  return tunnel.status || "active";
}

function toRuntimeRecord(tunnelId, tunnel, revision = runtimeRevision) {
  return {
    ruleId: tunnel?.ruleId,
    tunnelId,
    phase: resolveRuntimePhase(tunnel),
    ...(tunnel?.error ? { error: tunnel.error } : {}),
    cleanupRequired: Boolean(tunnel?.cleanupFailed),
    revision,
    updatedAt: tunnel?.updatedAt || Date.now(),
  };
}

function getPortForwardSnapshot() {
  const records = [];
  for (const [tunnelId, tunnel] of portForwardingTunnels) {
    records.push(toRuntimeRecord(tunnelId, tunnel));
  }
  return {
    epoch: PROCESS_EPOCH,
    revision: runtimeRevision,
    records,
  };
}

function publishRuntimeEvent(event) {
  const payload = {
    epoch: PROCESS_EPOCH,
    revision: runtimeRevision,
    ...event,
  };
  for (const [subscriberId, entry] of runtimeEventSubscribers) {
    const sender = entry?.sender;
    if (sender?.isDestroyed?.()) {
      runtimeEventSubscribers.delete(subscriberId);
      continue;
    }
    safeSend(sender, "netcatty:portforward:runtime", payload);
  }
  return payload;
}

function publishRuntimeUpsert(tunnelId, tunnel) {
  const revision = bumpRuntimeRevision();
  if (tunnel) tunnel.updatedAt = Date.now();
  return publishRuntimeEvent({
    kind: "upsert",
    record: toRuntimeRecord(tunnelId, tunnel, revision),
  });
}

function publishRuntimeRemove(tunnelId, ruleId) {
  bumpRuntimeRevision();
  return publishRuntimeEvent({
    kind: "remove",
    tunnelId,
    ruleId,
  });
}

function subscribePortForwardRuntime(event) {
  const sender = event?.sender;
  if (sender && Number.isSafeInteger(sender.id) && !sender.isDestroyed?.()) {
    const existing = runtimeEventSubscribers.get(sender.id);
    if (existing?.onDestroyed) {
      existing.sender.removeListener?.("destroyed", existing.onDestroyed);
    }
    const onDestroyed = () => {
      runtimeEventSubscribers.delete(sender.id);
    };
    runtimeEventSubscribers.set(sender.id, { sender, onDestroyed });
    sender.once?.("destroyed", onDestroyed);
  }
  // Atomic subscribe + snapshot from the same revision.
  return getPortForwardSnapshot();
}

function unsubscribePortForwardRuntime(event) {
  const sender = event?.sender;
  if (!sender || !Number.isSafeInteger(sender.id)) {
    return { success: true };
  }
  const existing = runtimeEventSubscribers.get(sender.id);
  if (existing?.onDestroyed) {
    existing.sender.removeListener?.("destroyed", existing.onDestroyed);
  }
  runtimeEventSubscribers.delete(sender.id);
  return { success: true };
}

function resetPortForwardRuntimeMetaForTests() {
  runtimeRevision = 0;
  runtimeEventSubscribers.clear();
}

function seedPortForwardTunnelForTests(tunnelId, tunnel) {
  portForwardingTunnels.set(tunnelId, tunnel);
}

function clearPortForwardTunnelsForTests() {
  portForwardingTunnels.clear();
}

function buildPortForwardEndpoint(options = {}) {
  return buildConnectionReuseEndpoint({
    ...options,
    // Port forwarding never requests agent forwarding. Channel reuse remains
    // asymmetric: a ForwardAgent terminal can serve PF, but not vice versa.
    agentForwarding: false,
    protocol: "ssh",
    sftpSudo: false,
  }, { sftpSudo: false });
}

function buildPortForwardEndpointFromStartPayload(payload = {}) {
  return buildPortForwardEndpoint({
    ...payload,
    authType: payload.authType || payload.authMethod,
    keepaliveInterval: payload.resolvedKeepaliveInterval ?? payload.keepaliveInterval,
    keepaliveCountMax: payload.resolvedKeepaliveCountMax ?? payload.keepaliveCountMax,
  });
}

function normalizeRemoteAddress(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (raw === "localhost" || raw === "127.0.0.1" || raw === "::1") return "loopback";
  if (raw === "0.0.0.0" || raw === "::" || raw === "*") return "wildcard";
  return raw;
}

/**
 * When a shared/reused transport dies, tear down local listeners and mark the
 * tunnel inactive so rules can restart without a zombie "active" entry.
 */
function attachSharedTransportLifecycle(tunnelId, tunnelState, conn, sendStatus) {
  if (!conn || !tunnelState) return;
  const onTransportGone = (reason, { discard = false } = {}) => {
    const tunnel = portForwardingTunnels.get(tunnelId) || tunnelState;
    if (!tunnel || tunnel.cancelled || tunnel._sharedLifecycleSettled) return;
    tunnel._sharedLifecycleSettled = true;
    console.log(`[PortForward] Shared transport ${reason} for tunnel ${tunnelId}`);
    detachSharedTransportLifecycle(tunnel);
    if (tunnel.tcpConnectionHandler && tunnel.conn?.removeListener) {
      try { tunnel.conn.removeListener("tcp connection", tunnel.tcpConnectionHandler); } catch { /* ignore */ }
      tunnel.tcpConnectionHandler = null;
    }
    if (tunnel.server) {
      try { tunnel.server.close(); } catch { /* ignore */ }
      tunnel.server = null;
    }
    if (tunnel.sshTransportManaged) {
      try {
        // Errors mean the shared conn may be half-dead; discard so later
        // terminal/SFTP/PF work does not park and reuse a broken socket.
        if (discard && typeof discardTransport === "function") {
          if (tunnel.connRef) {
            discardTransport(tunnel.connRef, "shared-transport-error");
          }
        } else {
          returnTransport(tunnel);
        }
      } catch { /* ignore */ }
      tunnel.sshTransportManaged = false;
    }
    tunnel.conn = null;
    tunnel.connRef = null;
    if (shouldFinalizeTunnelClose(tunnel)) {
      sendStatus?.(discard ? "error" : "inactive", discard ? "shared transport error" : null);
      portForwardingTunnels.delete(tunnelId);
    }
  };
  // Prefer once so a dead socket does not re-enter cleanup. Store handlers so
  // normal cancel can detach them and avoid leaking listeners on long-lived
  // shared transports.
  const onClose = () => onTransportGone("closed");
  const onError = (err) => {
    console.warn(`[PortForward] Shared transport error for ${tunnelId}:`, err?.message || err);
    onTransportGone("error", { discard: true });
  };
  tunnelState._sharedOnClose = onClose;
  tunnelState._sharedOnError = onError;
  try { conn.once("close", onClose); } catch { /* ignore */ }
  try { conn.once("error", onError); } catch { /* ignore */ }
}

function detachSharedTransportLifecycle(tunnel) {
  if (!tunnel?.conn) return;
  if (tunnel._sharedOnClose && tunnel.conn.removeListener) {
    try { tunnel.conn.removeListener("close", tunnel._sharedOnClose); } catch { /* ignore */ }
  }
  if (tunnel._sharedOnError && tunnel.conn.removeListener) {
    try { tunnel.conn.removeListener("error", tunnel._sharedOnError); } catch { /* ignore */ }
  }
  tunnel._sharedOnClose = null;
  tunnel._sharedOnError = null;
}

function isLocalBindFailure(err) {
  const code = String(err?.code || "").toUpperCase();
  const message = String(err?.message || "").toLowerCase();
  return code === "EADDRINUSE"
    || code === "EACCES"
    || code === "EADDRNOTAVAIL"
    || message.includes("eaddrinuse")
    || message.includes("address already in use")
    || message.includes("permission denied")
    || message.includes("listen");
}

function destroyTunnelPipeEndpoint(endpoint) {
  if (!endpoint) return;
  try { endpoint.destroy?.(); } catch { /* ignore */ }
  try { endpoint.close?.(); } catch { /* ignore */ }
  try { endpoint.end?.(); } catch { /* ignore */ }
}

function destroyTunnelPipeEntry(tunnelState, entry) {
  if (!entry || entry.closed) return;
  entry.closed = true;
  const openAbortController = entry.openAbortController;
  entry.openAbortController = null;
  if (openAbortController && !openAbortController.signal.aborted) {
    try { openAbortController.abort(new Error("Port forward client closed during SSH channel open")); } catch { /* ignore */ }
  }
  try { tunnelState?.activePipes?.delete(entry); } catch { /* ignore */ }
  destroyTunnelPipeEndpoint(entry.socket);
  destroyTunnelPipeEndpoint(entry.stream);
}

function attachTunnelPipeStream(tunnelState, entry, stream) {
  if (!entry || entry.closed || isTunnelCancelled(tunnelState)) {
    destroyTunnelPipeEndpoint(entry?.socket);
    destroyTunnelPipeEndpoint(stream);
    if (entry) destroyTunnelPipeEntry(tunnelState, entry);
    return false;
  }
  entry.openAbortController = null;
  entry.stream = stream;
  const drop = () => destroyTunnelPipeEntry(tunnelState, entry);
  try { stream?.once?.("close", drop); } catch { /* ignore */ }
  try { stream?.once?.("error", drop); } catch { /* ignore */ }
  return true;
}

function trackTunnelPipe(tunnelState, socket, stream = null) {
  if (!tunnelState) return null;
  if (!(tunnelState.activePipes instanceof Set)) tunnelState.activePipes = new Set();
  const entry = {
    socket,
    stream: null,
    closed: false,
    openAbortController: stream ? null : new AbortController(),
  };
  tunnelState.activePipes.add(entry);
  const drop = () => destroyTunnelPipeEntry(tunnelState, entry);
  try { socket?.once?.("close", drop); } catch { /* ignore */ }
  try { socket?.once?.("error", drop); } catch { /* ignore */ }
  if (stream) attachTunnelPipeStream(tunnelState, entry, stream);
  return entry;
}

function destroyTunnelPipes(tunnel) {
  if (!(tunnel?.activePipes instanceof Set)) return;
  for (const entry of [...tunnel.activePipes]) {
    destroyTunnelPipeEntry(tunnel, entry);
  }
  tunnel.activePipes.clear();
}

/**
 * Release SSH for a tunnel: if the tunnel holds a transport lease, return it
 * (may idle-park). Otherwise end the dedicated Client as before.
 */
function releaseTunnelSsh(tunnel) {
  if (!tunnel) return;
  if (tunnel.sshTransportManaged) {
    try {
      returnTransport(tunnel);
    } catch {
      /* ignore */
    }
    tunnel.conn = null;
    tunnel.chainConnections = [];
    tunnel.sshTransportManaged = false;
    return;
  }
  if (Array.isArray(tunnel.chainConnections)) {
    cleanupChainConnections(tunnel.chainConnections);
    tunnel.chainConnections = [];
  }
  if (tunnel.conn) {
    try { tunnel.conn.end(); } catch { /* ignore */ }
    tunnel.conn = null;
  }
}

/**
 * Register an authenticated SSH connection as a shared transport + forward lease.
 * Lets terminal/SFTP later borrow the same conn; stop returns the lease only.
 */
function attachForwardTransportLease(tunnel, conn, chainConnections, endpoint) {
  if (!tunnel || !conn) return null;
  const transport = createTransport({
    conn,
    chainConnections: Array.isArray(chainConnections) ? chainConnections : [],
    endpoint,
  });
  borrowTransport(transport, {
    kind: LEASE_KINDS.forward,
    holder: tunnel,
    leaseId: `forward:${tunnel.tunnelId || tunnel.id || "unknown"}`,
    meta: { source: "port-forward" },
  });
  tunnel.sshTransportManaged = true;
  tunnel.conn = conn;
  // Chain is owned by the transport registry now.
  tunnel.chainConnections = [];
  return transport;
}

/** Max wait for remote-side unforwardIn before treating the listen as stuck. */
const UNFORWARD_TIMEOUT_MS = 5_000;
const REMOTE_FORWARD_START_CLEANUP_TIMEOUT_MS = 5_000;

/**
 * Force-end a shared transport after unforward failure/timeout so a remote
 * listen cannot stay exposed while the lease is only returned (parked).
 */
function discardUnforwardTransport(conn, transport, reason) {
  try {
    if (transport && typeof discardTransport === "function") {
      discardTransport(transport, reason);
    } else if (conn) {
      try { conn.end(); } catch { /* ignore */ }
    }
  } catch { /* ignore discard errors */ }
}

/**
 * Cancel a remote forward listen and wait for the ssh2 callback.
 * On timeout, callback error, or throw, discard the shared transport so a
 * half-open remote listen cannot be idle-parked for another session to reuse.
 *
 * @param {object|null} conn
 * @param {string} bindAddress
 * @param {number} port
 * @param {object|null} [transport] transport registry entry (connRef) when known
 * @returns {Promise<{ ok: boolean, timedOut?: boolean, discarded?: boolean, error?: Error }>}
 */
function unforwardRemoteListen(conn, bindAddress, port, transport = null) {
  return new Promise((resolve) => {
    if (!conn || typeof conn.unforwardIn !== "function") {
      resolve({ ok: true });
      return;
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      console.warn(
        `[PortForward] unforwardIn timed out after ${UNFORWARD_TIMEOUT_MS}ms`
        + ` for ${bindAddress}:${port}; discarding transport`,
      );
      discardUnforwardTransport(conn, transport, "unforward-timeout");
      finish({
        ok: false,
        timedOut: true,
        discarded: true,
        error: new Error(`unforwardIn timed out after ${UNFORWARD_TIMEOUT_MS}ms`),
      });
    }, UNFORWARD_TIMEOUT_MS);
    try { timer.unref?.(); } catch { /* ignore */ }
    try {
      conn.unforwardIn(bindAddress, port, (err) => {
        clearTimeout(timer);
        if (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          console.warn(
            `[PortForward] unforwardIn failed for ${bindAddress}:${port}; discarding transport:`,
            error.message,
          );
          // Server did not confirm listen removal — do not park the shared conn.
          discardUnforwardTransport(conn, transport, "unforward-error");
          finish({ ok: false, discarded: true, error });
          return;
        }
        finish({ ok: true });
      });
    } catch (syncErr) {
      clearTimeout(timer);
      const error = syncErr instanceof Error ? syncErr : new Error(String(syncErr));
      console.warn(
        `[PortForward] unforwardIn threw for ${bindAddress}:${port}; discarding transport:`,
        error.message,
      );
      discardUnforwardTransport(conn, transport, "unforward-throw");
      finish({ ok: false, discarded: true, error });
    }
  });
}

function settleRemoteForwardStart(tunnel, outcome) {
  tunnel._remoteForwardOutcome = outcome;
  tunnel.pendingRemoteForward = false;
  const resolve = tunnel._resolveRemoteForwardStart;
  tunnel._resolveRemoteForwardStart = null;
  resolve?.(outcome);
}

function waitForRemoteForwardStart(tunnel) {
  if (!tunnel?.pendingRemoteForward) {
    return Promise.resolve(tunnel?._remoteForwardOutcome || { ok: false });
  }
  const pending = tunnel._remoteForwardStartPromise;
  if (!pending) return Promise.resolve({ ok: false });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const configuredTimeoutMs = Number(tunnel?._remoteForwardStartCleanupTimeoutMs);
    const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs >= 0
      ? configuredTimeoutMs
      : REMOTE_FORWARD_START_CLEANUP_TIMEOUT_MS;
    const timer = setTimeout(() => finish({ ok: false, timedOut: true }), timeoutMs);
    timer.unref?.();
    pending.then(finish, (error) => finish({ ok: false, error }));
  });
}

function unforwardRemoteListenOnce(tunnel, conn, bindAddress, port, transport = null) {
  if (tunnel._remoteUnforwardPromise) return tunnel._remoteUnforwardPromise;
  if (tunnel._remoteUnforwardDone) {
    return Promise.resolve(tunnel._remoteUnforwardResult || { ok: true });
  }
  const promise = unforwardRemoteListen(conn, bindAddress, port, transport)
    .then((result) => {
      tunnel._remoteUnforwardDone = true;
      tunnel._remoteUnforwardResult = result;
      return result;
    });
  tunnel._remoteUnforwardPromise = promise;
  return promise;
}

/**
 * Bind local/remote/dynamic forwarding onto an already-authenticated conn.
 * Used for both shared-transport and post-dial paths.
 */
function bindPortForwardChannels({
  type,
  conn,
  tunnelId,
  tunnelState,
  sender,
  bindAddress,
  localPort,
  remoteHost,
  remotePort,
  chainConnections,
  sendStatus,
  releaseOnError = false,
  endpoint = null,
  registerTransport = false,
  dialCoordination = null,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      const message = err?.message || String(err);
      sendStatus?.("error", message);
      // Post-bind listener errors: start promise may already be resolved, so
      // always demote the tunnel so restart cannot reuse a zombie "active" entry.
      try { destroyTunnelPipes(tunnelState); } catch { /* ignore */ }
      if (tunnelState.server) {
        try { tunnelState.server.close(); } catch { /* ignore */ }
        tunnelState.server = null;
      }
      // Detach shared lifecycle while conn is still on the tunnel — release
      // clears conn and would make detach a no-op, leaking close/error listeners
      // on long-lived shared transports after EADDRINUSE etc.
      try { detachSharedTransportLifecycle(tunnelState); } catch { /* ignore */ }
      // Always release a managed lease (shared reuse or newly registered).
      // Otherwise a dedicated dial that registered into the pool can orphan
      // its transport after a post-bind listener error.
      if (tunnelState.sshTransportManaged || releaseOnError) {
        releaseTunnelSsh(tunnelState);
      } else {
        try { conn.end(); } catch { /* ignore */ }
        cleanupChainConnections(chainConnections);
      }
      tunnelState.status = "error";
      tunnelState.error = message;
      if (shouldFinalizeTunnelClose(tunnelState)) {
        portForwardingTunnels.delete(tunnelId);
      }
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    if (type === "local") {
      const server = net.createServer((socket) => {
        const pipeEntry = trackTunnelPipe(tunnelState, socket);
        openBoundedForwardOutCallback(
          conn,
          bindAddress,
          localPort,
          remoteHost,
          remotePort,
          (err, stream) => {
            if (err) {
              console.error(`[PortForward] Forward error:`, err.message);
              destroyTunnelPipeEntry(tunnelState, pipeEntry);
              return;
            }
            if (!attachTunnelPipeStream(tunnelState, pipeEntry, stream)) return;
            socket.pipe(stream).pipe(socket);
            socket.on("error", (e) => console.warn("[PortForward] Socket error:", e.message));
            stream.on("error", (e) => console.warn("[PortForward] Stream error:", e.message));
          },
          { signal: pipeEntry?.openAbortController?.signal },
        );
      });

      server.on("error", (err) => {
        console.error(`[PortForward] Server error:`, err.message);
        fail(err);
      });

      server.listen(localPort, bindAddress, () => {
        console.log(`[PortForward] Local forwarding active: ${bindAddress}:${localPort} -> ${remoteHost}:${remotePort}`);
        try {
          // User may have cancelled while listen was pending (shared transport
          // path). Do not resurrect a stopped tunnel or leave the port open.
          if (isTunnelCancelled(tunnelState)) {
            try { server.close(); } catch { /* ignore */ }
            try { destroyTunnelPipes(tunnelState); } catch { /* ignore */ }
            settled = true;
            resolve({ tunnelId, success: false, cancelled: true });
            return;
          }
          tunnelState.type = "local";
          tunnelState.conn = conn;
          tunnelState.server = server;
          tunnelState.chainConnections = chainConnections;
          tunnelState.status = "active";
          tunnelState.webContentsId = sender.id;
          tunnelState.pendingConn = null;
          if (registerTransport && endpoint && !tunnelState.sshTransportManaged) {
            const transport = attachForwardTransportLease(tunnelState, conn, chainConnections, endpoint);
            if (dialCoordination && transport) completeTransportDial(dialCoordination, transport);
          }
          portForwardingTunnels.set(tunnelId, tunnelState);
          sendStatus?.("active");
          settled = true;
          resolve({ tunnelId, success: true });
        } catch (regErr) {
          try { server.close(); } catch { /* ignore */ }
          fail(regErr);
        }
      });
      return;
    }

    if (type === "remote") {
      // Filter by destPort so multiple remote forwards on a shared transport
      // do not accept each other's connections. Attach only after forwardIn
      // succeeds; remove on cancel.
      const onTcpConnection = (info, accept, rejectConn) => {
        // Match listen bind + port so two remote forwards on the same transport
        // with the same port but different bind addresses do not steal each other.
        const destPort = Number(info?.destPort);
        if (destPort !== Number(localPort)) return;
        const destNorm = normalizeRemoteAddress(info?.destIP);
        const bindNorm = normalizeRemoteAddress(bindAddress || "127.0.0.1");
        // Wildcard binds accept any destIP (ssh2 reports the concrete NIC).
        // Loopback binds accept localhost / 127.0.0.1 / ::1 interchangeably.
        if (bindNorm !== "wildcard" && destNorm && destNorm !== bindNorm) return;
        let stream;
        try {
          stream = accept();
        } catch (acceptErr) {
          console.warn("[PortForward] accept failed:", acceptErr?.message || acceptErr);
          try { rejectConn?.(); } catch { /* ignore */ }
          return;
        }
        const socket = net.connect(remotePort, remoteHost || "127.0.0.1", () => {
          stream.pipe(socket).pipe(stream);
        });
        trackTunnelPipe(tunnelState, socket, stream);
        socket.on("error", (e) => {
          console.warn("[PortForward] Local socket error:", e.message);
          stream.end();
        });
        stream.on("error", (e) => {
          console.warn("[PortForward] Remote stream error:", e.message);
          socket.end();
        });
      };

      // Record remote bind target *before* forwardIn so cancel-during-listen can
      // always unforward or discard — localPort is not only set on success.
      tunnelState.type = "remote";
      tunnelState.bindAddress = bindAddress;
      tunnelState.localPort = localPort;
      tunnelState.remoteHost = remoteHost;
      tunnelState.remotePort = remotePort;
      tunnelState.pendingRemoteForward = true;
      tunnelState.conn = conn;
      tunnelState._remoteForwardOutcome = null;
      tunnelState._remoteForwardStartPromise = new Promise((resolve) => {
        tunnelState._resolveRemoteForwardStart = resolve;
      });
      tunnelState.remoteForwardAbortController = new AbortController();

      openBoundedForwardInCallback(conn, bindAddress, localPort, (err) => {
        tunnelState.remoteForwardAbortController = null;
        settleRemoteForwardStart(tunnelState, err ? { ok: false, error: err } : { ok: true });
        if (err) {
          if (isTunnelCancelled(tunnelState)) {
            settled = true;
            resolve({ tunnelId, success: false, cancelled: true });
            return;
          }
          console.error(`[PortForward] Remote forward error:`, err.message);
          fail(err);
          return;
        }

        console.log(`[PortForward] Remote forwarding active: remote ${bindAddress}:${localPort} -> local ${remoteHost}:${remotePort}`);
        // Async cleanup paths must not leave remote listens fire-and-forget when
        // cancel races forwardIn on a shared transport.
        void (async () => {
          try {
            if (isTunnelCancelled(tunnelState)) {
              const transport = tunnelState.connRef || null;
              const unfwd = await unforwardRemoteListenOnce(
                tunnelState,
                conn,
                bindAddress,
                localPort,
                transport,
              );
              if (unfwd.discarded || unfwd.timedOut) {
                // Transport already discarded; drop local refs so release does
                // not try to park a dead shared conn.
                tunnelState.sshTransportManaged = false;
                tunnelState.conn = null;
                tunnelState.connRef = null;
              }
              settled = true;
              resolve({ tunnelId, success: false, cancelled: true });
              return;
            }
            tunnelState.server = null;
            tunnelState.tcpConnectionHandler = onTcpConnection;
            tunnelState.chainConnections = chainConnections;
            tunnelState.status = "active";
            tunnelState.webContentsId = sender.id;
            tunnelState.pendingConn = null;
            conn.on("tcp connection", onTcpConnection);
            if (registerTransport && endpoint && !tunnelState.sshTransportManaged) {
              const transport = attachForwardTransportLease(tunnelState, conn, chainConnections, endpoint);
              if (dialCoordination && transport) completeTransportDial(dialCoordination, transport);
            }
            portForwardingTunnels.set(tunnelId, tunnelState);
            sendStatus?.("active");
            settled = true;
            resolve({ tunnelId, success: true });
          } catch (regErr) {
            try { conn.removeListener("tcp connection", onTcpConnection); } catch { /* ignore */ }
            const transport = tunnelState.connRef || null;
            const unfwd = await unforwardRemoteListenOnce(
              tunnelState,
              conn,
              bindAddress,
              localPort,
              transport,
            );
            if (unfwd.discarded || unfwd.timedOut) {
              tunnelState.sshTransportManaged = false;
              tunnelState.conn = null;
              tunnelState.connRef = null;
            }
            fail(regErr);
          }
        })();
      }, { signal: tunnelState.remoteForwardAbortController.signal });
      return;
    }

    if (type === "dynamic") {
      const server = net.createServer((socket) => {
        const pipeEntry = trackTunnelPipe(tunnelState, socket);
        socket.once("data", (data) => {
          if (data[0] !== 0x05) {
            socket.end();
            return;
          }
          socket.write(Buffer.from([0x05, 0x00]));
          socket.once("data", (request) => {
            if (request[0] !== 0x05 || request[1] !== 0x01) {
              socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
              socket.end();
              return;
            }

            let targetHost;
            let targetPort;
            const addressType = request[3];

            if (addressType === 0x01) {
              targetHost = `${request[4]}.${request[5]}.${request[6]}.${request[7]}`;
              targetPort = request.readUInt16BE(8);
            } else if (addressType === 0x03) {
              const domainLength = request[4];
              targetHost = request.slice(5, 5 + domainLength).toString();
              targetPort = request.readUInt16BE(5 + domainLength);
            } else if (addressType === 0x04) {
              socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
              socket.end();
              return;
            } else {
              socket.write(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
              socket.end();
              return;
            }

            openBoundedForwardOutCallback(
              conn,
              bindAddress,
              0,
              targetHost,
              targetPort,
              (err, stream) => {
                if (err) {
                  socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                  socket.end();
                  return;
                }
                if (!attachTunnelPipeStream(tunnelState, pipeEntry, stream)) return;
                const reply = Buffer.alloc(10);
                reply[0] = 0x05;
                reply[1] = 0x00;
                reply[2] = 0x00;
                reply[3] = 0x01;
                reply.writeUInt16BE(0, 8);
                socket.write(reply);
                socket.pipe(stream).pipe(socket);
                socket.on("error", () => stream.end());
                stream.on("error", () => socket.end());
              },
              { signal: pipeEntry?.openAbortController?.signal },
            );
          });
        });
      });

      server.on("error", (err) => {
        console.error(`[PortForward] SOCKS server error:`, err.message);
        fail(err);
      });

      server.listen(localPort, bindAddress, () => {
        console.log(`[PortForward] Dynamic SOCKS5 proxy active on ${bindAddress}:${localPort}`);
        try {
          if (isTunnelCancelled(tunnelState)) {
            try { server.close(); } catch { /* ignore */ }
            try { destroyTunnelPipes(tunnelState); } catch { /* ignore */ }
            settled = true;
            resolve({ tunnelId, success: false, cancelled: true });
            return;
          }
          tunnelState.type = "dynamic";
          tunnelState.conn = conn;
          tunnelState.server = server;
          tunnelState.chainConnections = chainConnections;
          tunnelState.status = "active";
          tunnelState.webContentsId = sender.id;
          tunnelState.pendingConn = null;
          if (registerTransport && endpoint && !tunnelState.sshTransportManaged) {
            const transport = attachForwardTransportLease(tunnelState, conn, chainConnections, endpoint);
            if (dialCoordination && transport) completeTransportDial(dialCoordination, transport);
          }
          portForwardingTunnels.set(tunnelId, tunnelState);
          sendStatus?.("active");
          settled = true;
          resolve({ tunnelId, success: true });
        } catch (regErr) {
          try { server.close(); } catch { /* ignore */ }
          fail(regErr);
        }
      });
      return;
    }

    reject(new Error(`Unknown forwarding type: ${type}`));
  });
}

function cleanupChainConnections(connections) {
  if (!Array.isArray(connections)) return;
  for (const chainConn of connections) {
    try { chainConn.end(); } catch { /* ignore */ }
  }
}

function isTunnelCancelled(tunnelState) {
  return Boolean(tunnelState?.cancelled);
}

function isReusableTunnelStatus(status) {
  return status === 'active' || status === 'connecting';
}

function publishTunnelStatus(tunnelId, tunnel, status, error = null) {
  if (!tunnel) return;
  tunnel.status = status;
  tunnel.error = error || undefined;
  tunnel.updatedAt = Date.now();
  const runtimeEvent = publishRuntimeUpsert(tunnelId, tunnel);
  const subscribers = tunnel.subscribers instanceof Map
    ? Array.from(tunnel.subscribers.entries())
    : [];
  for (const [subscriberId, subscriber] of subscribers) {
    if (subscriber?.isDestroyed?.()) {
      tunnel.subscribers.delete(subscriberId);
      continue;
    }
    safeSend(subscriber, "netcatty:portforward:status", {
      tunnelId,
      status,
      error,
      ruleId: tunnel.ruleId,
      epoch: runtimeEvent.epoch,
      revision: runtimeEvent.revision,
      cleanupRequired: Boolean(tunnel.cleanupFailed),
    });
  }
}

function shouldFinalizeTunnelClose(tunnel) {
  return !tunnel?.cleanupFailed && !tunnel?.cleanupInProgress;
}

async function cancelTunnel(tunnelId, tunnel, sendStatus, { deleteEntry = false } = {}) {
  if (!tunnel) return;
  const errors = [];
  const cleanup = (label, action) => {
    try {
      action();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${label}: ${message}`);
      return false;
    }
  };
  tunnel.cancelled = true;
  tunnel.cleanupInProgress = true;
  keyboardInteractiveHandler.cancelRequestsForSession(tunnelId, "tunnel-stopped");
  // Destroy accepted sockets/streams so traffic cannot outlive the tunnel on a
  // shared transport held by another session or long idle park.
  cleanup("active forwarded pipes", () => destroyTunnelPipes(tunnel));
  if (tunnel.server) {
    if (cleanup('server', () => tunnel.server.close())) tunnel.server = null;
  }
  if (tunnel.passphraseAbortController && !tunnel.passphraseAbortController.signal.aborted) {
    cleanup('passphrase prompt', () => tunnel.passphraseAbortController.abort());
  }
  if (tunnel.transportWaitAbortController && !tunnel.transportWaitAbortController.signal.aborted) {
    cleanup('shared SSH wait', () => tunnel.transportWaitAbortController.abort(
      new Error("Port forward connection cancelled"),
    ));
  }
  if (tunnel.remoteForwardAbortController && !tunnel.remoteForwardAbortController.signal.aborted) {
    const transport = tunnel.connRef || null;
    const abortedRemoteOpen = cleanup('remote forward open', () => tunnel.remoteForwardAbortController.abort(
      new Error("Port forward connection cancelled"),
    ));
    if (abortedRemoteOpen) {
      // forwardIn has no request-level cancellation in ssh2. The bounded open
      // invalidates the physical connection so its retained callback cannot
      // accumulate. Drop the tunnel's references as well: release cleanup must
      // not end the same dedicated client twice or return the dead shared
      // transport to the pool.
      if (transport && typeof discardTransport === "function") {
        cleanup('remote forward transport', () => discardTransport(
          transport,
          "pending-remote-forward-cancel",
        ));
      }
      tunnel._remoteForwardTransportInvalidated = true;
      tunnel.sshTransportManaged = false;
      tunnel.conn = null;
      tunnel.connRef = null;
    }
  }
  if (tunnel.pendingConn) {
    if (cleanup('pending SSH connection', () => tunnel.pendingConn.end())) tunnel.pendingConn = null;
  }
  // Detach shared-transport lifecycle + remote tcp filters first so long-lived
  // shared connections do not accumulate close/error listeners across restarts.
  cleanup("shared transport lifecycle", () => detachSharedTransportLifecycle(tunnel));
  if (tunnel.tcpConnectionHandler && tunnel.conn?.removeListener) {
    cleanup("remote tcp handler", () => {
      tunnel.conn.removeListener("tcp connection", tunnel.tcpConnectionHandler);
      tunnel.tcpConnectionHandler = null;
    });
  }
  if (tunnel.pendingRemoteForward && tunnel._remoteForwardStartPromise) {
    const startOutcome = await waitForRemoteForwardStart(tunnel);
    if (tunnel._remoteForwardTransportInvalidated) {
      tunnel.pendingRemoteForward = false;
    }
    if (startOutcome?.timedOut) {
      const transport = tunnel.connRef || null;
      discardUnforwardTransport(
        tunnel.conn,
        transport,
        "pending-remote-forward-timeout",
      );
      tunnel._remoteForwardOutcome = startOutcome;
      tunnel._remoteUnforwardDone = true;
      tunnel._remoteUnforwardResult = { ok: true, discarded: true, timedOut: true };
      tunnel.pendingRemoteForward = false;
      tunnel.sshTransportManaged = false;
      tunnel.conn = null;
      tunnel.connRef = null;
    }
  }
  // Remote forwards leave a server-side listen until unforwardIn succeeds.
  // Also cover cancel-during-forwardIn: bind target is recorded before the
  // ssh2 callback so we never skip unforward just because status was still
  // "connecting".
  if (
    (tunnel.type === "remote" || tunnel.pendingRemoteForward)
    && tunnel.conn
    && typeof tunnel.conn.unforwardIn === "function"
    && Number.isFinite(tunnel.localPort)
    && !tunnel._remoteUnforwardDone
    && (
      tunnel._remoteForwardOutcome?.ok === true
      || !tunnel._remoteForwardStartPromise
    )
  ) {
    const bind = tunnel.bindAddress || "127.0.0.1";
    const port = tunnel.localPort;
    const unfwd = await unforwardRemoteListenOnce(
      tunnel,
      tunnel.conn,
      bind,
      port,
      tunnel.connRef || null,
    );
    tunnel.pendingRemoteForward = false;
    if (unfwd.discarded || unfwd.timedOut) {
      // Transport already discarded inside the helper; clear local refs so
      // releaseTunnelSsh does not try to park a dead shared conn.
      tunnel.sshTransportManaged = false;
      tunnel.conn = null;
      tunnel.connRef = null;
    }
    if (!unfwd.ok) {
      const message = unfwd.error?.message || String(unfwd.error || "unforward failed");
      // Still record the failure for the caller; remote listen state is unclean.
      errors.push(`remote forward listen: ${message}`);
    }
  } else if (tunnel.pendingRemoteForward && tunnel.sshTransportManaged) {
    // Pending remote bind without a known port (should not happen after the
    // pre-record above) — discard rather than park an uncertain listen.
    try {
      const transport = tunnel.connRef || null;
      if (transport && typeof discardTransport === "function") {
        discardTransport(transport, "pending-remote-forward-cancel");
      }
      tunnel.sshTransportManaged = false;
      tunnel.conn = null;
      tunnel.connRef = null;
    } catch { /* ignore */ }
    tunnel.pendingRemoteForward = false;
  }
  // Keep cleaning the SSH connection even when an earlier resource (for
  // example the local listener) failed to close. Throw only after every
  // independent cleanup step has had a chance to run; otherwise a listener
  // error strands the underlying SSH socket indefinitely.
  if (tunnel.sshTransportManaged) {
    if (cleanup('SSH transport lease', () => releaseTunnelSsh(tunnel))) {
      /* lease returned */
    }
  } else {
    if (Array.isArray(tunnel.chainConnections)) {
      tunnel.chainConnections = tunnel.chainConnections.filter((chainConn, index) => (
        !cleanup(`jump connection ${index + 1}`, () => chainConn.end())
      ));
    }
    if (tunnel.conn) {
      if (cleanup('SSH connection', () => tunnel.conn.end())) tunnel.conn = null;
    }
  }
  if (errors.length > 0) {
    const error = errors.join('; ');
    tunnel.status = 'error';
    tunnel.error = error;
    tunnel.cleanupFailed = true;
    tunnel.cleanupInProgress = false;
    sendStatus?.('error', error);
    throw new Error(error);
  }
  tunnel.status = 'inactive';
  tunnel.cleanupFailed = false;
  tunnel.cleanupInProgress = false;
  sendStatus?.('inactive');
  if (deleteEntry) {
    const ruleId = tunnel.ruleId;
    portForwardingTunnels.delete(tunnelId);
    // Removal is a distinct revision after the inactive upsert so subscribers
    // can detect delete vs retained error records (cleanupRequired).
    publishRuntimeRemove(tunnelId, ruleId);
  }
}

const { safeSend } = require("./ipcUtils.cjs");

/**
 * Start a port forwarding tunnel
 */
async function startPortForward(event, payload) {
  const {
    ruleId,
    tunnelId,
    type, // 'local' | 'remote' | 'dynamic'
    localPort,
    bindAddress = '127.0.0.1',
    remoteHost,
    remotePort,
    hostname,
    hostId,
    port = 22,
    username,
    authMethod,
    authPolicyVersion,
    requiresMfa,
    password,
    privateKey,
    publicKey,
    certificate,
    keyId,
    passphrase,
    knownHosts,
    verifyHostKeys,
    proxy,
    jumpHosts = [],
    identityFilePaths,
    useSshAgent,
    agentPublicKeys,
    identityAgent,
    identitiesOnly,
    addKeysToAgent,
    useKeychain,
    legacyAlgorithms,
    skipEcdsaHostKey,
    algorithmOverrides,
    keepaliveInterval: resolvedKeepaliveInterval,
    keepaliveCountMax: resolvedKeepaliveCountMax,
    sshTcpConnectTimeoutMs,
    sshAuthReadyTimeoutMs,
    reuseTransport = true,
  } = payload;

  // The rule is the durable identity; tunnelId is only one renderer's
  // attempt. Reuse an in-flight/live tunnel so two windows cannot create
  // duplicate listeners for the same saved rule.
  if (ruleId) {
    for (const [existingTunnelId, existingTunnel] of portForwardingTunnels) {
      if (existingTunnel.ruleId !== ruleId) continue;
      if (existingTunnel.cancelled) {
        if (existingTunnel.cleanupFailed) {
          return {
            tunnelId: existingTunnelId,
            success: false,
            blockedByCleanup: true,
            error: 'The existing tunnel could not be cleaned up. Stop it successfully before restarting.',
          };
        }
        continue;
      }
      if (!isReusableTunnelStatus(existingTunnel.status)) {
        return {
          tunnelId: existingTunnelId,
          success: false,
          error: existingTunnel.error || 'The existing tunnel is no longer reusable.',
        };
      }
      if (!(existingTunnel.subscribers instanceof Map)) {
        existingTunnel.subscribers = new Map();
      }
      existingTunnel.subscribers.set(event.sender.id, event.sender);
      return {
        tunnelId: existingTunnelId,
        success: true,
        reused: true,
        status: existingTunnel.status || 'active',
      };
    }
  }

  const connectionTimeouts = resolveSshConnectionTimeouts({
    sshTcpConnectTimeoutMs,
    sshAuthReadyTimeoutMs,
  });

  const sender = event.sender;
  const hasJumpHosts = jumpHosts.length > 0;
  const hasProxy = !!proxy;
  let chainConnections = [];
  let connectionSocket = null;
  const passphraseAbortController = new AbortController();
  const transportWaitAbortController = new AbortController();
  const tunnelState = {
    type,
    tunnelId,
    conn: null,
    pendingConn: null,
    server: null,
    chainConnections,
    passphraseAbortController,
    ruleId,
    status: 'connecting',
    webContentsId: sender.id,
    subscribers: new Map([[sender.id, sender]]),
    cancelled: false,
    sshTransportManaged: false,
  };
  const sendStatus = (status, error = null) => {
    publishTunnelStatus(tunnelId, tunnelState, status, error);
  };
  // Publish before waiting for another opener's physical dial. A stop request
  // must be able to find and cancel this waiter immediately.
  portForwardingTunnels.set(tunnelId, tunnelState);
  sendStatus('connecting');
  const reuseEndpoint = buildPortForwardEndpointFromStartPayload(payload);

  // Atomically join a compatible physical dial when no authenticated
  // transport exists yet. Explicitly dedicated forwards remain isolated and
  // are not published into the shared pool.
  let pendingDialCoordination = null;
  let existingTransport = reuseTransport !== false
    ? findTransportByEndpoint(reuseEndpoint)
    : null;
  try {
    if (!existingTransport && reuseTransport !== false && typeof beginTransportDial === "function") {
      const coordination = beginTransportDial(reuseEndpoint, { kind: "channel" });
      if (coordination.role === "reuse") {
        existingTransport = coordination.transport;
      } else if (coordination.role === "join") {
        tunnelState.transportWaitAbortController = transportWaitAbortController;
        existingTransport = await waitForTransportDial(coordination, {
          signal: transportWaitAbortController.signal,
        });
        tunnelState.transportWaitAbortController = null;
      } else {
        pendingDialCoordination = coordination;
      }
    }
  } catch (error) {
    if (isTunnelCancelled(tunnelState) || transportWaitAbortController.signal.aborted) {
      portForwardingTunnels.delete(tunnelId);
      return { tunnelId, success: false, cancelled: true };
    }
    portForwardingTunnels.delete(tunnelId);
    sendStatus('error', error?.message || String(error));
    throw error;
  }
  if (isTunnelCancelled(tunnelState)) {
    portForwardingTunnels.delete(tunnelId);
    return { tunnelId, success: false, cancelled: true };
  }
  const abandonPendingDial = (reason) => {
    if (!pendingDialCoordination) return;
    failTransportDial(
      pendingDialCoordination,
      reason instanceof Error ? reason : new Error(String(reason || "Port forward connection cancelled")),
    );
  };

  // Prefer an already-authenticated transport (live terminal or idle park).
  if (existingTransport?.conn) {
    tunnelState.conn = existingTransport.conn;
    tunnelState.chainConnections = [];
    portForwardingTunnels.set(tunnelId, tunnelState);
    try {
      borrowTransport(existingTransport, {
        kind: LEASE_KINDS.forward,
        holder: tunnelState,
        leaseId: `forward:${tunnelId}`,
        meta: { source: "port-forward-shared" },
      });
      tunnelState.sshTransportManaged = true;
      console.log(`[PortForward] Reusing shared SSH transport for tunnel ${tunnelId}`);
      // Attach before bind so a mid-listen transport drop cannot leave a zombie
      // local/dynamic server without close/error teardown.
      attachSharedTransportLifecycle(tunnelId, tunnelState, existingTransport.conn, sendStatus);
      let sharedResult;
      try {
        sharedResult = await bindPortForwardChannels({
          type,
          conn: existingTransport.conn,
          tunnelId,
          tunnelState,
          sender,
          bindAddress,
          localPort,
          remoteHost,
          remotePort,
          chainConnections: [],
          sendStatus,
          releaseOnError: true,
        });
      } catch (bindErr) {
        try { detachSharedTransportLifecycle(tunnelState); } catch { /* ignore */ }
        throw bindErr;
      }
      if (!sharedResult?.success) {
        // Cancelled / failed bind: drop lifecycle so we do not keep listeners on
        // a tunnel that will not become active.
        try { detachSharedTransportLifecycle(tunnelState); } catch { /* ignore */ }
      }
      return sharedResult;
    } catch (shareErr) {
      // Local bind failures (port in use, permission) cannot be fixed by a new
      // SSH dial — re-auth would only re-prompt MFA. Only retry dedicated when
      // the shared transport itself looks unusable.
      if (isLocalBindFailure(shareErr)) {
        console.warn(
          `[PortForward] Shared transport bind failed for ${hostname} (local bind); not retrying dedicated:`,
          shareErr?.message || shareErr,
        );
        try { detachSharedTransportLifecycle(tunnelState); } catch { /* ignore */ }
        try { returnTransport(tunnelState); } catch { /* ignore */ }
        portForwardingTunnels.delete(tunnelId);
        sendStatus("error", shareErr?.message || String(shareErr));
        return {
          tunnelId,
          success: false,
          error: shareErr?.message || String(shareErr),
        };
      }
      console.warn(
        `[PortForward] Shared transport bind failed for ${hostname}; dialing dedicated:`,
        shareErr?.message || shareErr,
      );
      try { detachSharedTransportLifecycle(tunnelState); } catch { /* ignore */ }
      try { returnTransport(tunnelState); } catch { /* ignore */ }
      portForwardingTunnels.delete(tunnelId);
      tunnelState.conn = null;
      tunnelState.sshTransportManaged = false;
      // Fall through to a dedicated dial.
    }
  }

  const conn = new SSHClient();
  tunnelState.conn = conn;
  tunnelState.chainConnections = chainConnections;

  // Keepalive policy:
  //   - positive value: honor it
  //   - explicit 0: truly disabled (host opted out via per-host override —
  //     a router/switch that doesn't reply to keepalive@openssh.com would
  //     otherwise be killed by ssh2 after countMax unanswered probes)
  //   - undefined: legacy caller path, fall back to 10s/3 so an idle
  //     forwarded TCP tunnel doesn't get dropped by NAT state tables.
  const keepalivePolicy = resolveConnectionKeepalivePolicy({
    keepaliveInterval: resolvedKeepaliveInterval,
    keepaliveCountMax: resolvedKeepaliveCountMax,
  });
  const connectOpts = {
    host: hostname,
    port: port,
    username: username || 'root',
    timeout: connectionTimeouts.tcpConnectTimeoutMs,
    readyTimeout: 0,
    keepaliveInterval: keepalivePolicy.keepaliveIntervalMs,
    keepaliveCountMax: keepalivePolicy.keepaliveCountMax,
    // Enable keyboard-interactive authentication (required for 2FA/MFA)
    tryKeyboard: true,
    algorithms: buildAlgorithms(legacyAlgorithms, { skipEcdsaHostKey, algorithmOverrides }),
  };
  connectOpts.hostVerifier = hostKeyVerifier.createHostVerifier({
    sender,
    sessionId: tunnelId,
    hostId,
    hostname,
    port,
    knownHosts,
    verifyHostKeys,
  });

  const hasCertificate = typeof certificate === "string" && certificate.trim().length > 0;
  portForwardingTunnels.set(tunnelId, tunnelState);

  let defaultKeys = [];
  let portForwardAuthPhase = { hadPartialSuccess: false, passwordAlreadySucceeded: false };
  let authBanner = "";
  try {
    const fallbackAgentSocket = useSshAgent === false
      ? null
      : useSshAgent === true
        ? undefined
        : await getAvailableAgentSocket(identityAgent, { hostname, port, username });
    const systemAuthAgent = hasCertificate ? null : await prepareSystemSshAgentForAuth({
      useSshAgent,
      agentPublicKeys,
      identityAgent,
      identityFilePaths,
      identitiesOnly,
      addKeysToAgent,
      useKeychain,
      hostname,
      port,
      username,
    }, "[PortForward]");
    const identityFile = !privateKey && !systemAuthAgent
      ? await loadFirstIdentityFileForAuth({
        sender,
        identityFilePaths,
        hostname,
        initialPassphrase: passphrase,
        passphraseSignal: passphraseAbortController.signal,
        logPrefix: "[PortForward]",
        onError: (err, keyPath) => {
          console.warn(`[PortForward] Failed to read identity file ${keyPath}:`, err.message);
        },
      })
      : null;
    const inlineKey = privateKey && !systemAuthAgent
      ? await preparePrivateKeyForAuth({
        sender,
        privateKey,
        keyId,
        keyName: keyId || username,
        hostname,
        initialPassphrase: passphrase,
        passphraseSignal: passphraseAbortController.signal,
        logPrefix: "[PortForward]",
      })
      : null;
    const effectivePrivateKey = inlineKey?.privateKey || identityFile?.privateKey;
    const effectivePassphrase = inlineKey?.passphrase || identityFile?.passphrase;

    if (isTunnelCancelled(tunnelState)) {
      portForwardingTunnels.delete(tunnelId);
      abandonPendingDial("Port forward connection cancelled");
      return { tunnelId, success: false, cancelled: true };
    }

    if (systemAuthAgent) {
      connectOpts.agent = systemAuthAgent;
    }
    if (hasCertificate) {
      connectOpts.agent = new NetcattyAgent({
        mode: "certificate",
        webContents: sender,
        meta: {
          label: keyId || username || "",
          certificate,
          privateKey: effectivePrivateKey,
          passphrase: effectivePassphrase,
        },
      });
    } else if (effectivePrivateKey) {
      connectOpts.privateKey = effectivePrivateKey;
      if (effectivePassphrase) {
        connectOpts.passphrase = effectivePassphrase;
      }
    }
    if (password) {
      connectOpts.password = password;
    }

    // Keep the discovered keys available to unrelated jump hosts even when
    // strict agent selection disables them for the final target.
    const discoveredDefaultKeys = await findAllDefaultPrivateKeysFromHelper();
    defaultKeys = systemAuthAgent && identitiesOnly
      ? []
      : discoveredDefaultKeys;
    if (isTunnelCancelled(tunnelState)) {
      portForwardingTunnels.delete(tunnelId);
      abandonPendingDial("Port forward connection cancelled");
      return { tunnelId, success: false, cancelled: true };
    }

    // Build auth handler using shared helper
    const authConfig = buildAuthHandler({
      authMethod,
      requiresMfa: !!requiresMfa,
      privateKey: connectOpts.privateKey,
      password,
      passphrase: connectOpts.passphrase,
      agent: connectOpts.agent,
      username: connectOpts.username,
      logPrefix: "[PortForward]",
      defaultKeys,
      sshAgentSocketOverride: fallbackAgentSocket,
      allowAgentFallback: useSshAgent !== false,
    });
    applyAuthToConnOpts(connectOpts, authConfig);
    portForwardAuthPhase = authConfig.authPhase || portForwardAuthPhase;
    if (isTunnelCancelled(tunnelState)) {
      portForwardingTunnels.delete(tunnelId);
      abandonPendingDial("Port forward connection cancelled");
      return { tunnelId, success: false, cancelled: true };
    }

    if (hasJumpHosts) {
      const chainResult = await connectThroughChain(
        event,
        {
          hostname,
          port,
          username,
          authMethod,
          password,
          privateKey,
          passphrase,
          useSshAgent,
          identityAgent,
          identityFilePaths,
          identitiesOnly,
          addKeysToAgent,
          useKeychain,
          proxy,
          knownHosts,
          verifyHostKeys,
          jumpHosts,
          legacyAlgorithms,
          skipEcdsaHostKey,
          algorithmOverrides,
          sshTcpConnectTimeoutMs: connectionTimeouts.tcpConnectTimeoutMs,
          sshAuthReadyTimeoutMs: connectionTimeouts.authReadyTimeoutMs,
          _defaultKeys: discoveredDefaultKeys,
          _connectionsRef: chainConnections,
          _tunnelRef: tunnelState,
          _passphraseSignal: passphraseAbortController.signal,
          _keyboardInteractiveScope: "external",
        },
        jumpHosts,
        hostname,
        port,
        tunnelId,
      );
      connectionSocket = chainResult.socket;
      chainConnections = chainResult.connections;
      tunnelState.chainConnections = chainConnections;
      if (isTunnelCancelled(tunnelState)) {
        cleanupChainConnections(chainConnections);
        if (!tunnelState.cleanupFailed) {
          portForwardingTunnels.delete(tunnelId);
        }
        abandonPendingDial("Port forward connection cancelled");
        return { tunnelId, success: false, cancelled: true };
      }
      connectOpts.sock = connectionSocket;
      delete connectOpts.host;
      delete connectOpts.port;
    } else if (hasProxy) {
      connectionSocket = await createProxySocket(proxy, hostname, port, {
        timeoutMs: connectionTimeouts.tcpConnectTimeoutMs,
        onSocket: (socket) => {
          tunnelState.pendingConn = socket;
        },
      });
      if (isTunnelCancelled(tunnelState)) {
        try { connectionSocket?.end?.(); } catch { /* ignore */ }
        try { connectionSocket?.destroy?.(); } catch { /* ignore */ }
        if (!tunnelState.cleanupFailed) {
          portForwardingTunnels.delete(tunnelId);
        }
        abandonPendingDial("Port forward connection cancelled");
        return { tunnelId, success: false, cancelled: true };
      }
      tunnelState.pendingConn = null;
      connectOpts.sock = connectionSocket;
      delete connectOpts.host;
      delete connectOpts.port;
    }
  } catch (err) {
    if (isTunnelCancelled(tunnelState)) {
      if (!tunnelState.cleanupFailed) {
        portForwardingTunnels.delete(tunnelId);
      }
      abandonPendingDial("Port forward connection cancelled");
      return { tunnelId, success: false, cancelled: true };
    }
    if (isPassphraseCancelledError(err)) {
      try {
        await cancelTunnel(tunnelId, tunnelState, sendStatus, { deleteEntry: true });
      } catch {
        /* best-effort cancel on passphrase cancel */
      }
      abandonPendingDial(err);
      return { tunnelId, success: false, cancelled: true };
    }
    tunnelState.cancelled = true;
    if (tunnelState.pendingConn) {
      try { tunnelState.pendingConn.end(); } catch { /* ignore */ }
    }
    cleanupChainConnections(tunnelState.chainConnections);
    if (connectionSocket) {
      try { connectionSocket.end?.(); } catch { /* ignore */ }
      try { connectionSocket.destroy?.(); } catch { /* ignore */ }
    }
    keyboardInteractiveHandler.cancelRequestsForSession(tunnelId, "connection-ended");
    portForwardingTunnels.delete(tunnelId);
    sendStatus('error', err?.message || String(err));
    abandonPendingDial(err);
    throw err;
  }

  // Handle keyboard-interactive authentication (2FA/MFA)
  conn.on("banner", (message) => {
    authBanner = String(message || "").trim();
  });
  conn.on("keyboard-interactive", createKeyboardInteractiveHandler({
    sender,
    sessionId: tunnelId,
    hostId,
    hostname,
    password,
    logPrefix: "[PortForward]",
    scope: "external",
    getAuthBanner: () => authBanner,
    shouldSkipAutoFill: () => shouldSkipKiPasswordAutoFill(portForwardAuthPhase),
  }));

  return new Promise((resolve, reject) => {
    // Track whether the Promise has been settled so conn.on('close')
    // can reject if the tunnel was killed during SSH handshake.
    let settled = false;
    let authReadyTimer = null;
    const clearAuthReadyTimer = () => {
      if (!authReadyTimer) return;
      clearTimeout(authReadyTimer);
      authReadyTimer = null;
    };

    conn.once('connect', () => {
      runWhenProxyConnectionReady(conn._sock, () => {
        try { conn._sock?.setTimeout?.(0); } catch { /* ignore */ }
        clearAuthReadyTimer();
        authReadyTimer = setTimeout(
          () => conn.emit('timeout'),
          connectionTimeouts.authReadyTimeoutMs,
        );
        authReadyTimer.unref?.();
      });
    });

    conn.once('ready', () => {
      clearAuthReadyTimer();
      console.log(`[PortForward] SSH connection ready for tunnel ${tunnelId}`);

      bindPortForwardChannels({
        type,
        conn,
        tunnelId,
        tunnelState,
        sender,
        bindAddress,
        localPort,
        remoteHost,
        remotePort,
        chainConnections,
        sendStatus,
        releaseOnError: false,
        endpoint: reuseEndpoint,
        registerTransport: reuseTransport !== false,
        dialCoordination: pendingDialCoordination,
      }).then((result) => {
        if (!result?.success && pendingDialCoordination) {
          failTransportDial(pendingDialCoordination, new Error("Port forward cancelled before activation"));
        }
        settled = true;
        resolve(result);
      }).catch((err) => {
        if (pendingDialCoordination) failTransportDial(pendingDialCoordination, err);
        settled = true;
        reject(err);
      });
    });

    conn.on('error', (err) => {
      clearAuthReadyTimer();
      console.error(`[PortForward] SSH error:`, err.message);
      if (settled) return;
      if (pendingDialCoordination) failTransportDial(pendingDialCoordination, err);
      sendStatus('error', err.message);
      cleanupChainConnections(chainConnections);
      settled = true;
      reject(err);
    });

    conn.once('close', () => {
      clearAuthReadyTimer();
      keyboardInteractiveHandler.cancelRequestsForSession(tunnelId, "connection-ended");
      console.log(`[PortForward] SSH connection closed for tunnel ${tunnelId}`);
      const tunnel = portForwardingTunnels.get(tunnelId) || tunnelState;
      // Capture the cancelled flag BEFORE cleanup deletes the entry.
      const wasCancelled = !!tunnel?.cancelled;
      if (tunnel) {
        if (tunnel.server) {
          try { tunnel.server.close(); } catch { }
        }
        if (tunnel.pendingConn) {
          try { tunnel.pendingConn.end(); } catch { /* ignore */ }
        }
        if (tunnel.sshTransportManaged) {
          // Socket died under us; drop the lease without trying to end again.
          try { returnTransport(tunnel); } catch { /* ignore */ }
          tunnel.sshTransportManaged = false;
          tunnel.conn = null;
        } else if (Array.isArray(tunnel.chainConnections)) {
          cleanupChainConnections(tunnel.chainConnections);
        }
        if (shouldFinalizeTunnelClose(tunnel)) {
          sendStatus('inactive');
          portForwardingTunnels.delete(tunnelId);
        }
      }
      // If the Promise was never settled (tunnel killed during
      // handshake by stopPortForwardByRuleId), settle it.
      if (!settled) {
        settled = true;
        if (wasCancelled) {
          if (pendingDialCoordination) {
            failTransportDial(pendingDialCoordination, new Error("Port forward connection cancelled"));
          }
          resolve({ tunnelId, success: false, cancelled: true });
        } else {
          const err = new Error(`Tunnel ${tunnelId} closed before connection established`);
          if (pendingDialCoordination) failTransportDial(pendingDialCoordination, err);
          reject(err);
        }
      }
    });

    conn.once('timeout', () => {
      clearAuthReadyTimer();
      if (settled) return;
      const err = new Error(`Connection timeout to ${hostname}`);
      if (pendingDialCoordination) failTransportDial(pendingDialCoordination, err);
      sendStatus('error', err.message);
      cleanupChainConnections(chainConnections);
      settled = true;
      reject(err);
      conn.end();
    });

    conn.connect(connectOpts);
  });
}

/**
 * Stop a port forwarding tunnel
 */
async function stopPortForward(event, payload) {
  const { tunnelId } = payload;
  const tunnel = portForwardingTunnels.get(tunnelId);

  if (!tunnel) {
    return { tunnelId, success: false, error: 'Tunnel not found' };
  }

  try {
    await cancelTunnel(
      tunnelId,
      tunnel,
      (status, error) => publishTunnelStatus(tunnelId, tunnel, status, error),
      { deleteEntry: true },
    );
    return { tunnelId, success: true };
  } catch (err) {
    return { tunnelId, success: false, error: err.message };
  }
}

/**
 * Get status of a tunnel
 */
async function getPortForwardStatus(event, payload) {
  const { tunnelId } = payload;
  const tunnel = portForwardingTunnels.get(tunnelId);

  if (!tunnel) {
    return { tunnelId, status: 'inactive' };
  }

  return {
    tunnelId,
    status: tunnel.status || 'active',
    type: tunnel.type,
    ...(tunnel.error ? { error: tunnel.error } : {}),
  };
}

/**
 * Register the calling renderer for status events from an existing tunnel and
 * return the status from the same main-process turn.
 */
async function subscribePortForward(event, payload) {
  const { tunnelId } = payload;
  const tunnel = portForwardingTunnels.get(tunnelId);

  if (!tunnel) {
    return { tunnelId, status: 'inactive' };
  }

  if (!(tunnel.subscribers instanceof Map)) {
    tunnel.subscribers = new Map();
  }
  tunnel.subscribers.set(event.sender.id, event.sender);
  return {
    tunnelId,
    status: tunnel.status || 'active',
    type: tunnel.type,
    ...(tunnel.error ? { error: tunnel.error } : {}),
  };
}

/** Remove a renderer-owned subscription from every tunnel in this process. */
async function unsubscribePortForwardSender(event, payload = {}) {
  const webContentsId = payload.webContentsId ?? event?.sender?.id;
  if (!Number.isSafeInteger(webContentsId)) return { removed: 0 };
  let removed = 0;
  for (const tunnel of portForwardingTunnels.values()) {
    if (tunnel.subscribers instanceof Map && tunnel.subscribers.delete(webContentsId)) {
      removed += 1;
    }
  }
  const runtimeEntry = runtimeEventSubscribers.get(webContentsId);
  if (runtimeEntry) {
    if (runtimeEntry.onDestroyed) {
      runtimeEntry.sender.removeListener?.("destroyed", runtimeEntry.onDestroyed);
    }
    runtimeEventSubscribers.delete(webContentsId);
    removed += 1;
  }
  return { removed };
}

/**
 * List all active port forwards
 */
async function listPortForwards() {
  const list = [];
  for (const [tunnelId, tunnel] of portForwardingTunnels) {
    list.push({
      ruleId: tunnel.ruleId,
      tunnelId,
      type: tunnel.type,
      status: tunnel.status || 'active',
      ...(tunnel.error ? { error: tunnel.error } : {}),
    });
  }
  return list;
}

/**
 * Stop all active port forwards (cleanup on app quit)
 */
async function stopAllPortForwards() {
  console.log(`[PortForward] Stopping all ${portForwardingTunnels.size} active tunnels...`);
  const jobs = [];
  for (const [tunnelId, tunnel] of portForwardingTunnels) {
    jobs.push(
      cancelTunnel(
        tunnelId,
        tunnel,
        (status, error) => publishTunnelStatus(tunnelId, tunnel, status, error),
        { deleteEntry: true },
      ).then(
        () => console.log(`[PortForward] Stopped tunnel ${tunnelId}`),
        (err) => console.warn(`[PortForward] Failed to stop tunnel ${tunnelId}:`, err.message),
      ),
    );
  }
  await Promise.all(jobs);
  console.log('[PortForward] All tunnels stopped');
}

/**
 * Stop all active port forwards for a given rule ID.
 * This catches tunnels in ANY state (connecting, active) because it
 * operates on the main-process portForwardingTunnels map directly.
 */
async function stopPortForwardByRuleId(_event, { ruleId }) {
  let stopped = 0;
  let failed = 0;
  const errors = [];
  for (const [tunnelId, tunnel] of portForwardingTunnels) {
    if (tunnel.ruleId === ruleId) {
      try {
        await cancelTunnel(
          tunnelId,
          tunnel,
          (status, error) => publishTunnelStatus(tunnelId, tunnel, status, error),
          { deleteEntry: true },
        );
        console.log(`[PortForward] Stopped tunnel ${tunnelId} for rule ${ruleId}`);
        stopped++;
      } catch (err) {
        console.warn(`[PortForward] Failed to stop tunnel ${tunnelId}:`, err.message);
        failed++;
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
  }
  return { stopped, failed, errors };
}

/**
 * Register IPC handlers for port forwarding operations
 */
function registerHandlers(ipcMain, options = {}) {
  const terminalWorkerManager = options.terminalWorkerManager || null;
  if (terminalWorkerManager) {
    const subscriptionsBySender = new Map();
    const trackedTunnelIds = new Set();
    const tunnelRuleIds = new Map();

    const unsubscribeDestroyedSender = (webContentsId) => {
      void terminalWorkerManager.request(
        "netcatty:portforward:unsubscribeSender",
        { webContentsId },
        { webContentsId },
      ).catch(() => {});
    };

    const forgetTunnel = (tunnelId) => {
      if (!tunnelId) return;
      trackedTunnelIds.delete(tunnelId);
      tunnelRuleIds.delete(tunnelId);
      for (const [webContentsId, entry] of subscriptionsBySender) {
        entry.tunnelIds.delete(tunnelId);
        if (entry.tunnelIds.size > 0) continue;
        entry.sender.removeListener?.("destroyed", entry.onDestroyed);
        subscriptionsBySender.delete(webContentsId);
      }
    };

    const ensureSenderLifecycle = (sender) => {
      if (!sender || !Number.isSafeInteger(sender.id)) return null;
      if (sender.isDestroyed?.()) {
        unsubscribeDestroyedSender(sender.id);
        return null;
      }
      let entry = subscriptionsBySender.get(sender.id);
      if (!entry) {
        const onDestroyed = () => {
          subscriptionsBySender.delete(sender.id);
          unsubscribeDestroyedSender(sender.id);
        };
        entry = { sender, tunnelIds: new Set(), onDestroyed };
        subscriptionsBySender.set(sender.id, entry);
        sender.once?.("destroyed", onDestroyed);
      }
      return entry;
    };

    const releaseEmptySenderLifecycle = (sender, entry) => {
      if (
        !entry
        || entry.tunnelIds.size > 0
        || entry.runtimeSubscribed
        || subscriptionsBySender.get(sender?.id) !== entry
      ) return;
      entry.sender.removeListener?.("destroyed", entry.onDestroyed);
      subscriptionsBySender.delete(sender.id);
    };

    const trackSubscription = (sender, tunnelId, ruleId) => {
      if (!tunnelId) return;
      const entry = ensureSenderLifecycle(sender);
      if (!entry) return;
      entry.tunnelIds.add(tunnelId);
      trackedTunnelIds.add(tunnelId);
      if (ruleId) tunnelRuleIds.set(tunnelId, ruleId);
    };

    const requestWorker = (channel, { track = false, cleanup = null } = {}) => {
      ipcMain.handle(channel, async (event, payload) => {
        const pendingSenderEntry = track ? ensureSenderLifecycle(event?.sender) : null;
        try {
          const result = await terminalWorkerManager.request(channel, payload, {
            webContentsId: event?.sender?.id,
          });
          if (
            track
            && result?.tunnelId
            && result.success !== false
            && result.status !== "inactive"
            && result.status !== "error"
          ) {
            trackSubscription(event?.sender, result.tunnelId, payload?.ruleId);
          }
          if (cleanup === "tunnel" && result?.success) forgetTunnel(payload?.tunnelId);
          if (cleanup === "all") {
            for (const tunnelId of [...trackedTunnelIds]) forgetTunnel(tunnelId);
          }
          if (cleanup === "rule" && result?.failed === 0) {
            for (const [tunnelId, ruleId] of tunnelRuleIds) {
              if (ruleId === payload?.ruleId) forgetTunnel(tunnelId);
            }
          }
          return result;
        } finally {
          releaseEmptySenderLifecycle(event?.sender, pendingSenderEntry);
        }
      });
    };

    requestWorker("netcatty:portforward:start", { track: true });
    requestWorker("netcatty:portforward:stop", { cleanup: "tunnel" });
    requestWorker("netcatty:portforward:status");
    requestWorker("netcatty:portforward:subscribe", { track: true });
    requestWorker("netcatty:portforward:list");
    requestWorker("netcatty:portforward:snapshot");
    // Runtime subscriptions are process-scoped (no tunnelId). Keep the sender
    // lifecycle entry so a destroyed window still calls unsubscribeSender,
    // which clears worker-side runtimeEventSubscribers.
    ipcMain.handle("netcatty:portforward:subscribeRuntime", async (event, payload) => {
      const entry = ensureSenderLifecycle(event?.sender);
      if (entry) entry.runtimeSubscribed = true;
      try {
        return await terminalWorkerManager.request(
          "netcatty:portforward:subscribeRuntime",
          payload,
          { webContentsId: event?.sender?.id },
        );
      } catch (error) {
        if (entry) {
          entry.runtimeSubscribed = false;
          releaseEmptySenderLifecycle(event?.sender, entry);
        }
        throw error;
      }
    });
    ipcMain.handle("netcatty:portforward:unsubscribeRuntime", async (event, payload) => {
      const entry = subscriptionsBySender.get(event?.sender?.id);
      try {
        return await terminalWorkerManager.request(
          "netcatty:portforward:unsubscribeRuntime",
          payload,
          { webContentsId: event?.sender?.id },
        );
      } finally {
        if (entry) entry.runtimeSubscribed = false;
        releaseEmptySenderLifecycle(event?.sender, entry);
      }
    });
    requestWorker("netcatty:portforward:stopAll", { cleanup: "all" });
    requestWorker("netcatty:portforward:stopByRuleId", { cleanup: "rule" });

    terminalWorkerManager.onWorkerRendererEvent?.((message) => {
      if (message?.channel === "netcatty:portforward:runtime") {
        // Runtime events are already targeted at subscribed renderers by the
        // worker; main only needs to forget tunnel tracking on remove.
        if (message.payload?.kind === "remove") {
          forgetTunnel(message.payload?.tunnelId);
        }
        return;
      }
      if (message?.channel !== "netcatty:portforward:status") return;
      if (message.payload?.status === "inactive" || message.payload?.status === "error") {
        forgetTunnel(message.payload?.tunnelId);
      }
    });
    terminalWorkerManager.onWorkerExit?.((error) => {
      const message = error?.message || "Terminal worker exited";
      const notified = new Set();
      for (const entry of subscriptionsBySender.values()) {
        for (const tunnelId of entry.tunnelIds) {
          const key = `${entry.sender.id}:${tunnelId}`;
          if (notified.has(key) || entry.sender.isDestroyed?.()) continue;
          notified.add(key);
          safeSend(entry.sender, "netcatty:portforward:status", {
            tunnelId,
            status: "error",
            error: message,
          });
        }
      }
      for (const tunnelId of [...trackedTunnelIds]) forgetTunnel(tunnelId);
    });
    return;
  }
  ipcMain.handle("netcatty:portforward:start", startPortForward);
  ipcMain.handle("netcatty:portforward:stop", stopPortForward);
  ipcMain.handle("netcatty:portforward:status", getPortForwardStatus);
  ipcMain.handle("netcatty:portforward:subscribe", subscribePortForward);
  ipcMain.handle("netcatty:portforward:list", listPortForwards);
  ipcMain.handle("netcatty:portforward:snapshot", () => getPortForwardSnapshot());
  ipcMain.handle("netcatty:portforward:subscribeRuntime", subscribePortForwardRuntime);
  ipcMain.handle("netcatty:portforward:unsubscribeRuntime", unsubscribePortForwardRuntime);
  ipcMain.handle("netcatty:portforward:stopAll", () => stopAllPortForwards());
  ipcMain.handle("netcatty:portforward:stopByRuleId", stopPortForwardByRuleId);
  ipcMain.handle("netcatty:portforward:unsubscribeSender", unsubscribePortForwardSender);
}

module.exports = {
  registerHandlers,
  startPortForward,
  stopPortForward,
  getPortForwardStatus,
  subscribePortForward,
  unsubscribePortForwardSender,
  listPortForwards,
  getPortForwardSnapshot,
  subscribePortForwardRuntime,
  unsubscribePortForwardRuntime,
  stopAllPortForwards,
  stopPortForwardByRuleId,
  cancelTunnel,
  publishTunnelStatus,
  shouldFinalizeTunnelClose,
  isReusableTunnelStatus,
  buildPortForwardEndpoint,
  buildPortForwardEndpointFromStartPayload,
  _resetPortForwardRuntimeMetaForTests: resetPortForwardRuntimeMetaForTests,
  _seedPortForwardTunnelForTests: seedPortForwardTunnelForTests,
  _clearPortForwardTunnelsForTests: clearPortForwardTunnelsForTests,
  _bindPortForwardChannelsForTests: bindPortForwardChannels,
  _trackTunnelPipeForTests: trackTunnelPipe,
  _attachTunnelPipeStreamForTests: attachTunnelPipeStream,
  _destroyTunnelPipesForTests: destroyTunnelPipes,
};
