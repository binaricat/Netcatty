"use strict";

const { randomUUID } = require("node:crypto");
const { executeBoundedSshCommand } = require("../bridges/boundedSshExec.cjs");
const { createSshPingLatencyProbe } = require("../bridges/sshBridge/sshPingLatency.cjs");
const hostKeyVerifier = require("../bridges/hostKeyVerifier.cjs");
const { remoteSoftwareRequiresSingleChannel } = require("../../domain/singleChannelSshBanner.shared.cjs");
const { PluginRpcError, RPC_ERRORS } = require("./rpcRouter.cjs");

const fail = (code, message) => new PluginRpcError(RPC_ERRORS[code], message);

const DEFAULT_IDLE_TTL_MS = 120_000;
const DEFAULT_MAX_CONCURRENT_PER_RUNTIME = 16;
const DEFAULT_MAX_CONCURRENT_TOTAL = 64;

let vendorDetectorPromise = null;
function loadVendorDetector() {
  vendorDetectorPromise ??= import("../../domain/sshServerVendor.mjs")
    .then((mod) => mod.detectVendorFromSshVersion)
    .catch(() => () => null);
  return vendorDetectorPromise;
}

/**
 * Host-owned pooled SSH exec transport for sandboxed plugins.
 *
 * - Reuses Netcatty's main-process SSH dialer (`portForwardingBridge.startPortForward`
 *   with `reuseTransport: true` and `bindChannels`), inheriting jump hosts, proxies,
 *   passphrase prompts, FIDO2, and host-key verification.
 * - Caches live authenticated `ssh2` transports per `(runtimeId, hostId)` with idle
 *   eviction so periodic monitoring polls execute in ~5-30ms without new SSH handshakes
 *   or renderer IPC roundtrips.
 * - Enforces single-channel/appliance banner checks, hard concurrency limits, and
 *   immediate teardown on App Lock, plugin disable, runtime stop, or binding revocation.
 */
class PluginHostSshExecTransport {
  constructor(options = {}) {
    this.portForwardingBridge = options.portForwardingBridge ?? null;
    this.execCommand = options.execCommand ?? executeBoundedSshCommand;
    this.measurePing = options.measurePing ?? createSshPingLatencyProbe();
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.maxConcurrentPerRuntime = options.maxConcurrentPerRuntime ?? DEFAULT_MAX_CONCURRENT_PER_RUNTIME;
    this.maxConcurrentTotal = options.maxConcurrentTotal ?? DEFAULT_MAX_CONCURRENT_TOTAL;
    this.clock = options.clock ?? Date.now;
    this.isLocked = options.isLocked ?? (() => false);
    this.getSender = options.getSender ?? (() => null);

    /** @type {Map<string, object>} `${runtimeId}\0${hostId}` -> pooled entry */
    this.connections = new Map();
    /** @type {Map<string, Promise<object>>} `${runtimeId}\0${hostId}` -> in-flight dial */
    this.pendingDials = new Map();
    /** @type {Set<{ controller: AbortController, runtimeId: string, pluginId: string, hostId: string }>} */
    this.activeExecs = new Set();
    this.closed = false;

    this.unsubscribeLock = options.subscribeLock?.((state) => {
      if (state?.locked) this.closeAll("Application locked");
    }) ?? null;
  }

  #bridge() {
    return this.portForwardingBridge ?? require("../bridges/portForwardingBridge.cjs");
  }

  #key(runtimeId, hostId) {
    return `${runtimeId}\0${hostId}`;
  }

  #isEntryHealthy(entry) {
    if (!entry || entry.closed || !entry.conn) return false;
    const sock = entry.conn._sock;
    if (sock && (sock.destroyed || sock.writableEnded)) return false;
    return true;
  }

  #touchIdleTimer(entry) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    if (entry.closed || this.idleTtlMs <= 0) return;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = null;
      if (entry.activeCount === 0) {
        void this.#closeEntry(entry);
      }
    }, this.idleTtlMs);
    entry.idleTimer.unref?.();
  }

  async #closeEntry(entry) {
    if (!entry || entry.closed) return;
    entry.closed = true;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    if (this.connections.get(entry.key) === entry) {
      this.connections.delete(entry.key);
    }
    hostKeyVerifier.cancelRequestsForSession(entry.tunnelId);
    try {
      await this.#bridge().stopPortForward({ sender: entry.sender }, { tunnelId: entry.tunnelId });
    } catch { /* ignore teardown failures */ }
  }

  async #dialEntry({ runtimeId, pluginId, hostId, prepareConnection, signal }) {
    const key = this.#key(runtimeId, hostId);
    const existing = this.connections.get(key);
    if (this.#isEntryHealthy(existing)) {
      return existing;
    }
    if (existing) {
      void this.#closeEntry(existing);
    }

    const raceCallerSignal = (promise) => {
      if (!signal) return promise;
      if (signal.aborted) return Promise.reject(fail("cancelled", "SSH connection was cancelled"));
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(fail("cancelled", "SSH connection was cancelled"));
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
          (val) => { signal.removeEventListener("abort", onAbort); resolve(val); },
          (err) => { signal.removeEventListener("abort", onAbort); reject(err); },
        );
      });
    };

    const inflight = this.pendingDials.get(key);
    if (inflight) {
      return raceCallerSignal(inflight.promise);
    }

    const dialController = new AbortController();
    const dialPromise = (async () => {
      if (this.closed || this.isLocked() || dialController.signal.aborted) {
        throw fail("unavailable", "Host SSH execution is unavailable");
      }
      const connectionOptions = await prepareConnection(hostId, dialController.signal);
      if (!connectionOptions || typeof connectionOptions !== "object") {
        throw fail("unavailable", "Could not prepare SSH connection for host");
      }
      if (connectionOptions.singleChannelSsh) {
        throw fail("unsupported", "This SSH server does not support multiplexed command execution");
      }
      if (this.closed || this.isLocked() || dialController.signal.aborted) {
        throw fail("unavailable", "Host SSH execution is unavailable");
      }

      const sender = this.getSender();
      const tunnelId = `plugin-exec-${randomUUID()}`;
      const event = { sender };
      let liveConn = null;
      let rejectedUnsupported = false;
      const detectVendor = await loadVendorDetector();

      const result = await this.#bridge().startPortForward(
        event,
        {
          ...connectionOptions,
          tunnelId,
          ruleId: undefined,
          type: "local",
          localPort: 0,
          bindAddress: "127.0.0.1",
          remoteHost: "127.0.0.1",
          remotePort: 1,
          reuseTransport: true,
        },
        {
          bindChannels: async ({ conn, tunnelState, chainConnections }) => {
            tunnelState.conn = conn;
            tunnelState.pendingConn = null;
            tunnelState.chainConnections = chainConnections;
            const remoteVer = typeof conn?._remoteVer === "string" ? conn._remoteVer : "";
            if (detectVendor(remoteVer) || remoteSoftwareRequiresSingleChannel(remoteVer)) {
              rejectedUnsupported = true;
              throw new Error("SINGLE_CHANNEL_UNSUPPORTED");
            }
            liveConn = conn;
            tunnelState.status = "active";
            return { success: true };
          },
        },
      );

      if (rejectedUnsupported) {
        hostKeyVerifier.cancelRequestsForSession(tunnelId);
        await this.#bridge().stopPortForward(event, { tunnelId }).catch(() => {});
        throw fail("unsupported", "This SSH server does not support multiplexed command execution");
      }
      if (!result?.success || !liveConn) {
        hostKeyVerifier.cancelRequestsForSession(tunnelId);
        await this.#bridge().stopPortForward(event, { tunnelId }).catch(() => {});
        throw fail("unavailable", "Could not connect to the selected SSH server");
      }

      const entry = {
        key,
        runtimeId,
        pluginId,
        hostId,
        tunnelId,
        sender,
        conn: liveConn,
        closed: false,
        activeCount: 0,
        idleTimer: null,
      };
      const onConnDead = () => {
        void this.#closeEntry(entry);
      };
      liveConn.once?.("close", onConnDead);
      liveConn.once?.("end", onConnDead);
      liveConn.once?.("error", onConnDead);

      if (this.closed || this.isLocked() || dialController.signal.aborted) {
        await this.#closeEntry(entry);
        throw fail("unavailable", "Host SSH execution is unavailable");
      }

      this.connections.set(key, entry);
      this.#touchIdleTimer(entry);
      return entry;
    })();

    const dialRecord = { controller: dialController, promise: dialPromise, runtimeId, pluginId, hostId };
    this.pendingDials.set(key, dialRecord);
    const cleanupPending = () => {
      if (this.pendingDials.get(key) === dialRecord) {
        this.pendingDials.delete(key);
      }
    };
    dialPromise.then(cleanupPending, cleanupPending);
    return raceCallerSignal(dialPromise);
  }

  /**
   * Acquire a borrowed reference to a pooled authenticated SSH2 connection for
   * `(runtimeId, hostId)` so SFTP or other subsystems share the same transport
   * and teardown guarantees. Caller MUST invoke `release()` in a `finally` block.
   */
  async acquireConnection({ runtimeId, pluginId, hostId, prepareConnection, signal, assertActive }) {
    if (this.closed || this.isLocked()) {
      throw fail("unavailable", "Host SSH connection is unavailable");
    }
    const runtimeInflight = [...this.activeExecs].filter((item) => item.runtimeId === runtimeId).length;
    if (runtimeInflight >= this.maxConcurrentPerRuntime || this.activeExecs.size >= this.maxConcurrentTotal) {
      throw fail("resourceExhausted", "Too many concurrent SSH operations");
    }
    const controller = new AbortController();
    const lease = { controller, runtimeId, pluginId, hostId };
    this.activeExecs.add(lease);
    const onCallerAbort = () => controller.abort(signal?.reason ?? fail("cancelled", "SSH operation was cancelled"));
    if (signal?.aborted) {
      this.activeExecs.delete(lease);
      throw fail("cancelled", "SSH operation was cancelled");
    }
    signal?.addEventListener("abort", onCallerAbort, { once: true });

    let entry = null;
    let acquired = false;
    try {
      await assertActive?.();
      controller.signal.throwIfAborted();
      entry = await this.#dialEntry({
        runtimeId,
        pluginId,
        hostId,
        prepareConnection,
        signal: controller.signal,
      });
      await assertActive?.();
      controller.signal.throwIfAborted();
      entry.activeCount += 1;
      acquired = true;
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
      }
      let released = false;
      return {
        conn: entry.conn,
        signal: controller.signal,
        invalidate: () => { void this.#closeEntry(entry); },
        release: () => {
          if (released) return;
          released = true;
          signal?.removeEventListener("abort", onCallerAbort);
          this.activeExecs.delete(lease);
          entry.activeCount = Math.max(0, entry.activeCount - 1);
          if (entry.activeCount === 0 && !entry.closed) {
            this.#touchIdleTimer(entry);
          }
        },
      };
    } catch (error) {
      signal?.removeEventListener("abort", onCallerAbort);
      this.activeExecs.delete(lease);
      if (entry && acquired) {
        entry.activeCount = Math.max(0, entry.activeCount - 1);
        if (entry.activeCount === 0 && !entry.closed) {
          this.#touchIdleTimer(entry);
        }
      }
      throw error;
    }
  }

  async exec({
    runtimeId,
    pluginId,
    hostId,
    command,
    timeoutMs,
    maxOutputBytes,
    prepareConnection,
    signal,
    assertActive,
  }) {
    if (this.closed || this.isLocked()) {
      throw fail("unavailable", "Host SSH execution is unavailable");
    }
    const runtimeInflight = [...this.activeExecs].filter((item) => item.runtimeId === runtimeId).length;
    if (runtimeInflight >= this.maxConcurrentPerRuntime || this.activeExecs.size >= this.maxConcurrentTotal) {
      throw fail("resourceExhausted", "Too many concurrent SSH commands");
    }

    const controller = new AbortController();
    const lease = { controller, runtimeId, pluginId, hostId };
    this.activeExecs.add(lease);
    const onCallerAbort = () => controller.abort(signal?.reason ?? fail("cancelled", "SSH command was cancelled"));
    if (signal?.aborted) {
      this.activeExecs.delete(lease);
      throw fail("cancelled", "SSH command was cancelled");
    }
    signal?.addEventListener("abort", onCallerAbort, { once: true });

    const startedAt = this.clock();
    let entry = null;
    let acquired = false;
    try {
      await assertActive?.();
      controller.signal.throwIfAborted();

      entry = await this.#dialEntry({
        runtimeId,
        pluginId,
        hostId,
        prepareConnection,
        signal: controller.signal,
      });

      await assertActive?.();
      controller.signal.throwIfAborted();

      entry.activeCount += 1;
      acquired = true;
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
      }

      const execStartAt = this.clock();
      const pingPromise = typeof this.measurePing === "function"
        ? Promise.resolve(this.measurePing(entry.conn, Math.min(timeoutMs, 3000))).catch(() => null)
        : Promise.resolve(null);

      let execResult;
      try {
        execResult = await this.execCommand(entry.conn, command, {
          openingTimeoutMs: Math.min(timeoutMs, 10_000),
          runTimeoutMs: timeoutMs,
          maxOutputBytes,
          signal: controller.signal,
          invalidateTransportOnAbort: false,
        });
      } catch (err) {
        if (!this.#isEntryHealthy(entry) || err?.code === "ECONNRESET" || err?.code === "EPIPE") {
          void this.#closeEntry(entry);
        }
        if (err instanceof PluginRpcError) throw err;
        if (err?.code === "SSH_EXEC_OUTPUT_LIMIT") {
          throw fail("resourceExhausted", "SSH command output exceeded the configured byte limit");
        }
        if (controller.signal.aborted) {
          throw fail("cancelled", "SSH command was cancelled");
        }
        if (/timed out/i.test(String(err?.message ?? ""))) {
          throw fail("deadlineExceeded", "SSH command timed out");
        }
        throw fail("unavailable", "SSH command execution failed");
      }

      const latencyMs = await pingPromise;
      const finishedAt = this.clock();
      const durationMs = Math.max(0, Math.round(finishedAt - startedAt));
      const responseLatencyMs = Math.max(0, Math.round(finishedAt - execStartAt));
      const resolvedExitCode = typeof execResult?.exitCode === "number"
        ? execResult.exitCode
        : (typeof execResult?.code === "number" ? execResult.code : null);

      return {
        stdout: typeof execResult?.stdout === "string" ? execResult.stdout : "",
        stderr: typeof execResult?.stderr === "string" ? execResult.stderr : "",
        exitCode: resolvedExitCode,
        truncated: execResult?.truncated === true,
        durationMs,
        latencyMs: typeof latencyMs === "number" && Number.isFinite(latencyMs) ? Math.max(0, Math.round(latencyMs)) : null,
        responseLatencyMs,
      };
    } finally {
      signal?.removeEventListener("abort", onCallerAbort);
      this.activeExecs.delete(lease);
      if (entry && acquired) {
        entry.activeCount = Math.max(0, entry.activeCount - 1);
        if (entry.activeCount === 0 && !entry.closed) {
          this.#touchIdleTimer(entry);
        }
      }
    }
  }

  releaseHost(pluginId, hostId) {
    for (const dial of [...this.pendingDials.values()]) {
      if (dial.pluginId === pluginId && dial.hostId === hostId) {
        dial.controller.abort(fail("permissionDenied", "Host binding was revoked"));
      }
    }
    for (const lease of [...this.activeExecs]) {
      if (lease.pluginId === pluginId && lease.hostId === hostId) {
        lease.controller.abort(fail("permissionDenied", "Host binding was revoked"));
      }
    }
    for (const entry of [...this.connections.values()]) {
      if (entry.pluginId === pluginId && entry.hostId === hostId) {
        void this.#closeEntry(entry);
      }
    }
  }

  releaseRuntime(runtimeId) {
    for (const dial of [...this.pendingDials.values()]) {
      if (dial.runtimeId === runtimeId) {
        dial.controller.abort(fail("cancelled", "Plugin runtime stopped"));
      }
    }
    for (const lease of [...this.activeExecs]) {
      if (lease.runtimeId === runtimeId) {
        lease.controller.abort(fail("cancelled", "Plugin runtime stopped"));
      }
    }
    for (const entry of [...this.connections.values()]) {
      if (entry.runtimeId === runtimeId) {
        void this.#closeEntry(entry);
      }
    }
  }

  releasePlugin(pluginId) {
    for (const dial of [...this.pendingDials.values()]) {
      if (dial.pluginId === pluginId) {
        dial.controller.abort(fail("permissionDenied", "Plugin SSH execution permission revoked or disabled"));
      }
    }
    for (const lease of [...this.activeExecs]) {
      if (lease.pluginId === pluginId) {
        lease.controller.abort(fail("permissionDenied", "Plugin SSH execution permission revoked or disabled"));
      }
    }
    for (const entry of [...this.connections.values()]) {
      if (entry.pluginId === pluginId) {
        void this.#closeEntry(entry);
      }
    }
  }

  closeAll(reason = "Host SSH execution unavailable") {
    for (const dial of [...this.pendingDials.values()]) {
      dial.controller.abort(fail("unavailable", reason));
    }
    for (const lease of [...this.activeExecs]) {
      lease.controller.abort(fail("unavailable", reason));
    }
    for (const entry of [...this.connections.values()]) {
      void this.#closeEntry(entry);
    }
  }

  shutdown() {
    this.closed = true;
    try { this.unsubscribeLock?.(); } catch { /* ignore */ }
    this.unsubscribeLock = null;
    this.closeAll("Plugin host shutting down");
  }
}

module.exports = {
  PluginHostSshExecTransport,
  DEFAULT_IDLE_TTL_MS,
  DEFAULT_MAX_CONCURRENT_PER_RUNTIME,
  DEFAULT_MAX_CONCURRENT_TOTAL,
};
