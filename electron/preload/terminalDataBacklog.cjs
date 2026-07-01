"use strict";

function createTerminalDataBacklog(options = {}) {
  const maxBytesPerSession = options.maxBytesPerSession ?? 64 * 1024;
  const pendingBySession = new Map();

  function trimToLimit(value) {
    if (value.length <= maxBytesPerSession) return value;
    return value.slice(value.length - maxBytesPerSession);
  }

  function append(sessionId, data, meta) {
    if (!sessionId || !data) return;
    const previous = pendingBySession.get(sessionId) || { data: "", meta: undefined };
    const droppedOutputMayAffectTerminalState = Boolean(
      previous.meta?.droppedOutputMayAffectTerminalState
      || meta?.droppedOutputMayAffectTerminalState
    );
    const droppedOutputAlternateScreenAction = meta?.droppedOutputMayAffectTerminalState
      ? meta?.droppedOutputAlternateScreenAction
      : (meta?.droppedOutputAlternateScreenAction ?? previous.meta?.droppedOutputAlternateScreenAction);
    const nextMeta = droppedOutputMayAffectTerminalState || droppedOutputAlternateScreenAction
      ? {
        ...(droppedOutputMayAffectTerminalState ? { droppedOutputMayAffectTerminalState: true } : {}),
        ...(droppedOutputAlternateScreenAction ? { droppedOutputAlternateScreenAction } : {}),
      }
      : undefined;
    pendingBySession.set(sessionId, {
      data: trimToLimit(previous.data + data),
      meta: nextMeta,
    });
  }

  function takeEntry(sessionId) {
    const entry = pendingBySession.get(sessionId) || { data: "", meta: undefined };
    pendingBySession.delete(sessionId);
    return entry;
  }

  function take(sessionId) {
    return takeEntry(sessionId).data;
  }

  function clear(sessionId) {
    pendingBySession.delete(sessionId);
  }

  function size(sessionId) {
    return pendingBySession.get(sessionId)?.data.length ?? 0;
  }

  return {
    append,
    take,
    takeEntry,
    clear,
    size,
  };
}

function hasSessionListeners(listenersBySession, sessionId) {
  return (listenersBySession.get(sessionId)?.size ?? 0) > 0;
}

function createTerminalDataDispatcher({
  dataListeners,
  displayDataListeners,
  terminalDataBacklog,
  onCallbackError = console.error,
  shouldDropSession = () => false,
}) {
  return function deliverToListeners(sessionId, data, meta) {
    if (!data) return;
    if (shouldDropSession(sessionId)) return;

    if (!hasSessionListeners(displayDataListeners, sessionId)) {
      terminalDataBacklog?.append?.(sessionId, data, meta);
    }

    const set = dataListeners.get(sessionId);
    if (!set || set.size === 0) return;

    set.forEach((cb) => {
      try {
        cb(data, meta);
      } catch (err) {
        onCallbackError("Data callback failed", err);
      }
    });
  };
}

function clearTerminalDataSession({
  dataListeners,
  displayDataListeners,
  terminalDataBacklog,
}, sessionId) {
  dataListeners?.delete?.(sessionId);
  displayDataListeners?.delete?.(sessionId);
  terminalDataBacklog?.clear?.(sessionId);
}

function clearTerminalDataBacklog({
  terminalDataBacklog,
}, sessionId) {
  terminalDataBacklog?.clear?.(sessionId);
}

module.exports = {
  clearTerminalDataBacklog,
  createTerminalDataBacklog,
  createTerminalDataDispatcher,
  clearTerminalDataSession,
};
