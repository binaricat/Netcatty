"use strict";

const { randomUUID } = require("node:crypto");
const net = require("node:net");
const os = require("node:os");
const {
  canonicalizeStreamEndpoint,
  isLocalControlAddress,
  normalizeStreamAddress,
} = require("./byteStreamEndpoint.cjs");
const { PluginByteStreamBroker, LIMITS } = require("./byteStreamBroker.cjs");
const { PluginRpcError, RPC_ERRORS } = require("./rpcRouter.cjs");
const { createDefinitionValidator } = require("./contractValidator.cjs");

const FEATURE = require("./generated/plugin-contract.schema.json").$defs.ByteStreamFeature.const;
function denied() { return new PluginRpcError(RPC_ERRORS.permissionDenied, "Byte stream runtime or source binding is invalid"); }
function validator(name) {
  const validate = createDefinitionValidator(name);
  return (params) => {
    if (!validate(params)) throw new PluginRpcError(RPC_ERRORS.invalidArgument, "Byte stream parameters violate the contract");
    return params;
  };
}

function manifestStreamDeclaration(manifest, canonicalEndpoint) {
  const declarations = [
    ...(manifest?.permissions?.required ?? []),
    ...(manifest?.permissions?.optional ?? []),
  ];
  let declared = false;
  let staticMatch = false;
  for (const item of declarations) {
    if (item === "network.stream") {
      declared = true;
    } else if (item && typeof item === "object" && item.permission === "network.stream") {
      declared = true;
      if (Array.isArray(item.resources)) {
        for (const resource of item.resources) {
          try {
            if (canonicalizeStreamEndpoint(resource).endpoint === canonicalEndpoint) {
              staticMatch = true;
            }
          } catch { /* ignore invalid entry */ }
        }
      }
    }
  }
  return { declared, staticMatch };
}

function isOwnMachineAddress(address) {
  const normalized = normalizeStreamAddress(address);
  return normalized !== null && Object.values(os.networkInterfaces()).flat()
    .some((item) => item?.address && normalizeStreamAddress(item.address) === normalized);
}

function isLocalHostLiteral(host) {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (!net.isIP(host)) return false;
  return isLocalControlAddress(host) || isOwnMachineAddress(host);
}

class PluginByteStreamService {
  constructor(options) {
    this.database = options.database;
    this.permissionEngine = options.permissionEngine;
    this.runtimeSupervisor = options.runtimeSupervisor;
    this.interactionService = options.interactionService ?? null;
    this.records = new Map();
    this.closedHandles = new Map();
    this.memoryEndpoints = new Map();
    this.memoryTrustedCerts = new Map();
    this.closed = false;
    this.broker = new PluginByteStreamBroker({
      permissionEngine: options.permissionEngine,
      quotaManager: options.quotaManager,
      // The public host service never forwards transport fixture overrides.
      isControlEndpoint: (address) => isOwnMachineAddress(address),
      isTrustedTlsCert: (pluginId, endpoint, fingerprint256) => (
        this.isTrustedTlsCert(pluginId, endpoint, fingerprint256)
      ),
      rememberTlsCert: (pluginId, endpoint, fingerprint256) => (
        this.rememberTrustedTlsCert(pluginId, endpoint, fingerprint256)
      ),
      confirmTlsCert: async (certInfo, _state, context) => (
        this.#confirmTlsCert(certInfo, context)
      ),
      audit: (pluginId, operation, fields, state) => {
        if (this.sourceMatches(state)) this.database.recordSecurityAudit(pluginId, operation, fields);
      },
    });
    this.brokerClose = this.broker.onDidClose((state, reason) => {
      if (reason) this.closeRecord(this.records.get(state.id), reason);
    });
    this.revocation = this.permissionEngine?.onDidRevoke?.((event) => {
      if (event.permission === undefined || event.permission === "network.stream") {
        if (event.resource) {
          this.revokeDynamicEndpoint(event.pluginId, event.resource);
        } else {
          this.clearRememberedEndpoints(event.pluginId);
        }
      }
    }) ?? { dispose() {} };
  }

  #ownerKey(pluginId) {
    return typeof this.database?.privateOwner === "function"
      ? this.database.privateOwner(pluginId)
      : pluginId;
  }

  #readPref(key, fallback) {
    if (this.database?.db) {
      try {
        const row = this.database.db.prepare("SELECT value_json FROM plugin_host_preferences WHERE key = ?").get(key);
        if (row?.value_json) return JSON.parse(row.value_json);
      } catch { /* fall through */ }
    }
    return fallback;
  }

  #writePref(key, value) {
    if (this.database?.db) {
      try {
        this.database.db.prepare(
          "INSERT INTO plugin_host_preferences(key,value_json,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at",
        ).run(key, JSON.stringify(value), Date.now());
      } catch { /* ignore when mock db */ }
    }
  }

  #deletePref(key) {
    if (this.database?.db) {
      try {
        this.database.db.prepare("DELETE FROM plugin_host_preferences WHERE key = ?").run(key);
      } catch { /* ignore when mock db */ }
    }
  }

  #endpointPrefKey(pluginId) {
    return `permission:${this.#ownerKey(pluginId)}:stream-endpoints`;
  }

  #tlsCertPrefKey(pluginId) {
    return `permission:${this.#ownerKey(pluginId)}:stream-tls-certs`;
  }

  listDynamicEndpoints(pluginId) {
    const key = this.#endpointPrefKey(pluginId);
    const list = this.#readPref(key, this.memoryEndpoints.get(key) ?? []);
    return Array.isArray(list) ? list : [];
  }

  #rememberKey(endpoint, localAllowed = false) {
    return localAllowed ? `${endpoint}#local` : endpoint;
  }

  isDynamicEndpointRemembered(pluginId, endpoint, localAllowed = false) {
    const list = this.listDynamicEndpoints(pluginId);
    if (localAllowed) {
      return list.includes(this.#rememberKey(endpoint, true));
    }
    return list.includes(endpoint) || list.includes(this.#rememberKey(endpoint, true));
  }

  rememberDynamicEndpoint(pluginId, endpoint, localAllowed = false) {
    const key = this.#endpointPrefKey(pluginId);
    const current = new Set(this.listDynamicEndpoints(pluginId));
    current.add(this.#rememberKey(endpoint, localAllowed));
    const next = [...current].slice(-256);
    this.memoryEndpoints.set(key, next);
    this.#writePref(key, next);
  }

  revokeDynamicEndpoint(pluginId, endpoint) {
    const key = this.#endpointPrefKey(pluginId);
    const localKey = this.#rememberKey(endpoint, true);
    const next = this.listDynamicEndpoints(pluginId).filter((item) => item !== endpoint && item !== localKey);
    this.memoryEndpoints.set(key, next);
    if (next.length === 0) this.#deletePref(key);
    else this.#writePref(key, next);
    // Also revoke remembered certs for that endpoint.
    const certKey = this.#tlsCertPrefKey(pluginId);
    const certs = { ...this.#readPref(certKey, this.memoryTrustedCerts.get(certKey) ?? {}) };
    if (endpoint in certs) {
      delete certs[endpoint];
      this.memoryTrustedCerts.set(certKey, certs);
      if (Object.keys(certs).length === 0) this.#deletePref(certKey);
      else this.#writePref(certKey, certs);
    }
  }

  clearRememberedEndpoints(pluginId) {
    const key = this.#endpointPrefKey(pluginId);
    const certKey = this.#tlsCertPrefKey(pluginId);
    this.memoryEndpoints.delete(key);
    this.memoryTrustedCerts.delete(certKey);
    this.#deletePref(key);
    this.#deletePref(certKey);
  }

  isTrustedTlsCert(pluginId, endpoint, fingerprint256) {
    const certKey = this.#tlsCertPrefKey(pluginId);
    const certs = this.#readPref(certKey, this.memoryTrustedCerts.get(certKey) ?? {});
    return Array.isArray(certs?.[endpoint]) && certs[endpoint].includes(fingerprint256);
  }

  rememberTrustedTlsCert(pluginId, endpoint, fingerprint256) {
    const certKey = this.#tlsCertPrefKey(pluginId);
    const certs = { ...this.#readPref(certKey, this.memoryTrustedCerts.get(certKey) ?? {}) };
    const existing = new Set(Array.isArray(certs[endpoint]) ? certs[endpoint] : []);
    existing.add(fingerprint256);
    certs[endpoint] = [...existing].slice(-16);
    this.memoryTrustedCerts.set(certKey, certs);
    this.#writePref(certKey, certs);
  }

  async #confirmDynamicEndpoint(target, context, localRequested = false) {
    const isLocal = localRequested || isLocalHostLiteral(target.host);
    if (this.interactionService?.owner) {
      const result = await this.interactionService.request({
        kind: "network.stream.confirm",
        endpoint: target.endpoint,
        host: target.host,
        port: target.port,
        transport: target.transport,
        isLocal,
      }, context);
      if (result?.cancelled || !result?.approved) {
        throw new PluginRpcError(RPC_ERRORS.cancelled, "Byte stream connection cancelled");
      }
      if (result.remember === true) {
        this.rememberDynamicEndpoint(context.pluginId, target.endpoint, isLocal);
      }
      return;
    }
    // Non-interactive / headless test fallback: defer to permissionEngine hook.
    await this.permissionEngine.authorize({ ...context, signal: context.signal }, {
      permission: "network.stream",
      resources: [target.endpoint],
      reason: `Open byte stream to ${target.endpoint}`,
      operationId: `network.stream:${target.endpoint}`,
      validateBeforeGrant: () => context.assertCommit?.(),
    });
  }

  async #confirmTlsCert(certInfo, context) {
    if (this.interactionService?.owner) {
      const result = await this.interactionService.request({
        kind: "network.stream.tlsConfirm",
        ...certInfo,
      }, context);
      if (result?.cancelled || !result?.approved) {
        return { approved: false };
      }
      return { approved: true, remember: result.remember === true };
    }
    return { approved: false };
  }

  sourceMatches(identity) {
    const active = this.database.getActivePlugin(identity.pluginId);
    const retained = this.database.getRetainedPluginSource(identity.pluginId);
    return Boolean(active?.enabled && identity.sourceOwner && identity.sourceId
      && active.source?.id === identity.sourceId && retained?.id === identity.sourceId
      && this.database.privateOwner(identity.pluginId) === identity.sourceOwner
      && this.database.publicPluginId(identity.sourceOwner) === identity.pluginId);
  }

  async authenticate(context) {
    await context.assertActive();
    const assertCommit = () => {
      context.signal?.throwIfAborted();
      const current = this.runtimeSupervisor.getRuntimeIdentity(context.pluginId);
      if (this.closed || !current || current.runtimeId !== context.runtimeId
        || current.pluginVersion !== context.pluginVersion
        || current.securityPrincipal !== context.securityPrincipal
        || current.sourceOwner !== context.sourceOwner || current.sourceId !== context.sourceId
        || !this.sourceMatches(context)) throw denied();
    };
    assertCommit();
    if (!context.manifest?.features?.required?.includes(FEATURE)) {
      throw new PluginRpcError(RPC_ERRORS.unsupported, "Byte stream feature was not negotiated");
    }
    return Object.freeze({ ...context, assertCommit,
      assertActive: async () => { await context.assertActive(); assertCommit(); },
    });
  }

  register(registry) {
    // These routes own authorization: connect authenticates before the broker
    // obtains its exact endpoint grant; attach/close/upgradeTls prove handle ownership.
    // The registry public flag skips only the generic permission middleware.
    // Runtime authentication and quota middleware still apply to every call.
    registry.registerRequest("network.stream.connect", async (params, caller) => {
      const context = await this.authenticate(caller);
      let target;
      try { target = canonicalizeStreamEndpoint(params.endpoint); }
      catch { throw new PluginRpcError(RPC_ERRORS.invalidArgument, "Byte stream endpoint is invalid"); }
      const { declared, staticMatch } = manifestStreamDeclaration(context.manifest, target.endpoint);
      const isLocalTarget = params.allowLocal === true || isLocalHostLiteral(target.host);
      const isDynamic = !staticMatch || params.allowLocal === true;
      const connectOptions = {
        allowSelfSigned: params.allowSelfSigned === true,
        ...(params.caPem === undefined ? {} : { caPem: params.caPem }),
        ...(params.servername === undefined ? {} : { servername: params.servername }),
      };
      if (isDynamic && declared) {
        const mode = this.permissionEngine.getMode?.(context, "network.stream") ?? "allow";
        if (mode === "deny") {
          throw new PluginRpcError(RPC_ERRORS.permissionDenied, "Plugin permission is disabled: network.stream");
        }
        if (!this.isDynamicEndpointRemembered(context.pluginId, target.endpoint, isLocalTarget)) {
          await this.#confirmDynamicEndpoint(target, context, isLocalTarget);
        }
        await context.assertActive();
        connectOptions.localApproved = isLocalTarget;
        connectOptions.skipPermissionAuthorize = true;
      }
      return this.connect(target.endpoint, context, undefined, connectOptions);
    }, { validateParams: validator("ByteStreamConnectRequest"), metadata: { capability: "network.stream", mutating: true, public: true } });

    registry.registerRequest("network.stream.upgradeTls", async ({ handleId, servername, allowSelfSigned, caPem }, caller) => {
      const context = await this.authenticate(caller);
      const record = this.get(handleId, context);
      return this.broker.upgradeTls(handleId, {
        ...(servername === undefined ? {} : { servername }),
        allowSelfSigned: allowSelfSigned === true,
        ...(caPem === undefined ? {} : { caPem }),
      }, record.context);
    }, { validateParams: validator("ByteStreamUpgradeTlsRequest"), metadata: { capability: "network.stream", mutating: true, public: true } });

    registry.registerRequest("network.stream.attach", async ({ handleId }, caller) => {
      const context = await this.authenticate(caller);
      const record = this.get(handleId, context);
      if (record.attached) throw new PluginRpcError(RPC_ERRORS.failedPrecondition, "Byte stream is already attached");
      record.attached = true;
      try {
        record.output = await this.runtimeSupervisor.openStream(context.pluginId, record.outputStreamId, LIMITS.bufferBytes, {
          expectedIdentity: context,
          onClose: (reason) => { if (reason !== "end") this.closeRecord(record, reason instanceof Error ? reason : undefined); },
        });
        context.assertCommit();
        if (record.closing) throw new PluginRpcError(RPC_ERRORS.cancelled, "Byte stream attachment cancelled");
        context.signal?.addEventListener("abort", record.abort, { once: true });
        // A cancelled attachment cannot leave a producer running after its RPC.
        void this.pump(record).finally(() => context.signal?.removeEventListener("abort", record.abort));
        return { attached: true };
      } catch (error) {
        const alreadyClosing = record.closing;
        this.closeRecord(record, error);
        if (alreadyClosing) { try { record.output?.cancel(); } catch {} }
        throw error;
      }
    }, { validateParams: validator("ByteStreamHandleRequest"), metadata: { capability: "network.stream", mutating: true, public: true } });
    registry.registerRequest("network.stream.close", async ({ handleId }, caller) => {
      const context = await this.authenticate(caller);
      if (!this.wasClosed(handleId, context)) this.closeRecord(this.get(handleId, context));
      return null;
    }, { validateParams: validator("ByteStreamHandleRequest"), metadata: { capability: "network.stream", mutating: true, public: true } });
    this.streamRegistration = registry.registerIncomingStream(async (stream, caller) => {
      const record = [...this.records.values()].find((item) => item.inputStreamId === stream.streamId);
      if (!record) return false;
      const context = await this.authenticate(caller);
      this.get(record.handleId, context);
      if (record.input || stream.windowBytes !== LIMITS.bufferBytes) throw denied();
      record.input = stream;
      stream.bind({
        onChunk: async (chunk, release) => {
          try {
            if (chunk.encoding !== "binary" || !(chunk.bytes instanceof Uint8Array)) throw denied();
            await this.broker.write(record.handleId, chunk.bytes, record.context);
            record.context.assertCommit();
            release();
          } catch (error) { this.closeRecord(record, error); }
        },
        onClose: () => this.closeRecord(record),
      });
      return true;
    });
  }

  async connect(endpoint, context, hostTransport, connectOptions) {
    const handle = await this.broker.connect(endpoint, context, hostTransport, connectOptions);
    try {
      context.assertCommit();
      this.broker.get(handle.handleId, context);
      const record = {
        ...handle, context,
        inputStreamId: `byte-in-${randomUUID()}`, outputStreamId: `byte-out-${randomUUID()}`,
        attached: false, closing: false, input: null, output: null,
      };
      this.records.set(handle.handleId, record);
      record.abort = () => this.closeRecord(record);
      context.signal?.addEventListener("abort", record.abort, { once: true });
      return { ...handle, inputStreamId: record.inputStreamId,
        outputStreamId: record.outputStreamId, windowBytes: LIMITS.bufferBytes };
    } catch (error) {
      const state = this.broker.connections.get(handle.handleId);
      if (state) this.broker.finish(state, error);
      throw error;
    }
  }

  get(handleId, context) {
    const record = this.records.get(handleId);
    if (!record || record.closing || record.context.runtimeId !== context.runtimeId
      || record.context.pluginId !== context.pluginId || record.context.sourceOwner !== context.sourceOwner
      || record.context.sourceId !== context.sourceId) throw denied();
    return record;
  }

  wasClosed(handleId, context) {
    const owner = this.closedHandles.get(handleId);
    return owner && owner.runtimeId === context.runtimeId && owner.pluginId === context.pluginId
      && owner.sourceOwner === context.sourceOwner && owner.sourceId === context.sourceId;
  }

  async pump(record) {
    try {
      while (!record.closing) {
        const bytes = await this.broker.read(record.handleId, record.context);
        if (record.closing) return;
        record.context.assertCommit();
        if (bytes === null) { record.output.end(); break; }
        await record.output.write(bytes);
      }
      this.closeRecord(record);
    } catch (error) { this.closeRecord(record, error); }
  }

  closeRecord(record, reason) {
    if (!record || record.closing) return;
    record.closing = true;
    record.context.signal?.removeEventListener("abort", record.abort);
    this.records.delete(record.handleId);
    const { pluginId, runtimeId, sourceOwner, sourceId } = record.context;
    this.closedHandles.set(record.handleId, { pluginId, runtimeId, sourceOwner, sourceId });
    while (this.closedHandles.size > 256) this.closedHandles.delete(this.closedHandles.keys().next().value);
    const state = this.broker.connections.get(record.handleId);
    if (state) this.broker.finish(state, reason);
    try { record.output?.cancel(); } catch {}
    try { void Promise.resolve(record.input?.cancel()).catch(() => {}); } catch {}
  }

  releaseRuntime(runtimeId) {
    for (const record of this.records.values()) {
      if (record.context.runtimeId === runtimeId) this.closeRecord(record);
    }
    this.broker.releaseRuntime(runtimeId);
    for (const [id, owner] of this.closedHandles) {
      if (owner.runtimeId === runtimeId) this.closedHandles.delete(id);
    }
  }

  shutdown() {
    this.closed = true;
    for (const record of this.records.values()) this.closeRecord(record);
    this.broker.shutdown();
    this.brokerClose.dispose();
    this.revocation.dispose();
    this.streamRegistration?.dispose();
    this.closedHandles.clear();
  }
}

module.exports = { PluginByteStreamService, FEATURE };
