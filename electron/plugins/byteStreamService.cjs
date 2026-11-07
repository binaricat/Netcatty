"use strict";

const { randomUUID } = require("node:crypto");
const os = require("node:os");
const { normalizeStreamAddress } = require("./byteStreamEndpoint.cjs");
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

class PluginByteStreamService {
  constructor(options) {
    this.database = options.database;
    this.runtimeSupervisor = options.runtimeSupervisor;
    this.records = new Map();
    this.closedHandles = new Map();
    this.closed = false;
    this.broker = new PluginByteStreamBroker({
      permissionEngine: options.permissionEngine,
      quotaManager: options.quotaManager,
      // The public host service never forwards transport fixture overrides.
      isControlEndpoint: (address) => {
        const normalized = normalizeStreamAddress(address);
        return normalized !== null && Object.values(os.networkInterfaces()).flat()
          .some((item) => item?.address && normalizeStreamAddress(item.address) === normalized);
      },
      audit: (pluginId, operation, fields, state) => {
        if (this.sourceMatches(state)) this.database.recordSecurityAudit(pluginId, operation, fields);
      },
    });
    this.brokerClose = this.broker.onDidClose((state, reason) => {
      if (reason) this.closeRecord(this.records.get(state.id), reason);
    });
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
    // obtains its exact endpoint grant; attach/close prove handle ownership.
    // The registry public flag skips only the generic permission middleware.
    // Runtime authentication and quota middleware still apply to every call.
    registry.registerRequest("network.stream.connect", async ({ endpoint }, caller) => {
      const context = await this.authenticate(caller);
      const handle = await this.broker.connect(endpoint, context);
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
    }, { validateParams: validator("ByteStreamConnectRequest"), metadata: { capability: "network.stream", mutating: true, public: true } });
    registry.registerRequest("network.stream.attach", async ({ handleId }, caller) => {
      const context = await this.authenticate(caller);
      const record = this.get(handleId, context);
      if (record.attached) throw new PluginRpcError(RPC_ERRORS.failedPrecondition, "Byte stream is already attached");
      record.attached = true;
      try {
        record.output = await this.runtimeSupervisor.openStream(context.pluginId, record.outputStreamId, LIMITS.bufferBytes, {
          expectedIdentity: context,
          onClose: (reason) => { if (reason !== "end") this.closeRecord(record); },
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
    this.streamRegistration?.dispose();
    this.closedHandles.clear();
  }
}

module.exports = { PluginByteStreamService, FEATURE };
