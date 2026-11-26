"use strict";

// Host-only transport core. No protocol, credential lookup, or plugin-supplied
// Node runs here. The registered service authenticates source-bound runtimes.
const net = require("node:net");
const tls = require("node:tls");
const dns = require("node:dns/promises");
const { randomUUID } = require("node:crypto");
const { PluginRpcError, RPC_ERRORS, raceWithAbort } = require("./rpcRouter.cjs");

const HOST_LIMITS = Object.freeze(require("./generated/plugin-contract.schema.json").$defs.HostByteStreamLimits.const);
const LIMITS = Object.freeze(require("./generated/plugin-contract.schema.json").$defs.ByteStreamLimits.const);
const {
  canonicalizeStreamEndpoint,
  getNetcattyInternalControlPorts,
  isLocalControlAddress,
  isLoopbackAddress,
  isUnconditionallyBlockedAddress,
} = require("./byteStreamEndpoint.cjs");

function failure(code, message) { return new PluginRpcError(RPC_ERRORS[code], message); }

function formatCertDistinguishedName(value) {
  if (!value || typeof value !== "object") return "";
  return Object.entries(value)
    .filter(([, v]) => typeof v === "string" || Array.isArray(v))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v}`)
    .join(", ")
    .slice(0, 512);
}

class PluginByteStreamBroker {
  constructor(options) {
    this.permissionEngine = options.permissionEngine;
    this.quotaManager = options.quotaManager;
    this.audit = options.audit ?? (() => {});
    this.lookup = options.lookup ?? dns.lookup;
    this.connectSocket = options.connectSocket ?? ((params) => net.createConnection(params));
    this.connectTls = options.connectTls ?? ((params) => tls.connect(params));
    // Only a host test harness can opt a specific loopback endpoint in without
    // interactive user confirmation. Production always blocks internal ports.
    this.testLocalEndpoints = new Set(options.testLocalEndpoints ?? []);
    this.isControlEndpoint = options.isControlEndpoint ?? (() => false);
    this.isInternalControlPort = options.isInternalControlPort ?? ((address, port) => (
      (isLoopbackAddress(address) || this.isControlEndpoint(address, port))
      && getNetcattyInternalControlPorts().has(port)
    ));
    this.confirmTlsCert = options.confirmTlsCert ?? null;
    this.isTrustedTlsCert = options.isTrustedTlsCert ?? (() => false);
    this.rememberTlsCert = options.rememberTlsCert ?? (() => {});
    this.connections = new Map();
    this.closeListeners = new Set();
    this.closed = false;
    this.revocation = this.permissionEngine.onDidRevoke((event) => {
      for (const state of this.connections.values()) {
        if (state.pluginId === event.pluginId
          && (event.permission === undefined || event.permission === (state.permission ?? "network.stream"))
          && (event.resource === undefined || event.resource === state.endpoint)) {
          this.finish(state, failure("permissionDenied", "Byte stream permission was revoked"));
        }
      }
    });
  }

  record(state, operation) {
    // Audit only host-observed generic operations, never bytes or peer messages.
    try { this.audit(state.pluginId, `network.stream.${operation}`, {
      runtimeId: state.runtimeId, endpoint: state.endpoint,
      handleId: state.id, bytesRead: state.bytesRead, bytesWritten: state.bytesWritten,
    }, state); } catch { /* An audit sink cannot keep a revoked socket alive. */ }
  }

  finish(state, reason) {
    if (state.closed) return;
    state.closed = true;
    clearTimeout(state.connectTimer);
    clearTimeout(state.idleTimer);
    clearTimeout(state.lifetimeTimer);
    state.error = reason;
    this.connections.delete(state.id);
    state.controller.abort(reason ?? failure("cancelled", "Byte stream closed"));
    state.socket?.destroy();
    this.record(state, "close");
    for (const listener of this.closeListeners) {
      try { listener(state, reason); } catch {}
    }
  }

  onDidClose(listener) {
    this.closeListeners.add(listener);
    return { dispose: () => this.closeListeners.delete(listener) };
  }

  touch(state) {
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => this.finish(state,
      failure("deadlineExceeded", "Byte stream idle timeout")), (state.limits ?? LIMITS).idleMs);
    state.idleTimer.unref?.();
  }

  async active(state, context) {
    this.assertCommit(state, context);
    await context.assertActive();
    this.assertCommit(state, context);
  }

  assertCommit(state, context) {
    if (this.closed || state.closed || this.connections.get(state.id) !== state) {
      throw state.error ?? failure("unavailable", "Byte stream is closed");
    }
    state.controller.signal.throwIfAborted();
    context.signal?.throwIfAborted();
    context.assertCommit?.();
  }

  #attachSocketLifecycle(state, socket) {
    const onError = () => this.finish(state, failure("unavailable", "Byte stream transport failed"));
    const onClose = () => {
      if (!state.eof) this.finish(state, failure("unavailable", "Byte stream transport closed"));
    };
    const onEnd = () => { state.eof = true; };
    state.socketListeners = { socket, onError, onClose, onEnd };
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.on("end", onEnd);
  }

  #detachSocketLifecycle(state) {
    const prev = state.socketListeners;
    if (!prev) return;
    prev.socket.off("error", prev.onError);
    prev.socket.off("close", prev.onClose);
    prev.socket.off("end", prev.onEnd);
    state.socketListeners = null;
  }

  async #verifyUntrustedTlsSocket(socket, state, context, servername) {
    const cert = typeof socket.getPeerCertificate === "function" ? socket.getPeerCertificate(false) : null;
    const fingerprint256 = typeof cert?.fingerprint256 === "string" ? cert.fingerprint256 : "";
    if (!fingerprint256) {
      throw failure("permissionDenied", "TLS server did not present a verifiable certificate");
    }
    if (this.isTrustedTlsCert(state.pluginId, state.endpoint, fingerprint256)) {
      return;
    }
    if (typeof this.confirmTlsCert !== "function") {
      throw failure("permissionDenied", "Untrusted TLS certificate requires explicit user confirmation");
    }
    const certInfo = Object.freeze({
      endpoint: state.endpoint,
      ...(servername ? { servername } : {}),
      fingerprint256,
      subject: formatCertDistinguishedName(cert.subject),
      issuer: formatCertDistinguishedName(cert.issuer),
      validTo: typeof cert.valid_to === "string" ? cert.valid_to.slice(0, 128) : "",
      reason: String(socket.authorizationError || "UNTRUSTED_CERT").slice(0, 256),
    });
    const decision = await raceWithAbort(
      Promise.resolve(this.confirmTlsCert(certInfo, state, context)),
      state.controller.signal,
    );
    await this.active(state, context);
    if (!decision?.approved) {
      throw failure("permissionDenied", "TLS certificate was rejected by user");
    }
    if (decision.remember === true) {
      this.rememberTlsCert(state.pluginId, state.endpoint, fingerprint256);
    }
  }

  async connect(endpoint, context, hostTransport, connectOptions = {}) {
    let target;
    try { target = canonicalizeStreamEndpoint(endpoint); }
    catch { throw failure("invalidArgument", "Byte stream endpoint is invalid"); }
    if (this.closed) throw failure("unavailable", "Byte stream broker stopped");
    if (!context.runtimeId || !context.pluginId || typeof context.assertActive !== "function") {
      throw failure("unauthenticated", "Byte streams require a host runtime identity");
    }
    const activeLimits = hostTransport ? HOST_LIMITS : LIMITS;
    const count = [...this.connections.values()].filter((state) => state.runtimeId === context.runtimeId).length;
    if (count >= activeLimits.connectionsPerRuntime || this.connections.size >= activeLimits.connectionsTotal) {
      throw failure("resourceExhausted", "Byte stream connection limit exceeded");
    }
    const {
      localApproved = false,
      skipPermissionAuthorize = false,
      allowSelfSigned = false,
      caPem,
      servername,
    } = connectOptions;
    const state = {
      ...target, permission: hostTransport ? "network.hostStream" : "network.stream",
      limits: activeLimits,
      id: randomUUID(), pluginId: context.pluginId, runtimeId: context.runtimeId,
      controller: new AbortController(), bytesRead: 0, bytesWritten: 0,
      sourceOwner: context.sourceOwner, sourceId: context.sourceId,
      closed: false, reading: false, writing: false, socket: null,
      socketListeners: null,
      isTls: target.transport === "tls",
      upgrading: false, upgradeDone: null, suspendRead: null,
    };
    this.connections.set(state.id, state);
    const onAbort = () => this.finish(state, failure("cancelled", "Byte stream connection cancelled"));
    context.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await this.active(state, context);
      this.assertCommit(state, context);
      if (!hostTransport && !skipPermissionAuthorize) {
        await raceWithAbort(Promise.resolve(this.permissionEngine.authorize({ ...context, signal: state.controller.signal }, {
          permission: "network.stream", resources: [target.endpoint],
          reason: `Open byte stream to ${target.endpoint}`,
          operationId: `network.stream:${target.endpoint}`,
          validateBeforeGrant: () => this.assertCommit(state, context),
        })), state.controller.signal);
      }
      await this.active(state, context);
      state.connectTimer = setTimeout(() => this.finish(state,
        failure("deadlineExceeded", "Byte stream connect timeout")), state.limits.connectMs);
      let socket;
      const effectiveServername = servername ?? (net.isIP(target.host) ? undefined : target.host);
      if (hostTransport) {
        socket = await raceWithAbort(hostTransport.open(state.controller.signal), state.controller.signal);
      } else {
        const addresses = net.isIP(target.host)
          ? [{ address: target.host, family: net.isIP(target.host) }]
          : await raceWithAbort(Promise.resolve(this.lookup(target.host, { all: true, verbatim: true })), state.controller.signal);
        await this.active(state, context);
        if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 64) {
          throw failure("unavailable", "Byte stream hostname could not be resolved");
        }
        // Validate the whole DNS answer and pin one literal address. No second
        // lookup, redirect, proxy discovery, or reconnect can change the peer.
        for (const peer of addresses) {
          if (![4, 6].includes(peer.family) || net.isIP(peer.address) !== peer.family) {
            throw failure("unavailable", "Byte stream resolver returned an invalid address");
          }
          // Always block link-local/metadata/multicast and Netcatty's own internal ports.
          if (isUnconditionallyBlockedAddress(peer.address) || this.isInternalControlPort(peer.address, target.port)) {
            throw failure("permissionDenied", "Byte streams cannot reach local or application control endpoints");
          }
          if (!localApproved) {
            const local = isLocalControlAddress(peer.address);
            const allowedTestPeer = this.testLocalEndpoints.has(target.endpoint)
              && !this.isControlEndpoint(peer.address, target.port);
            if ((local && !allowedTestPeer) || (!local && this.isControlEndpoint(peer.address, target.port))) {
              throw failure("permissionDenied", "Byte streams cannot reach local or application control endpoints");
            }
          }
        }
        const peer = addresses[0];
        const params = {
          host: peer.address, port: target.port, family: peer.family,
          highWaterMark: LIMITS.bufferBytes,
        };
        if (target.transport === "tls") {
          Object.assign(params, {
            rejectUnauthorized: !allowSelfSigned, minVersion: "TLSv1.2",
            ...(effectiveServername ? { servername: effectiveServername } : {}),
            ...(caPem ? { ca: caPem } : {}),
            checkServerIdentity: (_name, certificate) => tls.checkServerIdentity(effectiveServername ?? target.host, certificate),
          });
        }
        this.assertCommit(state, context);
        socket = target.transport === "tls" ? this.connectTls(params) : this.connectSocket(params);
      }
      state.socket = socket;
      if (state.closed) { socket.destroy(); throw state.error ?? failure("cancelled", "Byte stream connection cancelled"); }
      this.#attachSocketLifecycle(state, socket);
      socket.pause();
      if (!hostTransport) await raceWithAbort(new Promise((resolve) => socket.once(
        target.transport === "tls" ? "secureConnect" : "connect", resolve,
      )), state.controller.signal);
      await this.active(state, context);
      if (target.transport === "tls" && !socket.authorized) {
        if (!allowSelfSigned) {
          throw failure("permissionDenied", "Byte stream TLS validation failed");
        }
        await this.#verifyUntrustedTlsSocket(socket, state, context, effectiveServername);
      }
      clearTimeout(state.connectTimer);
      state.lifetimeTimer = setTimeout(() => this.finish(state,
        failure("deadlineExceeded", "Byte stream lifetime exceeded")), state.limits.lifetimeMs);
      state.lifetimeTimer.unref?.();
      this.touch(state);
      this.assertCommit(state, context);
      this.record(state, "open");
      return Object.freeze({ handleId: state.id, endpoint: state.endpoint });
    } catch (error) {
      this.finish(state, error);
      throw error;
    } finally {
      context.signal?.removeEventListener("abort", onAbort);
    }
  }

  async upgradeTls(id, options, context) {
    const state = this.get(id, context);
    if (state.isTls) throw failure("failedPrecondition", "Byte stream is already encrypted with TLS");
    if (state.upgrading) throw failure("failedPrecondition", "Byte stream TLS upgrade is already in progress");
    if (state.writing) throw failure("failedPrecondition", "Cannot upgrade TLS while a write is pending");
    const allowSelfSigned = options?.allowSelfSigned === true;
    const caPem = options?.caPem;
    const effectiveServername = options?.servername ?? (net.isIP(state.host) ? undefined : state.host);
    state.upgrading = true;
    let releaseUpgrade;
    state.upgradeDone = new Promise((resolve) => { releaseUpgrade = resolve; });
    const onAbort = () => this.finish(state, failure("cancelled", "Byte stream TLS upgrade cancelled"));
    context.signal?.addEventListener("abort", onAbort, { once: true });
    let upgradeTimer;
    try {
      await this.active(state, context);
      // Pause any active read() waiting on the plaintext socket without closing it.
      if (state.suspendRead) {
        state.suspendRead();
        state.suspendRead = null;
      }
      const rawSocket = state.socket;
      if (!rawSocket || rawSocket.destroyed) {
        throw failure("unavailable", "Byte stream socket is closed");
      }
      this.#detachSocketLifecycle(state);
      const ignoreRawError = () => {};
      rawSocket.on("error", ignoreRawError);
      rawSocket.pause();

      const tlsParams = {
        socket: rawSocket,
        minVersion: "TLSv1.2",
        rejectUnauthorized: !allowSelfSigned,
        highWaterMark: LIMITS.bufferBytes,
        ...(effectiveServername ? { servername: effectiveServername } : {}),
        ...(caPem ? { ca: caPem } : {}),
        checkServerIdentity: (_name, certificate) => tls.checkServerIdentity(effectiveServername ?? state.host, certificate),
      };
      this.assertCommit(state, context);
      const tlsSocket = this.connectTls(tlsParams);
      tlsSocket.pause();
      upgradeTimer = setTimeout(() => {
        tlsSocket.destroy();
        this.finish(state, failure("deadlineExceeded", "Byte stream TLS upgrade timeout"));
      }, state.limits.connectMs);
      upgradeTimer.unref?.();

      await raceWithAbort(new Promise((resolve, reject) => {
        const cleanup = () => {
          tlsSocket.off("secureConnect", onSecure);
          tlsSocket.off("error", onError);
          tlsSocket.off("close", onClose);
        };
        const onSecure = () => { cleanup(); resolve(); };
        const onError = (err) => { cleanup(); reject(err); };
        const onClose = () => { cleanup(); reject(failure("unavailable", "Byte stream closed during TLS upgrade")); };
        tlsSocket.once("secureConnect", onSecure);
        tlsSocket.once("error", onError);
        tlsSocket.once("close", onClose);
      }), state.controller.signal);

      clearTimeout(upgradeTimer);
      upgradeTimer = null;
      // Keep error/close guarded while awaiting interactive TLS cert verification
      // so a peer reset during confirmation cannot emit an unhandled socket error.
      const onPendingTlsError = () => this.finish(state, failure("unavailable", "Byte stream transport failed"));
      const onPendingTlsClose = () => this.finish(state, failure("unavailable", "Byte stream closed during TLS verification"));
      tlsSocket.on("error", onPendingTlsError);
      tlsSocket.on("close", onPendingTlsClose);
      try {
        await this.active(state, context);

        if (!tlsSocket.authorized) {
          if (!allowSelfSigned) {
            throw failure("permissionDenied", "Byte stream TLS validation failed");
          }
          await this.#verifyUntrustedTlsSocket(tlsSocket, state, context, effectiveServername);
        }
      } catch (err) {
        tlsSocket.off("error", onPendingTlsError);
        tlsSocket.off("close", onPendingTlsClose);
        tlsSocket.destroy();
        throw err;
      }

      tlsSocket.off("error", onPendingTlsError);
      tlsSocket.off("close", onPendingTlsClose);
      rawSocket.off("error", ignoreRawError);
      state.socket = tlsSocket;
      state.isTls = true;
      this.#attachSocketLifecycle(state, tlsSocket);
      this.touch(state);
      this.assertCommit(state, context);
      this.record(state, "upgradeTls");

      const cert = typeof tlsSocket.getPeerCertificate === "function" ? tlsSocket.getPeerCertificate(false) : null;
      const protocol = typeof tlsSocket.getProtocol === "function" ? tlsSocket.getProtocol() : undefined;
      const fingerprint256 = typeof cert?.fingerprint256 === "string" ? cert.fingerprint256 : undefined;
      const subject = cert?.subject ? formatCertDistinguishedName(cert.subject) : undefined;
      return Object.freeze({
        upgraded: true,
        authorized: Boolean(tlsSocket.authorized),
        ...(protocol ? { protocol } : {}),
        ...(fingerprint256 ? { fingerprint256 } : {}),
        ...(subject ? { subject } : {}),
      });
    } catch (error) {
      clearTimeout(upgradeTimer);
      const rpcError = error instanceof PluginRpcError
        ? error
        : failure("unavailable", "Byte stream TLS upgrade failed");
      this.finish(state, rpcError);
      throw rpcError;
    } finally {
      context.signal?.removeEventListener("abort", onAbort);
      state.upgrading = false;
      state.upgradeDone = null;
      releaseUpgrade();
    }
  }

  get(id, context) {
    const state = this.connections.get(id);
    if (!state || state.pluginId !== context.pluginId || state.runtimeId !== context.runtimeId
      || state.sourceOwner !== context.sourceOwner || state.sourceId !== context.sourceId) {
      throw failure("permissionDenied", "Byte stream handle does not belong to this runtime");
    }
    return state;
  }

  charge(state, direction, size) {
    if (state.bytesRead + state.bytesWritten + size > (state.limits ?? LIMITS).connectionBytes) {
      throw failure("resourceExhausted", "Byte stream byte limit exceeded");
    }
    this.quotaManager?.chargeBytes(state.runtimeId, "network.stream", size);
    state[direction] += size;
    this.touch(state);
  }

  async read(id, context) {
    const state = this.get(id, context);
    if (state.reading) throw failure("failedPrecondition", "Byte stream has a pending read");
    state.reading = true;
    const onAbort = () => this.finish(state, failure("cancelled", "Byte stream read cancelled"));
    context.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await this.active(state, context);
      while (true) {
        this.assertCommit(state, context);
        if (state.upgrading && state.upgradeDone) {
          await raceWithAbort(state.upgradeDone, state.controller.signal);
          await this.active(state, context);
          continue;
        }
        const socket = state.socket;
        const available = socket.readableLength;
        const bytes = socket.read(Math.min(available || LIMITS.chunkBytes, LIMITS.chunkBytes));
        if (bytes !== null) {
          this.charge(state, "bytesRead", bytes.byteLength);
          await this.active(state, context);
          this.assertCommit(state, context);
          return new Uint8Array(bytes);
        }
        if (state.eof || socket.readableEnded) { this.finish(state); return null; }
        await raceWithAbort(new Promise((resolve) => {
          const readable = () => {
            if (state.suspendRead === readable) state.suspendRead = null;
            socket.off("end", readable);
            socket.off("readable", readable);
            state.controller.signal.removeEventListener("abort", readable);
            resolve();
          };
          state.suspendRead = readable;
          socket.once("readable", readable);
          socket.once("end", readable);
          // Remove listeners even when cancellation wins the race.
          state.controller.signal.addEventListener("abort", readable, { once: true });
        }), state.controller.signal);
        await this.active(state, context);
      }
    } catch (error) {
      this.finish(state, error);
      throw error;
    } finally {
      state.suspendRead = null;
      context.signal?.removeEventListener("abort", onAbort);
      state.reading = false;
    }
  }

  async write(id, bytes, context) {
    const state = this.get(id, context);
    if (state.upgrading) throw failure("failedPrecondition", "Cannot write while TLS upgrade is in progress");
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > LIMITS.chunkBytes) {
      throw failure("invalidArgument", "Byte stream chunk size is invalid");
    }
    if (state.writing) throw failure("resourceExhausted", "Byte stream has a pending write");
    state.writing = true;
    const onAbort = () => this.finish(state, failure("cancelled", "Byte stream write cancelled"));
    context.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await this.active(state, context);
      this.assertCommit(state, context);
      this.charge(state, "bytesWritten", bytes.byteLength);
      const owned = Buffer.from(bytes);
      await raceWithAbort(new Promise((resolve, reject) => {
        state.socket.write(owned, (error) => error ? reject(error) : resolve());
      }), state.controller.signal);
      await this.active(state, context);
    } catch (error) {
      this.finish(state, error);
      throw error;
    } finally {
      context.signal?.removeEventListener("abort", onAbort);
      state.writing = false;
    }
  }

  close(id, context) { this.finish(this.get(id, context)); }

  releaseRuntime(runtimeId) {
    for (const state of this.connections.values()) {
      if (state.runtimeId === runtimeId) this.finish(state,
        failure("unavailable", "Byte stream runtime stopped"));
    }
  }

  shutdown() {
    this.closed = true;
    for (const state of this.connections.values()) this.finish(state,
      failure("unavailable", "Byte stream broker stopped"));
    this.revocation.dispose();
  }
}

module.exports = { LIMITS, HOST_LIMITS, PluginByteStreamBroker, canonicalizeStreamEndpoint, isLocalControlAddress };
