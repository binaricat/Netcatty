"use strict";

const {
  PLUGIN_RPC_DEFAULT_TIMEOUT_MS,
  PLUGIN_RPC_MAX_PENDING,
} = require("./constants.cjs");
const { assertStreamFrameSchema } = require("./contractValidator.cjs");

let contractRuntimePromise;
function loadContractRuntime() {
  contractRuntimePromise ??= import("@netcatty/plugin-contract");
  return contractRuntimePromise;
}

function getTransferredBuffer(envelope) {
  return envelope && Object.prototype.hasOwnProperty.call(envelope, "transfer")
    ? envelope.transfer
    : undefined;
}

function assertStreamEnvelopeShape(envelope) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new TypeError("Invalid plugin stream envelope");
  }
  const keys = Reflect.ownKeys(envelope);
  if (keys.some((key) => typeof key !== "string" || (key !== "frame" && key !== "transfer"))) {
    throw new TypeError("Plugin stream envelope contains unknown properties");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(envelope, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("Plugin stream envelope must contain enumerable data properties");
    }
  }
  if (!Object.hasOwn(envelope, "frame")) throw new TypeError("Plugin stream envelope is missing its frame");
  return envelope;
}

function raceWithSignal(operation, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

class PluginStreamRouter {
  constructor(options) {
    this.send = options.send;
    this.onIncomingStream = options.onIncomingStream ?? (() => false);
    this.incoming = new Map();
    this.outgoing = new Map();
    this.maxStreams = options.maxStreams ?? PLUGIN_RPC_MAX_PENDING;
    this.openTimeoutMs = options.openTimeoutMs ?? PLUGIN_RPC_DEFAULT_TIMEOUT_MS;
    this.closed = false;
  }

  async accept(rawEnvelope) {
    if (this.closed) throw new Error("Plugin stream router is closed");
    assertStreamEnvelopeShape(rawEnvelope);
    assertStreamFrameSchema(rawEnvelope.frame);
    const contract = await loadContractRuntime();
    if (this.closed) throw new Error("Plugin stream router is closed");
    const envelope = contract.createMessagePortStreamEnvelope(
      rawEnvelope.frame,
      getTransferredBuffer(rawEnvelope),
    );
    const frame = envelope.frame;
    if (frame.kind === "open") {
      if (
        this.incoming.has(frame.streamId)
        || this.outgoing.has(frame.streamId)
        || this.incoming.size + this.outgoing.size >= this.maxStreams
      ) {
        throw new Error(`Plugin stream cannot be opened: ${frame.streamId}`);
      }
      const state = {
        streamId: frame.streamId,
        nextSequence: 1,
        availableBytes: frame.windowBytes,
        windowBytes: frame.windowBytes,
        updateSequence: -1,
        openController: new AbortController(),
        closed: false,
      };
      this.incoming.set(frame.streamId, state);
      let accepted;
      let openTimedOut = false;
      const openTimer = setTimeout(() => {
        openTimedOut = true;
        state.openController.abort(new Error(`Plugin stream owner timed out: ${frame.streamId}`));
      }, this.openTimeoutMs);
      try {
        accepted = await raceWithSignal(Promise.resolve(this.onIncomingStream({
          streamId: frame.streamId,
          windowBytes: frame.windowBytes,
          signal: state.openController.signal,
          bind: (handlers) => this.bindIncoming(frame.streamId, handlers),
          cancel: () => this.#cancelIncoming(state),
        })), state.openController.signal);
      } catch (error) {
        if (!this.closed) {
          try {
            await this.#cancelIncoming(state, error);
          } catch {
            // The owner-selection error remains the primary protocol failure.
          }
        } else {
          state.closed = true;
          this.incoming.delete(frame.streamId);
        }
        if (openTimedOut) return;
        throw error;
      } finally {
        clearTimeout(openTimer);
      }
      if (accepted !== true) {
        await this.#cancelIncoming(state, new Error(`Plugin stream was not accepted: ${frame.streamId}`));
      }
      return;
    }
    if (frame.kind === "windowUpdate") {
      const outgoing = this.outgoing.get(frame.streamId);
      if (!outgoing) throw new Error(`Unknown outgoing plugin stream: ${frame.streamId}`);
      if (frame.sequence !== outgoing.lastUpdateSequence + 1) {
        throw new Error(`Out-of-order stream credit update: ${frame.streamId}`);
      }
      outgoing.lastUpdateSequence = frame.sequence;
      outgoing.availableBytes += frame.creditBytes;
      if (outgoing.availableBytes > outgoing.maxCreditBytes) {
        throw new Error(`Plugin stream credit exceeds its negotiated window: ${frame.streamId}`);
      }
      if (outgoing.terminalKind === "end" || outgoing.terminalKind === "cancel") {
        if (outgoing.availableBytes === outgoing.maxCreditBytes) {
          this.outgoing.delete(frame.streamId);
        }
        return;
      }
      if (outgoing.closed) throw new Error(`Unknown outgoing plugin stream: ${frame.streamId}`);
      this.#flushOutgoing(outgoing);
      return;
    }
    if (frame.kind === "cancel" && this.outgoing.has(frame.streamId)) {
      const outgoing = this.outgoing.get(frame.streamId);
      if (frame.sequence !== Math.max(1, outgoing.lastUpdateSequence + 1)) {
        throw new Error(`Out-of-order stream cancellation: ${frame.streamId}`);
      }
      outgoing.closed = true;
      this.outgoing.delete(frame.streamId);
      for (const pending of outgoing.queue) pending.reject(new Error(`Plugin stream cancelled: ${frame.streamId}`));
      outgoing.queue.length = 0;
      outgoing.queuedBytes = 0;
      this.#notifyOutgoingClosed(outgoing, "cancel");
      return;
    }
    const state = this.incoming.get(frame.streamId);
    if (!state || state.closed) throw new Error(`Unknown incoming plugin stream: ${frame.streamId}`);
    if (frame.sequence !== state.nextSequence) {
      throw new Error(`Out-of-order plugin stream frame: ${frame.streamId}`);
    }
    state.nextSequence += 1;
    if (frame.kind === "chunk") {
      const creditBytes = frame.data.byteLength;
      if (creditBytes > state.availableBytes) {
        throw new Error(`Plugin stream exceeded receive credit: ${frame.streamId}`);
      }
      state.availableBytes -= creditBytes;
      const materialized = contract.materializeStreamChunk(frame.data, envelope.transfer);
      const listener = state.onChunk;
      if (!listener) {
        await this.#cancelIncoming(state);
        return;
      }
      let released = false;
      const release = () => {
        if (released || state.closed) return;
        released = true;
        state.availableBytes += creditBytes;
        state.updateSequence += 1;
        try {
          this.send({
            frame: {
              streamId: state.streamId,
              sequence: state.updateSequence,
              kind: "windowUpdate",
              creditBytes,
            },
          });
        } catch (error) {
          state.closed = true;
          this.incoming.delete(state.streamId);
          state.openController.abort(error);
          try {
            const closing = state.onClose?.(error);
            if (closing && typeof closing.then === "function") void closing.catch(() => {});
          } catch {}
          throw error;
        }
      };
      await listener(materialized, release);
      return;
    }
    state.closed = true;
    this.incoming.delete(frame.streamId);
    const closeReason = frame.kind === "error" ? frame.error : frame.kind;
    const abortReason = frame.kind === "error"
      ? frame.error
      : new Error(`Plugin stream ${frame.kind}: ${frame.streamId}`);
    state.openController.abort(abortReason);
    try {
      if (frame.kind === "cancel" && state.availableBytes < state.windowBytes) {
        // The producer has stopped. Return discarded credit once so it can
        // retire its terminal state, without releasing more queued writes.
        state.updateSequence += 1;
        this.send({ frame: {
          streamId: state.streamId, sequence: state.updateSequence,
          kind: "windowUpdate", creditBytes: state.windowBytes - state.availableBytes,
        } });
      }
    } finally { await state.onClose?.(closeReason); }
  }

  bindIncoming(streamId, handlers) {
    const state = this.incoming.get(streamId);
    if (!state || state.closed) throw new Error(`Unknown incoming plugin stream: ${streamId}`);
    if (!handlers || typeof handlers !== "object" || Array.isArray(handlers)) {
      throw new TypeError("Plugin incoming stream handlers must be an object");
    }
    if (typeof handlers.onChunk !== "function") {
      throw new TypeError("Plugin incoming stream onChunk handler is required");
    }
    if (handlers.onClose != null && typeof handlers.onClose !== "function") {
      throw new TypeError("Plugin incoming stream onClose handler must be a function");
    }
    state.onChunk = handlers.onChunk;
    state.onClose = handlers.onClose;
  }

  async openOutgoing(streamId, windowBytes, options = {}) {
    if (options.onClose !== undefined && typeof options.onClose !== "function") throw new TypeError("Stream onClose must be a function");
    if (
      this.closed
      || this.outgoing.has(streamId)
      || this.incoming.has(streamId)
      || this.incoming.size + this.outgoing.size >= this.maxStreams
    ) {
      throw new Error(`Plugin stream cannot be opened: ${streamId}`);
    }
    const contract = await loadContractRuntime();
    if (
      this.closed
      || this.outgoing.has(streamId)
      || this.incoming.has(streamId)
      || this.incoming.size + this.outgoing.size >= this.maxStreams
    ) {
      throw new Error(`Plugin stream cannot be opened: ${streamId}`);
    }
    const envelope = contract.createMessagePortStreamEnvelope({
      streamId,
      sequence: 0,
      kind: "open",
      windowBytes,
    });
    const state = {
      streamId,
      nextSequence: 1,
      availableBytes: windowBytes,
      maxCreditBytes: windowBytes,
      lastUpdateSequence: -1,
      contract,
      queue: [],
      queuedBytes: 0,
      closed: false,
      terminalKind: null,
      onClose: options.onClose,
    };
    this.outgoing.set(streamId, state);
    try {
      this.send(envelope);
    } catch (error) {
      state.closed = true;
      this.outgoing.delete(streamId);
      throw error;
    }
    return {
      write: (data) => this.#queueOutgoing(state, data),
      end: () => this.#endOutgoing(state),
      cancel: () => this.#cancelOutgoing(state),
    };
  }

  async #queueOutgoing(state, data) {
    if (state.closed) throw new Error(`Plugin stream is closed: ${state.streamId}`);
    const contract = await loadContractRuntime();
    if (this.closed || state.closed || this.outgoing.get(state.streamId) !== state) {
      throw new Error(`Plugin stream is closed: ${state.streamId}`);
    }
    let chunk;
    if (data instanceof Uint8Array) {
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      const buffer = copy.buffer;
      if (buffer.byteLength > contract.PLUGIN_STREAM_MAX_CHUNK_BYTES) {
        throw new Error(`Plugin stream chunk exceeds ${contract.PLUGIN_STREAM_MAX_CHUNK_BYTES} bytes`);
      }
      chunk = { encoding: "transfer", byteLength: buffer.byteLength, transfer: buffer };
    } else {
      chunk = contract.createJsonStreamChunk(data);
    }
    if (state.queuedBytes + chunk.byteLength > state.maxCreditBytes) {
      throw new Error(`Plugin stream pending queue exceeds its negotiated window: ${state.streamId}`);
    }
    return new Promise((resolve, reject) => {
      state.queue.push({ chunk, resolve, reject });
      state.queuedBytes += chunk.byteLength;
      this.#flushOutgoing(state);
    });
  }

  #flushOutgoing(state) {
    while (!state.closed && state.queue.length > 0) {
      const pending = state.queue[0];
      if (pending.chunk.byteLength > state.availableBytes) break;
      state.queue.shift();
      state.queuedBytes -= pending.chunk.byteLength;
      state.availableBytes -= pending.chunk.byteLength;
      const frame = {
        streamId: state.streamId,
        sequence: state.nextSequence,
        kind: "chunk",
        data: pending.chunk.encoding === "transfer"
          ? { encoding: "transfer", byteLength: pending.chunk.byteLength }
          : pending.chunk,
      };
      state.nextSequence += 1;
      try {
        const envelope = state.contract.createMessagePortStreamEnvelope(frame, pending.chunk.transfer);
        this.send(envelope, pending.chunk.transfer ? [pending.chunk.transfer] : []);
        pending.resolve();
      } catch (error) {
        pending.reject(error);
        this.#failOutgoing(state, error);
        throw error;
      }
    }
  }

  #failOutgoing(state, error) {
    if (state.closed) return;
    state.closed = true;
    this.outgoing.delete(state.streamId);
    for (const pending of state.queue) pending.reject(error);
    state.queue.length = 0;
    state.queuedBytes = 0;
    this.#notifyOutgoingClosed(state, error);
  }

  #notifyOutgoingClosed(state, reason) {
    if (state.closeNotified) return;
    state.closeNotified = true;
    try { state.onClose?.(reason); } catch {}
  }

  #finishOutgoing(state, kind) {
    if (state.closed) return;
    state.closed = true;
    state.terminalKind = kind;
    const error = new Error(`Plugin stream ${kind}`);
    let terminalSent = false;
    try {
      this.send(state.contract.createMessagePortStreamEnvelope({
        streamId: state.streamId,
        sequence: state.nextSequence,
        kind,
      }));
      terminalSent = true;
    } finally {
      for (const pending of state.queue) pending.reject(error);
      state.queue.length = 0;
      state.queuedBytes = 0;
      if (
        !terminalSent
        || state.availableBytes === state.maxCreditBytes
      ) {
        this.outgoing.delete(state.streamId);
      }
      this.#notifyOutgoingClosed(state, kind);
    }
  }

  #endOutgoing(state) {
    if (state.queue.length > 0) throw new Error("Cannot end a plugin stream with pending backpressure");
    this.#finishOutgoing(state, "end");
  }

  #cancelOutgoing(state) {
    this.#finishOutgoing(state, "cancel");
  }

  async #cancelIncoming(state, reason = new Error(`Plugin stream cancelled: ${state.streamId}`)) {
    if (state.closed) return;
    state.closed = true;
    this.incoming.delete(state.streamId);
    state.openController.abort(reason);
    state.updateSequence = Math.max(1, state.updateSequence + 1);
    let sendError;
    try {
      this.send({ frame: { streamId: state.streamId, sequence: state.updateSequence, kind: "cancel" } });
    } catch (error) {
      sendError = error;
    }
    let closeError;
    try {
      await state.onClose?.(sendError ?? reason);
    } catch (error) {
      closeError = error;
    }
    if (sendError) throw sendError;
    if (closeError) throw closeError;
  }

  close(error = new Error("Plugin runtime closed")) {
    if (this.closed) return;
    this.closed = true;
    for (const state of this.outgoing.values()) {
      state.closed = true;
      for (const pending of state.queue) pending.reject(error);
      this.#notifyOutgoingClosed(state, error);
    }
    this.outgoing.clear();
    for (const state of this.incoming.values()) {
      state.closed = true;
      state.openController?.abort(error);
      try {
        const closing = state.onClose?.(error);
        if (closing && typeof closing.then === "function") void closing.catch(() => {});
      } catch {}
    }
    this.incoming.clear();
  }
}

module.exports = { PluginStreamRouter, assertStreamEnvelopeShape, raceWithSignal };
