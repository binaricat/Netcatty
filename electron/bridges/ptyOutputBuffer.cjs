"use strict";

/**
 * Coalescing output buffer for terminal/PTY data on its way to the renderer.
 *
 * Incoming shell data is accumulated and delivered to `sendFn` in batches to
 * keep IPC traffic down, but the batch is flushed on the *next event-loop turn*
 * (`setImmediate`) rather than after a fixed time interval. A fixed interval
 * adds that whole interval as latency to interactive echo — every keystroke
 * round-trips through the buffer and waits out the timer before it can paint.
 * Turn-based flushing coalesces only the data that has already arrived in the
 * current turn, so a single echoed keystroke is forwarded almost immediately
 * while bursts of output still collapse into one send.
 *
 * Once a burst reaches the soft cap, switch to a very short timer. That gives
 * urgent control input (Ctrl+C/close) room to run instead of letting a flood
 * repeatedly send synchronously. A larger hard cap still flushes immediately so
 * buffered sends stay bounded even if a source emits while renderer flow is
 * paused.
 *
 * @param {(data: string) => void} sendFn delivers an accumulated batch
 * @param {{
 *   maxBufferSize?: number,
 *   shouldAcceptOutput?: () => boolean,
 *   floodFlushDelayMs?: number,
 *   maxFloodBufferSize?: number,
 *   maxPendingBytes?: number,
 *   onPendingBytesChange?: (bytes: number) => void,
 *   maxDroppedStateScanBytes?: number,
 * }} [options]
 * @returns {{ bufferData: (data: string, meta?: object) => void, flush: () => void, flushPaced: (onDrained?: () => void) => void, takePending: () => string, takePendingEntry: () => { data: string, meta?: object }, discard: () => number }}
 */
function createPtyOutputBuffer(sendFn, options = {}) {
  const maxBufferSize = options.maxBufferSize ?? 16384; // 16KB
  const maxFloodBufferSize = options.maxFloodBufferSize ?? Math.max(maxBufferSize * 4, maxBufferSize);
  const maxPendingBytes = Math.max(
    maxFloodBufferSize,
    options.maxPendingBytes ?? (2 * 1024 * 1024),
  );
  const floodFlushDelayMs = options.floodFlushDelayMs ?? 8;
  const maxDroppedStateScanBytes = Math.max(256, options.maxDroppedStateScanBytes ?? 2048);
  const shouldAcceptOutput = options.shouldAcceptOutput ?? (() => true);
  const onPendingBytesChange = typeof options.onPendingBytesChange === "function"
    ? options.onPendingBytesChange
    : null;

  let dataBuffer = "";
  const queuedBuffers = [];
  let pendingBytes = 0;
  let scheduled = null;
  let scheduledType = null;
  let nextSendMeta = null;
  const drainCallbacks = [];

  const ESC = "\x1b";
  const ALT_SCREEN_MODES = new Set([47, 1047, 1049]);

  const readCsiSequence = (input, startIndex) => {
    if (input[startIndex] !== ESC || input[startIndex + 1] !== "[") return null;
    for (let index = startIndex + 2; index < input.length; index += 1) {
      const code = input.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) {
        return { sequence: input.slice(startIndex, index + 1), end: index + 1 };
      }
    }
    return null;
  };

  const getAlternateScreenAction = (sequence) => {
    if (!sequence.startsWith("\x1b[") || sequence.length < 3) return null;
    const final = sequence.at(-1);
    if (final !== "h" && final !== "l") return null;
    const params = sequence.slice(2, -1);
    if (!params.startsWith("?")) return null;
    const modes = params
      .slice(1)
      .split(";")
      .map((part) => Number.parseInt(part, 10))
      .filter(Number.isFinite);
    if (!modes.some((mode) => ALT_SCREEN_MODES.has(mode))) return null;
    return final === "h" ? "enter" : "leave";
  };

  const inspectAlternateScreenWindow = (text) => {
    let mayAffectTerminalState = false;
    let finalAction = null;
    let hasIncompleteSequence = false;
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] !== ESC) continue;
      const sequence = readCsiSequence(text, index);
      if (sequence) {
        const action = getAlternateScreenAction(sequence.sequence);
        if (action) {
          mayAffectTerminalState = true;
          finalAction = action;
        }
        index = sequence.end - 1;
        continue;
      }
      if (text.slice(index).startsWith("\x1b[?")) {
        mayAffectTerminalState = true;
        hasIncompleteSequence = true;
        finalAction = null;
      }
    }
    return { mayAffectTerminalState, finalAction, hasIncompleteSequence };
  };

  const inspectAlternateScreenSequenceStartedBeforeBoundary = (text, boundary) => {
    let mayAffectTerminalState = false;
    let finalAction = null;
    for (let index = 0; index < Math.min(boundary, text.length); index += 1) {
      if (text[index] !== ESC) continue;
      const sequence = readCsiSequence(text, index);
      if (!sequence) {
        if (text.slice(index).startsWith("\x1b[?")) {
          mayAffectTerminalState = true;
        }
        continue;
      }
      if (sequence.end > boundary) {
        const action = getAlternateScreenAction(sequence.sequence);
        if (action) {
          mayAffectTerminalState = true;
          finalAction = action;
        }
      }
      index = sequence.end - 1;
    }
    return { mayAffectTerminalState, finalAction };
  };

  const inspectDroppedTerminalState = ({
    droppedHead,
    droppedTail,
    retainedHead,
    droppedBytes,
  }) => {
    if (droppedBytes <= 0) {
      return { mayAffectTerminalState: false, finalAlternateScreenAction: undefined };
    }
    const headInspection = inspectAlternateScreenWindow(droppedHead);
    const tailContext = droppedTail === droppedHead ? droppedHead : droppedTail;
    const tailInspection = inspectAlternateScreenWindow(tailContext);
    const tailWithRetainedInspection = inspectAlternateScreenWindow(`${tailContext}${retainedHead}`);
    const splitTailInspection = inspectAlternateScreenSequenceStartedBeforeBoundary(
      `${tailContext}${retainedHead}`,
      tailContext.length,
    );
    const sampledBytes = droppedHead.length + (droppedTail === droppedHead ? 0 : droppedTail.length);
    const hasUninspectedMiddle = droppedBytes > sampledBytes;
    const finalAlternateScreenAction = splitTailInspection.finalAction
      || tailInspection.finalAction
      || (!hasUninspectedMiddle ? headInspection.finalAction : undefined)
      || undefined;
    return {
      mayAffectTerminalState: Boolean(
        headInspection.hasIncompleteSequence
        || tailWithRetainedInspection.hasIncompleteSequence
        || hasUninspectedMiddle
        || headInspection.finalAction
        || tailInspection.finalAction
        || splitTailInspection.mayAffectTerminalState
        || tailWithRetainedInspection.finalAction
      ),
      finalAlternateScreenAction,
    };
  };

  const mergeNextSendMeta = (meta) => {
    if (!meta) return;
    const nextAction = meta.droppedOutputMayAffectTerminalState
      ? meta.droppedOutputAlternateScreenAction
      : (meta.droppedOutputAlternateScreenAction ?? nextSendMeta?.droppedOutputAlternateScreenAction);
    const merged = {
      ...(nextSendMeta || {}),
      ...meta,
      droppedOutputMayAffectTerminalState: Boolean(
        nextSendMeta?.droppedOutputMayAffectTerminalState
        || meta.droppedOutputMayAffectTerminalState,
      ),
      droppedOutputAlternateScreenAction: nextAction,
    };
    if (!merged.droppedOutputAlternateScreenAction) {
      delete merged.droppedOutputAlternateScreenAction;
    }
    nextSendMeta = merged;
  };

  const takeNextSendMeta = () => {
    const meta = nextSendMeta;
    nextSendMeta = null;
    return meta || undefined;
  };

  const sendBufferedChunk = (chunk) => {
    sendFn(chunk, takeNextSendMeta());
  };

  const reportPendingBytes = () => {
    try {
      onPendingBytesChange?.(pendingBytes);
    } catch {}
  };

  const cancelScheduled = () => {
    if (scheduled) {
      if (scheduledType === "immediate") {
        clearImmediate(scheduled);
      } else {
        clearTimeout(scheduled);
      }
      scheduled = null;
      scheduledType = null;
    }
  };

  const notifyDrained = () => {
    if (hasPendingData()) return;
    const callbacks = drainCallbacks.splice(0, drainCallbacks.length);
    for (const callback of callbacks) {
      try {
        callback();
      } catch {}
    }
  };

  const readPendingHead = (limit) => {
    if (limit <= 0) return "";
    let head = "";
    for (const chunk of queuedBuffers) {
      if (head.length >= limit) break;
      head += chunk.slice(0, limit - head.length);
    }
    if (head.length < limit && dataBuffer.length > 0) {
      head += dataBuffer.slice(0, limit - head.length);
    }
    return head;
  };

  const dropOldestPendingBytes = (bytesToDrop) => {
    let remaining = Math.max(0, bytesToDrop);
    let dropped = 0;
    let droppedHead = "";
    let droppedTail = "";
    const recordDropped = (text) => {
      if (!text) return;
      if (droppedHead.length < maxDroppedStateScanBytes) {
        droppedHead += text.slice(0, maxDroppedStateScanBytes - droppedHead.length);
      }
      droppedTail = `${droppedTail}${text}`.slice(-maxDroppedStateScanBytes);
    };
    while (remaining > 0 && queuedBuffers.length > 0) {
      const chunk = queuedBuffers[0];
      if (chunk.length <= remaining) {
        queuedBuffers.shift();
        remaining -= chunk.length;
        dropped += chunk.length;
        recordDropped(chunk);
        continue;
      }
      const droppedChunk = chunk.slice(0, remaining);
      queuedBuffers[0] = chunk.slice(remaining);
      dropped += remaining;
      recordDropped(droppedChunk);
      remaining = 0;
    }
    if (remaining > 0 && dataBuffer.length > 0) {
      if (dataBuffer.length <= remaining) {
        dropped += dataBuffer.length;
        remaining -= dataBuffer.length;
        recordDropped(dataBuffer);
        dataBuffer = "";
      } else {
        const droppedChunk = dataBuffer.slice(0, remaining);
        dataBuffer = dataBuffer.slice(remaining);
        dropped += remaining;
        recordDropped(droppedChunk);
        remaining = 0;
      }
    }
    if (dropped > 0) {
      pendingBytes = Math.max(0, pendingBytes - dropped);
    }
    const terminalState = inspectDroppedTerminalState({
      droppedHead,
      droppedTail,
      retainedHead: readPendingHead(maxDroppedStateScanBytes),
      droppedBytes: dropped,
    });
    return {
      dropped,
      droppedOutputMayAffectTerminalState: terminalState.mayAffectTerminalState,
      droppedOutputAlternateScreenAction: terminalState.finalAlternateScreenAction,
    };
  };

  const enforcePendingByteLimit = () => {
    if (pendingBytes <= maxPendingBytes) return;
    const dropped = dropOldestPendingBytes(pendingBytes - maxPendingBytes);
    if (dropped.dropped > 0) {
      if (dropped.droppedOutputMayAffectTerminalState) {
        mergeNextSendMeta({
          droppedOutputMayAffectTerminalState: true,
          droppedOutputAlternateScreenAction: dropped.droppedOutputAlternateScreenAction,
        });
      }
      reportPendingBytes();
    }
  };

  const clearPendingBuffers = () => {
    const discardedBytes = pendingBytes;
    queuedBuffers.length = 0;
    dataBuffer = "";
    pendingBytes = 0;
    reportPendingBytes();
    return discardedBytes;
  };

  const flushNow = () => {
    scheduled = null;
    scheduledType = null;
    if (!shouldAcceptOutput()) {
      return;
    }
    while (queuedBuffers.length > 0) {
      const chunk = queuedBuffers.shift();
      sendBufferedChunk(chunk);
      pendingBytes = Math.max(0, pendingBytes - chunk.length);
      reportPendingBytes();
    }
    if (dataBuffer.length > 0) {
      while (dataBuffer.length > maxFloodBufferSize) {
        const chunk = dataBuffer.slice(0, maxFloodBufferSize);
        dataBuffer = dataBuffer.slice(maxFloodBufferSize);
        sendBufferedChunk(chunk);
        pendingBytes = Math.max(0, pendingBytes - chunk.length);
        reportPendingBytes();
      }
      if (dataBuffer.length > 0) {
        const pending = dataBuffer;
        dataBuffer = "";
        sendBufferedChunk(pending);
        pendingBytes = Math.max(0, pendingBytes - pending.length);
        reportPendingBytes();
      }
    }
  };

  const appendBoundedData = (data) => {
    pendingBytes += data.length;
    let remaining = data;
    while (remaining.length > 0) {
      const available = maxFloodBufferSize - dataBuffer.length;
      if (available <= 0) {
        queuedBuffers.push(dataBuffer);
        dataBuffer = "";
        continue;
      }
      dataBuffer += remaining.slice(0, available);
      remaining = remaining.slice(available);
      if (dataBuffer.length >= maxFloodBufferSize && remaining.length > 0) {
        queuedBuffers.push(dataBuffer);
        dataBuffer = "";
      }
    }
    reportPendingBytes();
    enforcePendingByteLimit();
  };

  const scheduleTurnFlush = () => {
    if (scheduled) return;
    scheduledType = "immediate";
    scheduled = setImmediate(flushNow);
  };

  const scheduleFloodFlush = () => {
    if (scheduledType === "flood") return;
    cancelScheduled();
    scheduledType = "flood";
    scheduled = setTimeout(sendNextPendingChunk, floodFlushDelayMs);
  };

  const bufferData = (data, meta) => {
    mergeNextSendMeta(meta);
    appendBoundedData(data);
    if (!shouldAcceptOutput()) {
      return;
    }
    if (scheduledType === "paced" && hasPendingData()) {
      return;
    }
    if (queuedBuffers.length > 0 || dataBuffer.length >= maxFloodBufferSize) {
      cancelScheduled();
      sendNextPendingChunk();
    } else if (dataBuffer.length >= maxBufferSize) {
      scheduleFloodFlush();
    } else if (!scheduled) {
      scheduleTurnFlush();
    }
  };

  const flush = () => {
    cancelScheduled();
    flushNow();
  };

  const hasPendingData = () => queuedBuffers.length > 0 || dataBuffer.length > 0;

  const sendNextPendingChunk = () => {
    if (!shouldAcceptOutput()) {
      scheduled = null;
      scheduledType = null;
      if (drainCallbacks.length > 0) {
        clearPendingBuffers();
        notifyDrained();
      }
      return;
    }
    if (queuedBuffers.length > 0) {
      const chunk = queuedBuffers.shift();
      sendBufferedChunk(chunk);
      pendingBytes = Math.max(0, pendingBytes - chunk.length);
      reportPendingBytes();
    } else if (dataBuffer.length > maxFloodBufferSize) {
      const chunk = dataBuffer.slice(0, maxFloodBufferSize);
      dataBuffer = dataBuffer.slice(maxFloodBufferSize);
      sendBufferedChunk(chunk);
      pendingBytes = Math.max(0, pendingBytes - chunk.length);
      reportPendingBytes();
    } else if (dataBuffer.length > 0) {
      const pending = dataBuffer;
      dataBuffer = "";
      sendBufferedChunk(pending);
      pendingBytes = Math.max(0, pendingBytes - pending.length);
      reportPendingBytes();
    }

    if (!hasPendingData()) {
      scheduled = null;
      scheduledType = null;
      notifyDrained();
      return;
    }
    scheduledType = "paced";
    scheduled = setTimeout(sendNextPendingChunk, floodFlushDelayMs);
  };

  const flushPaced = (onDrained) => {
    if (typeof onDrained === "function") drainCallbacks.push(onDrained);
    cancelScheduled();
    if (typeof onDrained === "function" && !shouldAcceptOutput()) {
      clearPendingBuffers();
      notifyDrained();
      return;
    }
    sendNextPendingChunk();
    notifyDrained();
  };

  const takePendingEntry = () => {
    cancelScheduled();
    const pending = `${queuedBuffers.join("")}${dataBuffer}`;
    const meta = takeNextSendMeta();
    queuedBuffers.length = 0;
    dataBuffer = "";
    pendingBytes = 0;
    reportPendingBytes();
    notifyDrained();
    return { data: pending, meta };
  };

  const takePending = () => {
    return takePendingEntry().data;
  };

  const discard = () => {
    cancelScheduled();
    const discardedBytes = clearPendingBuffers();
    nextSendMeta = null;
    drainCallbacks.splice(0, drainCallbacks.length);
    return discardedBytes;
  };

  return { bufferData, flush, flushPaced, takePending, takePendingEntry, discard };
}

module.exports = { createPtyOutputBuffer };
