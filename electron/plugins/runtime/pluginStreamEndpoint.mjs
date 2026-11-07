import {
  PLUGIN_STREAM_MAX_CHUNK_BYTES,
  PLUGIN_STREAM_MAX_ID_LENGTH,
  PLUGIN_STREAM_MAX_WINDOW_BYTES,
  PLUGIN_STREAM_MIN_WINDOW_BYTES,
  createMessagePortStreamEnvelope,
  materializeStreamChunk,
} from "@netcatty/plugin-contract";
import { PluginError } from "@netcatty/plugin-sdk";

function assertStreamId(streamId) {
  if (typeof streamId !== "string"
    || streamId.length < 1
    || streamId.length > PLUGIN_STREAM_MAX_ID_LENGTH
    || streamId.includes("\0")) {
    throw new PluginError("invalid_argument", "Plugin stream ID is invalid");
  }
  return streamId;
}

function assertWindowBytes(windowBytes) {
  if (!Number.isSafeInteger(windowBytes)
    || windowBytes < PLUGIN_STREAM_MIN_WINDOW_BYTES
    || windowBytes > PLUGIN_STREAM_MAX_WINDOW_BYTES) {
    throw new PluginError("invalid_argument", "Plugin stream window is invalid");
  }
  return windowBytes;
}

function copyBytes(value) {
  let source;
  if (value instanceof Uint8Array) source = value;
  else if (value instanceof ArrayBuffer) source = new Uint8Array(value);
  else throw new PluginError("invalid_argument", "Plugin stream writes require Uint8Array or ArrayBuffer");
  const copy = new Uint8Array(source.byteLength);
  copy.set(source);
  return copy;
}

function closedError(streamId) {
  return new PluginError("unavailable", `Plugin stream is closed: ${streamId}`);
}

export function createPluginStreamEndpoint(transport, options = {}) {
  const maxStreams = options.maxStreams ?? 128;
  const incoming = new Map();
  const outgoing = new Map();
  const pendingIncoming = new Map();
  let closed = false;

  const sendEnvelope = (frame, transfer) => {
    const envelope = createMessagePortStreamEnvelope(frame, transfer);
    transport.post(envelope, transfer ? [transfer] : []);
  };

  const activeStreams = () => incoming.size + outgoing.size;
  const reservedStreams = () => activeStreams() + pendingIncoming.size;

  function releaseCurrent(state) {
    if (!state.currentCreditBytes || closed) return;
    const creditBytes = state.currentCreditBytes;
    state.currentCreditBytes = 0;
    state.availableBytes += creditBytes;
    state.updateSequence += 1;
    sendEnvelope({
      streamId: state.streamId,
      sequence: state.updateSequence,
      kind: "windowUpdate",
      creditBytes,
    });
  }

  function settleIncomingWaiters(state) {
    while (state.readers.length > 0) {
      if (state.queue.length > 0) {
        const reader = state.readers.shift();
        const chunk = state.queue.shift();
        state.currentCreditBytes = chunk.creditBytes;
        reader.resolve(chunk.data);
        continue;
      }
      if (!state.closed) break;
      const reader = state.readers.shift();
      if (state.error) reader.reject(state.error);
      else reader.resolve(null);
    }
  }

  function closeIncoming(state, error, notify = false, refundCancelledCredit = false) {
    if (state.closed) return;
    state.closed = true;
    state.error = error ?? null;
    incoming.delete(state.streamId);
    if (error) {
      // Discard unread bytes on cancellation/failure and settle their credit
      // now. A later read must surface the error without sending more credit.
      state.currentCreditBytes += state.queue.reduce((sum, chunk) => sum + chunk.creditBytes, 0);
      state.queue.length = 0;
      // A consumer-initiated cancel rejects the producer's queued writes.
      // Returning credit first could let that producer send another chunk.
      if (refundCancelledCredit) {
        try { releaseCurrent(state); } catch {}
      }
      state.currentCreditBytes = 0;
    }
    if (notify) {
      try {
        sendEnvelope({
          streamId: state.streamId,
          sequence: Math.max(1, state.updateSequence + 1),
          kind: "cancel",
        });
      } catch {}
    }
    settleIncomingWaiters(state);
  }

  function readableHandle(state) {
    return Object.freeze({
      id: state.streamId,
      async read() {
        if (state.readers.length > 0) {
          throw new PluginError("failed_precondition", "Plugin stream does not allow concurrent reads");
        }
        if (state.currentCreditBytes) releaseCurrent(state);
        if (state.queue.length > 0) {
          const chunk = state.queue.shift();
          state.currentCreditBytes = chunk.creditBytes;
          return chunk.data;
        }
        if (state.closed) {
          if (state.error) throw state.error;
          return null;
        }
        return new Promise((resolve, reject) => state.readers.push({ resolve, reject }));
      },
      cancel() { closeIncoming(state, new PluginError("cancelled", "Plugin stream was cancelled"), true); },
      dispose() { closeIncoming(state, new PluginError("cancelled", "Plugin stream was disposed"), true); },
    });
  }

  function flushOutgoing(state) {
    while (!state.closed && state.queue.length > 0) {
      const pending = state.queue[0];
      if (pending.bytes.byteLength > state.availableBytes) break;
      state.queue.shift();
      state.queuedBytes -= pending.bytes.byteLength;
      state.availableBytes -= pending.bytes.byteLength;
      state.nextSequence += 1;
      try {
        sendEnvelope({
          streamId: state.streamId,
          sequence: state.nextSequence,
          kind: "chunk",
          data: { encoding: "transfer", byteLength: pending.bytes.byteLength },
        }, pending.bytes.buffer);
        pending.resolve();
      } catch (error) {
        state.closed = true;
        outgoing.delete(state.streamId);
        pending.reject(error);
        for (const queued of state.queue.splice(0)) queued.reject(error);
        state.queuedBytes = 0;
        state.endReject?.(error);
      }
    }
    if (!state.closed && state.terminal === "end" && state.queue.length === 0 && !state.terminalSent) {
      state.terminalSent = true;
      state.nextSequence += 1;
      try {
        sendEnvelope({ streamId: state.streamId, sequence: state.nextSequence, kind: "end" });
        state.endResolve?.();
        if (state.availableBytes === state.windowBytes) {
          state.closed = true;
          outgoing.delete(state.streamId);
        }
      } catch (error) {
        state.closed = true;
        outgoing.delete(state.streamId);
        state.endReject?.(error);
      }
    }
  }

  function writableHandle(state) {
    return Object.freeze({
      id: state.streamId,
      write(value) {
        if (state.closed || state.terminal) return Promise.reject(closedError(state.streamId));
        const bytes = copyBytes(value);
        if (bytes.byteLength < 1 || bytes.byteLength > PLUGIN_STREAM_MAX_CHUNK_BYTES) {
          return Promise.reject(new PluginError("out_of_range", "Plugin stream chunk size is invalid"));
        }
        if (state.queuedBytes + bytes.byteLength > state.windowBytes) {
          return Promise.reject(new PluginError("resource_exhausted", "Plugin stream pending writes exceed its window"));
        }
        return new Promise((resolve, reject) => {
          state.queue.push({ bytes, resolve, reject });
          state.queuedBytes += bytes.byteLength;
          flushOutgoing(state);
        });
      },
      end() {
        if (state.terminal === "end") return state.endPromise;
        if (state.closed || state.terminal) return Promise.reject(closedError(state.streamId));
        state.terminal = "end";
        state.endPromise = new Promise((resolve, reject) => {
          state.endResolve = resolve;
          state.endReject = reject;
        });
        flushOutgoing(state);
        return state.endPromise;
      },
      fail(error) {
        if (state.closed || state.terminal) return;
        state.terminal = "error";
        state.closed = true;
        outgoing.delete(state.streamId);
        const failure = new PluginError("data_loss", String(error?.message ?? "Plugin stream failed"));
        for (const pending of state.queue.splice(0)) pending.reject(failure);
        state.queuedBytes = 0;
        state.nextSequence += 1;
        sendEnvelope({
          streamId: state.streamId,
          sequence: state.nextSequence,
          kind: "error",
          error: {
            code: -32013,
            message: String(error?.message ?? "Plugin stream failed").slice(0, 2048),
          },
        });
      },
      cancel() {
        if (state.closed) return;
        state.closed = true;
        state.terminal = "cancel";
        const error = new PluginError("cancelled", "Plugin stream was cancelled");
        for (const pending of state.queue.splice(0)) pending.reject(error);
        state.queuedBytes = 0;
        state.endReject?.(error);
        try {
          sendEnvelope({
            streamId: state.streamId,
            sequence: state.nextSequence + 1,
            kind: "cancel",
          });
          state.terminalSent = true;
        } finally {
          if (!state.terminalSent || state.availableBytes === state.windowBytes) outgoing.delete(state.streamId);
        }
      },
      dispose() { this.cancel(); },
    });
  }

  function accept(message) {
    if (!message || typeof message !== "object" || !Object.hasOwn(message, "frame")) return false;
    const envelope = createMessagePortStreamEnvelope(message.frame, message.transfer);
    const frame = envelope.frame;
    if (frame.kind === "open") {
      if (!pendingIncoming.has(frame.streamId)) return false;
      if (closed || activeStreams() >= maxStreams || incoming.has(frame.streamId) || outgoing.has(frame.streamId)) {
        throw new PluginError("resource_exhausted", `Plugin stream cannot be opened: ${frame.streamId}`);
      }
      const state = {
        streamId: frame.streamId,
        availableBytes: frame.windowBytes,
        nextSequence: 1,
        updateSequence: -1,
        currentCreditBytes: 0,
        queue: [],
        readers: [],
        closed: false,
        error: null,
      };
      incoming.set(frame.streamId, state);
      const waiter = pendingIncoming.get(frame.streamId);
      pendingIncoming.delete(frame.streamId);
      waiter.resolve(readableHandle(state));
      return true;
    }
    const output = outgoing.get(frame.streamId);
    if (output && frame.kind === "windowUpdate") {
      if (frame.sequence !== output.lastUpdateSequence + 1) {
        throw new PluginError("data_loss", `Plugin stream credit is out of order: ${frame.streamId}`);
      }
      output.lastUpdateSequence = frame.sequence;
      output.availableBytes += frame.creditBytes;
      if (output.availableBytes > output.windowBytes) {
        throw new PluginError("data_loss", `Plugin stream credit exceeds its window: ${frame.streamId}`);
      }
      if (output.terminalSent && output.availableBytes === output.windowBytes) {
        output.closed = true;
        outgoing.delete(frame.streamId);
      } else flushOutgoing(output);
      return true;
    }
    if (output && frame.kind === "cancel") {
      output.closed = true;
      outgoing.delete(frame.streamId);
      const error = new PluginError("cancelled", `Plugin stream peer cancelled: ${frame.streamId}`);
      for (const pending of output.queue.splice(0)) pending.reject(error);
      output.queuedBytes = 0;
      output.endReject?.(error);
      return true;
    }
    const input = incoming.get(frame.streamId);
    if (!input || input.closed) throw new PluginError("data_loss", `Unknown Plugin stream: ${frame.streamId}`);
    if (frame.sequence !== input.nextSequence) {
      throw new PluginError("data_loss", `Plugin stream frame is out of order: ${frame.streamId}`);
    }
    input.nextSequence += 1;
    if (frame.kind === "chunk") {
      const materialized = materializeStreamChunk(frame.data, envelope.transfer);
      if (materialized.encoding !== "binary" || !(materialized.bytes instanceof Uint8Array)) {
        throw new PluginError("data_loss", "Plugin byte stream received a non-binary chunk");
      }
      const data = materialized.bytes;
      if (data.byteLength > input.availableBytes) {
        throw new PluginError("resource_exhausted", `Plugin stream exceeded receive credit: ${frame.streamId}`);
      }
      input.availableBytes -= data.byteLength;
      input.queue.push({ data, creditBytes: data.byteLength });
      settleIncomingWaiters(input);
      return true;
    }
    closeIncoming(
      input,
      frame.kind === "error"
        ? new PluginError("data_loss", frame.error.message)
        : frame.kind === "cancel"
          ? new PluginError("cancelled", `Plugin stream peer cancelled: ${frame.streamId}`)
          : null,
      false,
      frame.kind === "cancel",
    );
    return true;
  }

  return Object.freeze({
    accept,
    async acceptReadable(streamId) {
      const id = assertStreamId(streamId);
      const existing = incoming.get(id);
      if (existing) return readableHandle(existing);
      if (closed || pendingIncoming.has(id) || outgoing.has(id)) {
        throw new PluginError("failed_precondition", `Plugin stream cannot be accepted: ${id}`);
      }
      if (reservedStreams() >= maxStreams) {
        throw new PluginError("resource_exhausted", "Plugin stream limit is exhausted");
      }
      return new Promise((resolve, reject) => pendingIncoming.set(id, { resolve, reject }));
    },
    rejectReadable(streamId, error = new PluginError("cancelled", "Plugin stream acceptance was cancelled")) {
      const id = assertStreamId(streamId);
      const waiter = pendingIncoming.get(id);
      if (!waiter) return false;
      pendingIncoming.delete(id);
      waiter.reject(error);
      return true;
    },
    async openWritable(streamId, windowBytes = 256 * 1024) {
      const id = assertStreamId(streamId);
      const window = assertWindowBytes(windowBytes);
      if (closed || reservedStreams() >= maxStreams || incoming.has(id) || outgoing.has(id) || pendingIncoming.has(id)) {
        throw new PluginError("resource_exhausted", `Plugin stream cannot be opened: ${id}`);
      }
      const state = {
        streamId: id,
        windowBytes: window,
        availableBytes: window,
        nextSequence: 0,
        lastUpdateSequence: -1,
        queue: [],
        queuedBytes: 0,
        terminal: null,
        terminalSent: false,
        endPromise: null,
        endResolve: null,
        endReject: null,
        closed: false,
      };
      outgoing.set(id, state);
      sendEnvelope({ streamId: id, sequence: 0, kind: "open", windowBytes: window });
      return writableHandle(state);
    },
    close(error = new PluginError("unavailable", "Plugin stream transport closed")) {
      if (closed) return;
      closed = true;
      for (const state of incoming.values()) closeIncoming(state, error);
      for (const state of outgoing.values()) {
        state.closed = true;
        for (const pending of state.queue.splice(0)) pending.reject(error);
        state.queuedBytes = 0;
        state.endReject?.(error);
      }
      outgoing.clear();
      for (const waiter of pendingIncoming.values()) waiter.reject(error);
      pendingIncoming.clear();
    },
  });
}

export { assertStreamId, assertWindowBytes };
