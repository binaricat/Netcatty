const { ipcRenderer, contextBridge, webUtils } = require("electron");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { SessionTombstones } = require("./preload/sessionTombstones.cjs");
const { createPreloadApi } = require("./preload/api.cjs");
const {
  clearTerminalDataBacklog,
  clearTerminalDataSession,
  createTerminalDataBacklog,
  createTerminalDataDispatcher,
  hasPluginPipelineIngress,
  hasPluginPipelineIngressMarker,
} = require("./preload/terminalDataBacklog.cjs");
const {
  createTerminalOutputPortRegistry,
} = require("./preload/terminalOutputPorts.cjs");
const {
  createTerminalUrgentInputPortRegistry,
} = require("./preload/terminalUrgentInputPorts.cjs");
const {
  mergeTerminalDataMeta,
} = require("./preload/terminalDataMeta.cjs");

const dataListeners = new Map();
const displayDataListeners = new Map();
const terminalDataBacklog = createTerminalDataBacklog();
const closedTerminalDataSessions = new SessionTombstones();
const exitListeners = new Map();
const globalSftpTransferListeners = new Set();
const pluginContributionsChangedListeners = new Set();
const chainProgressListeners = new Map();
const connectionReuseFallbackListeners = new Set();
const zmodemListeners = new Map();
const zmodemOverwriteListeners = new Map(); // sessionId -> Set<cb>
const sftpConnectionProgressListeners = new Set();
const authFailedListeners = new Map();
const telnetAutoLoginCompleteListeners = new Map();
const telnetAutoLoginCancelledListeners = new Map();
const telnetEchoModeListeners = new Map();
const moshSessionReadyListeners = new Map();
const languageChangeListeners = new Set();
const fullscreenChangeListeners = new Set();
const windowShownListeners = new Set();
const windowFocusRequestedListeners = new Set();
const windowWillHideListeners = new Set();
const keyboardInteractiveListeners = new Set();
const keyboardInteractiveCancelledListeners = new Set();
const hostKeyVerificationListeners = new Set();
const passphraseListeners = new Set();
const passphraseTimeoutListeners = new Set();
const passphraseCancelledListeners = new Set();
const passphraseAuthFailedListeners = new Set();
const updateDownloadProgressListeners = new Set();
const updateDownloadedListeners = new Set();
const updateAvailableListeners = new Set();
const updateNotAvailableListeners = new Set();
const updateErrorListeners = new Set();
const updateNeedsSaveListeners = new Set();
const terminalPopupConfigState = {
  pending: null,
  // Keep the last delivered payload so StrictMode remount (unsubscribe →
  // resubscribe) can replay config after the one-shot pending slot was drained.
  lastPayload: null,
  listeners: new Set(),
};

function dispatchGlobalSftpTransferEvent(payload) {
  for (const cb of globalSftpTransferListeners) {
    try {
      cb(payload);
    } catch (err) {
      console.error("Global SFTP transfer callback failed", err);
    }
  }
}

function dispatchPluginContributionsChanged(payload) {
  for (const cb of pluginContributionsChangedListeners) {
    try {
      cb(payload);
    } catch (err) {
      console.error("Plugin contributions callback failed", err);
    }
  }
}

// ── MCP marker filter with per-session line buffering ──
// PTY data arrives in arbitrary chunks; the marker string (__NCMCP_) can be
// split across chunk boundaries so a simple data.includes() guard misses it.
// We buffer the trailing fragment of each chunk and prepend it to the next
// chunk, then filter complete lines that contain the marker.

const _mcpLineBufs = new Map(); // sessionId -> trailing fragment string
const _mcpLineMetas = new Map(); // sessionId -> trailing fragment metadata
const _mcpPendingMetas = new Map(); // sessionId -> metadata from filtered-empty chunks
const _mcpFlushTimers = new Map(); // sessionId -> delayed-flush timer
const _mcpDroppingWrappedLine = new Set(); // sessionIds with a split marker echo line in progress
const MAX_MCP_BUFFERED_LINE_CHARS = 64 * 1024;

function clearMcpSessionState(sessionId) {
  if (!sessionId) return;
  const pendingTimer = _mcpFlushTimers.get(sessionId);
  if (pendingTimer) clearTimeout(pendingTimer);
  _mcpFlushTimers.delete(sessionId);
  _mcpLineBufs.delete(sessionId);
  _mcpLineMetas.delete(sessionId);
  _mcpPendingMetas.delete(sessionId);
  _mcpDroppingWrappedLine.delete(sessionId);
}

// Returns true if `s` ends with a non-empty prefix of "__NCMCP_"
// (i.e. the next chunk might complete it into a marker-containing line).
function _endsWithMarkerPrefix(s) {
  const p = "__NCMCP_";
  for (let i = 1; i < p.length; i++) {
    if (s.endsWith(p.slice(0, i))) return true;
  }
  return false;
}

function filterMcpChunk(sessionId, chunk, meta) {
  // Cancel any pending delayed flush — new data arrived
  const pendingTimer = _mcpFlushTimers.get(sessionId);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    _mcpFlushTimers.delete(sessionId);
  }

  // Prepend any buffered fragment from the previous chunk
  const held = _mcpLineBufs.get(sessionId) || "";
  const heldMeta = _mcpLineMetas.get(sessionId);
  const heldIngressAlreadyAcknowledged = heldMeta?.pluginPipelineIngressBytes === 0;
  const pendingMeta = _mcpPendingMetas.get(sessionId);
  const stateMeta = mergeTerminalDataMeta(mergeTerminalDataMeta(pendingMeta, heldMeta), meta);
  const sameChunkMeta = mergeTerminalDataMeta(mergeTerminalDataMeta(pendingMeta, heldMeta), meta, {
    preserveTerminalPerf: true,
  });
  const data = held + chunk;
  _mcpLineBufs.delete(sessionId);
  _mcpLineMetas.delete(sessionId);
  _mcpPendingMetas.delete(sessionId);

  // Fast path: nothing suspicious in the combined data
  if (!_mcpDroppingWrappedLine.has(sessionId) && !data.includes("__NCMCP_") && !_endsWithMarkerPrefix(data)) {
    const deliveryMeta = held ? stateMeta : sameChunkMeta;
    return {
      data,
      meta: heldIngressAlreadyAcknowledged
        ? {
            ...(deliveryMeta || {}),
            pluginPipelineIngressBytes: Number.isFinite(meta?.pluginPipelineIngressBytes)
              ? Math.max(0, Number(meta.pluginPipelineIngressBytes))
              : chunk.length,
          }
        : deliveryMeta,
    };
  }

  // Slow path: scan line by line
  let result = "";
  let droppedAny = _mcpDroppingWrappedLine.has(sessionId);
  let pos = 0;
  while (pos < data.length) {
    const nlIdx = data.indexOf("\n", pos);
    if (nlIdx === -1) {
      // Incomplete trailing line — no newline yet.
      // If we dropped any marker line in this chunk, or the tail itself
      // looks like it could contain a marker, buffer it.  Long command
      // echoes can wrap across PTY lines; wrapped fragments that don't
      // contain __NCMCP_ would otherwise leak through as garbage.
      const tail = data.slice(pos);
      if (droppedAny || tail.includes("__NCMCP_") || _endsWithMarkerPrefix(tail)) {
        let tailMeta = !held && tail === chunk ? sameChunkMeta : stateMeta;
        if (heldIngressAlreadyAcknowledged && !hasPluginPipelineIngress(tailMeta)) {
          tailMeta = { ...(tailMeta || {}), pluginPipelineIngressBytes: 0 };
        }
        if (tail.length <= MAX_MCP_BUFFERED_LINE_CHARS) {
          _mcpLineBufs.set(sessionId, tail);
          if (tailMeta) _mcpLineMetas.set(sessionId, tailMeta);
        } else {
          // A malformed/wrapped marker line can otherwise grow forever while
          // high-rate output keeps postponing the delayed flush. Its visible
          // content is already being suppressed, so discard the oversized
          // prefix and retain only the drop-until-newline state.
          _mcpLineBufs.delete(sessionId);
          _mcpLineMetas.delete(sessionId);
          _mcpDroppingWrappedLine.add(sessionId);
        }
        if (droppedAny) _mcpDroppingWrappedLine.add(sessionId);
      } else {
        result += tail; // safe to display immediately
      }
      break;
    }
    const line = data.slice(pos, nlIdx + 1); // includes the \n
    if (droppedAny || line.includes("__NCMCP_")) {
      droppedAny = false;
      _mcpDroppingWrappedLine.delete(sessionId);
    } else {
      result += line;
    }
    pos = nlIdx + 1;
  }

  const deliveryMeta = !held && result === chunk ? sameChunkMeta : stateMeta;
  return {
    data: result,
    meta: heldIngressAlreadyAcknowledged
      ? {
          ...(deliveryMeta || {}),
          pluginPipelineIngressBytes: Number.isFinite(meta?.pluginPipelineIngressBytes)
            ? Math.max(0, Number(meta.pluginPipelineIngressBytes))
            : chunk.length,
        }
      : deliveryMeta,
  };
}

function consumeBufferedMcpIngress(sessionId) {
  const heldMeta = _mcpLineMetas.get(sessionId);
  if (!hasPluginPipelineIngress(heldMeta)) return;
  // Retain an explicit zero so a later safe flush does not fall back to the
  // visible chunk length and acknowledge the already-credited prefix twice.
  _mcpLineMetas.set(sessionId, { ...heldMeta, pluginPipelineIngressBytes: 0 });
}

/**
 * Deliver data to session listeners.  Used both by the normal data path
 * and by the delayed-flush timer.
 */
const _deliverToListeners = createTerminalDataDispatcher({
  dataListeners,
  displayDataListeners,
  terminalDataBacklog,
  shouldDropSession: (sessionId) => closedTerminalDataSessions.has(sessionId),
});

function flushMcpBufferedOutput(sessionId) {
    const timer = _mcpFlushTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    const held = _mcpLineBufs.get(sessionId);
    const heldMeta = _mcpLineMetas.get(sessionId);
    _mcpLineBufs.delete(sessionId);
    _mcpLineMetas.delete(sessionId);
    _mcpFlushTimers.delete(sessionId);
    if (_mcpDroppingWrappedLine.has(sessionId)) {
      _mcpDroppingWrappedLine.delete(sessionId);
      if (heldMeta) _mcpPendingMetas.set(sessionId, mergeTerminalDataMeta(_mcpPendingMetas.get(sessionId), heldMeta));
      return;
    }
    if (held) {
      let deliveryMeta = mergeTerminalDataMeta(_mcpPendingMetas.get(sessionId), heldMeta, {
        preserveTerminalPerf: true,
      });
      if (heldMeta?.pluginPipelineIngressBytes === 0 && !hasPluginPipelineIngress(deliveryMeta)) {
        deliveryMeta = { ...(deliveryMeta || {}), pluginPipelineIngressBytes: 0 };
      }
      _deliverToListeners(sessionId, held, deliveryMeta);
      _mcpPendingMetas.delete(sessionId);
    }
}

function scheduleMcpBufferedFlush(sessionId) {
  if (!_mcpLineBufs.has(sessionId)) return;
  _mcpFlushTimers.set(sessionId, setTimeout(() => flushMcpBufferedOutput(sessionId), 80));
}

function deliverTerminalData(sessionId, data, options = {}) {
  if (!sessionId || (!data && !hasPluginPipelineIngressMarker(options.meta))) return;
  if (closedTerminalDataSessions.has(sessionId)) return;
  if (!data) {
    _deliverToListeners(sessionId, "", options.meta);
    return;
  }
  if (options.syntheticEcho) {
    _deliverToListeners(sessionId, data, options.meta);
    return;
  }
  const filtered = filterMcpChunk(sessionId, data, options.meta);
  if (filtered?.data) {
    _deliverToListeners(sessionId, filtered.data, filtered.meta);
    if (hasPluginPipelineIngress(filtered.meta)) consumeBufferedMcpIngress(sessionId);
  } else if (filtered?.meta) {
    if (hasPluginPipelineIngress(filtered.meta)) {
      // The legacy path must return flow credit even when MCP marker filtering
      // removes every display byte. Waiting for unrelated visible output can
      // otherwise leave a fully suppressed stream paused indefinitely.
      _deliverToListeners(sessionId, "", filtered.meta);
      consumeBufferedMcpIngress(sessionId);
    } else {
      _mcpPendingMetas.set(sessionId, mergeTerminalDataMeta(_mcpPendingMetas.get(sessionId), filtered.meta));
    }
  }
  // If there is buffered content waiting for more data (e.g. a prompt
  // right after a dropped marker line), schedule a delayed flush so it
  // appears after a short pause instead of staying hidden forever.
  scheduleMcpBufferedFlush(sessionId);
}

const terminalOutputDrainListeners = new Map();
const terminalOutputPorts = createTerminalOutputPortRegistry({
  ipcRenderer,
  deliverToListeners: _deliverToListeners,
  filterData(sessionId, data, message) {
    if (message?.syntheticEcho) return data;
    const filtered = filterMcpChunk(sessionId, data, message.meta);
    // Metadata-only plugin output is delivered immediately by the output-port
    // registry so renderer flow credit can be returned. Do not retain the same
    // ingress metadata for the next visible chunk or it would be acknowledged
    // twice. Non-ingress terminal-state metadata still follows the next output.
    if (hasPluginPipelineIngress(filtered?.meta)) {
      consumeBufferedMcpIngress(sessionId);
    } else if (!filtered?.data && filtered?.meta) {
      _mcpPendingMetas.set(sessionId, mergeTerminalDataMeta(_mcpPendingMetas.get(sessionId), filtered.meta));
    }
    scheduleMcpBufferedFlush(sessionId);
    return filtered;
  },
  closedTerminalDataSessions,
  onDrain(sessionId, requestId) {
    flushMcpBufferedOutput(sessionId);
    for (const listener of terminalOutputDrainListeners.get(sessionId) || []) {
      try { listener({ sessionId, requestId }); } catch (err) { console.error("Terminal drain callback failed", err); }
    }
  },
});
terminalOutputPorts.register();

const terminalUrgentInputPorts = createTerminalUrgentInputPortRegistry({
  ipcRenderer,
});
terminalUrgentInputPorts.register();

// ZMODEM file transfer events. Listener sets are owned by renderer subscribers
// (disposed on unmount); delivery is gated by closedTerminalDataSessions so
// events stop after exit/close and resume automatically when a session
// restarts with the same id.
ipcRenderer.on("netcatty:zmodem:detect", (_event, payload) => {
  if (closedTerminalDataSessions.has(payload.sessionId)) return;
  const set = zmodemListeners.get(payload.sessionId);
  if (!set) return;
  set.forEach((cb) => { try { cb({ type: "detect", ...payload }); } catch {} });
});

ipcRenderer.on("netcatty:window:terminalPopupConfig", (_event, payload) => {
  terminalPopupConfigState.lastPayload = payload;
  if (terminalPopupConfigState.listeners.size === 0) {
    terminalPopupConfigState.pending = payload;
    return;
  }
  terminalPopupConfigState.pending = null;
  terminalPopupConfigState.listeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("Terminal popup config callback failed", err);
    }
  });
});
ipcRenderer.on("netcatty:zmodem:progress", (_event, payload) => {
  if (closedTerminalDataSessions.has(payload.sessionId)) return;
  const set = zmodemListeners.get(payload.sessionId);
  if (!set) return;
  set.forEach((cb) => { try { cb({ type: "progress", ...payload }); } catch {} });
});
ipcRenderer.on("netcatty:zmodem:complete", (_event, payload) => {
  if (closedTerminalDataSessions.has(payload.sessionId)) return;
  const set = zmodemListeners.get(payload.sessionId);
  if (!set) return;
  set.forEach((cb) => { try { cb({ type: "complete", ...payload }); } catch {} });
});
ipcRenderer.on("netcatty:zmodem:error", (_event, payload) => {
  if (closedTerminalDataSessions.has(payload.sessionId)) return;
  const set = zmodemListeners.get(payload.sessionId);
  if (!set) return;
  set.forEach((cb) => { try { cb({ type: "error", ...payload }); } catch {} });
});
ipcRenderer.on("netcatty:zmodem:overwrite-request", (_event, payload) => {
  if (closedTerminalDataSessions.has(payload.sessionId)) return;
  const set = zmodemOverwriteListeners.get(payload.sessionId);
  if (set) set.forEach((cb) => cb(payload));
});

ipcRenderer.on("netcatty:data", (_event, payload) => {
  deliverTerminalData(payload?.sessionId, payload?.data, {
    syntheticEcho: payload?.syntheticEcho,
    meta: payload?.meta,
  });
});

// ZMODEM listener sets deliberately survive exit: they are owned by renderer
// subscribers and disposed on unmount. Delivery is gated by
// closedTerminalDataSessions (see zmodem handlers above), so events stop after
// exit/close and resume when a session restarts with the same id.
ipcRenderer.on("netcatty:exit", (_event, payload) => {
  const sessionId = payload?.sessionId;
  if (!sessionId) return;
  const wasClosed = closedTerminalDataSessions.has(sessionId);
  closedTerminalDataSessions.add(sessionId);
  const set = wasClosed ? null : exitListeners.get(sessionId);
  if (set) {
    set.forEach((cb) => {
      try {
        cb(payload);
      } catch (err) {
        console.error("Exit callback failed", err);
      }
    });
  }
  clearTerminalDataBacklog({ terminalDataBacklog }, sessionId);
  terminalOutputPorts.closeSession(sessionId);
  telnetAutoLoginCompleteListeners.delete(sessionId);
  telnetAutoLoginCancelledListeners.delete(sessionId);
  telnetEchoModeListeners.delete(sessionId);
  moshSessionReadyListeners.delete(sessionId);
  authFailedListeners.delete(sessionId);
  clearMcpSessionState(sessionId);
});

// Chain progress events (for jump host connections)
ipcRenderer.on("netcatty:chain:progress", (_event, payload) => {
  const { sessionId, hop, total, label, status, error } = payload;
  // Notify all registered chain progress listeners
  chainProgressListeners.forEach((cb) => {
    try {
      cb(sessionId, hop, total, label, status, error);
    } catch (err) {
      console.error("Chain progress callback failed", err);
    }
  });
});

ipcRenderer.on("netcatty:connection-reuse:fallback", (_event, payload) => {
  connectionReuseFallbackListeners.forEach((cb) => {
    try {
      cb(payload.sessionId, payload.sourceSessionId);
    } catch (err) {
      console.error("Connection reuse fallback callback failed", err);
    }
  });
});

// SFTP connection progress events (auth method logs)
ipcRenderer.on("netcatty:sftp:connection-progress", (_event, payload) => {
  sftpConnectionProgressListeners.forEach((cb) => {
    try {
      cb(payload.sessionId, payload.label, payload.status, payload.detail);
    } catch (err) {
      console.error("SFTP connection progress callback failed", err);
    }
  });
});

ipcRenderer.on("netcatty:languageChanged", (_event, language) => {
  languageChangeListeners.forEach((cb) => {
    try {
      cb(language);
    } catch (err) {
      console.error("Language changed callback failed", err);
    }
  });
});

ipcRenderer.on("netcatty:window:fullscreen-changed", (_event, isFullscreen) => {
  fullscreenChangeListeners.forEach((cb) => {
    try {
      cb(isFullscreen);
    } catch (err) {
      console.error("Fullscreen changed callback failed", err);
    }
  });
});

ipcRenderer.on("netcatty:window:shown", () => {
  windowShownListeners.forEach((cb) => {
    try {
      cb();
    } catch (err) {
      console.error("Window shown callback failed", err);
    }
  });
});

ipcRenderer.on("netcatty:window:focus-requested", () => {
  windowFocusRequestedListeners.forEach((cb) => {
    try {
      cb();
    } catch (err) {
      console.error("Window focus-requested callback failed", err);
    }
  });
});

ipcRenderer.on("netcatty:window:will-hide", () => {
  windowWillHideListeners.forEach((cb) => {
    try {
      cb();
    } catch (err) {
      console.error("Window will-hide callback failed", err);
    }
  });
});



// Authentication failed events
ipcRenderer.on("netcatty:auth:failed", (_event, payload) => {
  const set = authFailedListeners.get(payload.sessionId);
  if (set) {
    set.forEach((cb) => {
      try {
        cb(payload);
      } catch (err) {
        console.error("Auth failed callback failed", err);
      }
    });
  }
});

ipcRenderer.on("netcatty:telnet:auto-login-complete", (_event, payload) => {
  const set = telnetAutoLoginCompleteListeners.get(payload.sessionId);
  if (!set) return;
  set.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("Telnet auto-login callback failed", err);
    }
  });
});

ipcRenderer.on("netcatty:telnet:auto-login-cancelled", (_event, payload) => {
  const set = telnetAutoLoginCancelledListeners.get(payload.sessionId);
  if (!set) return;
  set.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("Telnet auto-login cancellation callback failed", err);
    }
  });
});

ipcRenderer.on("netcatty:mosh:ready", (_event, payload) => {
  const set = moshSessionReadyListeners.get(payload.sessionId);
  if (!set) return;
  set.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("Mosh session ready callback failed", err);
    }
  });
});

ipcRenderer.on("netcatty:telnet:echo-mode", (_event, payload) => {
  const set = telnetEchoModeListeners.get(payload.sessionId);
  if (!set) return;
  set.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("Telnet echo mode callback failed", err);
    }
  });
});

// Keyboard-interactive authentication events (2FA/MFA)
ipcRenderer.on("netcatty:keyboard-interactive", (_event, payload) => {
  keyboardInteractiveListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("Keyboard-interactive callback failed", err);
    }
  });
});

ipcRenderer.on("netcatty:keyboard-interactive-cancelled", (_event, payload) => {
  keyboardInteractiveCancelledListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("Keyboard-interactive cancellation callback failed", err);
    }
  });
});

ipcRenderer.on("netcatty:host-key:verify", (_event, payload) => {
  hostKeyVerificationListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("Host key verification callback failed", err);
    }
  });
});

// Passphrase request events for encrypted SSH keys
ipcRenderer.on("netcatty:passphrase-request", (_event, payload) => {
  passphraseListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("Passphrase request callback failed", err);
    }
  });
});

// Passphrase timeout events (request expired)
ipcRenderer.on("netcatty:passphrase-timeout", (_event, payload) => {
  passphraseTimeoutListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("Passphrase timeout callback failed", err);
    }
  });
});

// Passphrase cancelled events (request ended because the owning operation stopped)
ipcRenderer.on("netcatty:passphrase-cancelled", (_event, payload) => {
  passphraseCancelledListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("Passphrase cancelled callback failed", err);
    }
  });
});

// Passphrase auth failed events (saved passphrase was wrong)
ipcRenderer.on("netcatty:passphrase-auth-failed", (_event, payload) => {
  passphraseAuthFailedListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("Passphrase auth-failed callback failed", err);
    }
  });
});

// Auto-update events
ipcRenderer.on("netcatty:update:update-available", (_event, payload) => {
  updateAvailableListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("onUpdateAvailable callback failed", err);
    }
  });
});

ipcRenderer.on("netcatty:update:update-not-available", () => {
  updateNotAvailableListeners.forEach((cb) => {
    try {
      cb();
    } catch (err) {
      console.error("onUpdateNotAvailable callback failed", err);
    }
  });
});

ipcRenderer.on("netcatty:update:download-progress", (_event, payload) => {
  updateDownloadProgressListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("Update download-progress callback failed", err);
    }
  });
});

ipcRenderer.on("netcatty:update:downloaded", () => {
  updateDownloadedListeners.forEach((cb) => {
    try {
      cb();
    } catch (err) {
      console.error("Update downloaded callback failed", err);
    }
  });
});

ipcRenderer.on("netcatty:update:error", (_event, payload) => {
  updateErrorListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("Update error callback failed", err);
    }
  });
});

// Update can't install yet because there are unsaved editors (#1215).
ipcRenderer.on("netcatty:update:needs-save", () => {
  updateNeedsSaveListeners.forEach((cb) => {
    try {
      cb();
    } catch (err) {
      console.error("Update needs-save callback failed", err);
    }
  });
});

ipcRenderer.on("netcatty:sftp:global-transfer", (_event, payload) => {
  dispatchGlobalSftpTransferEvent(payload);
});

ipcRenderer.on("netcatty:plugins:contributions-changed", (_event, payload) => {
  dispatchPluginContributionsChanged(payload);
});

// Port forwarding status listeners
const portForwardStatusListeners = new Map();
const portForwardRuntimeListeners = new Set();

ipcRenderer.on("netcatty:portforward:status", (_event, payload) => {
  const { tunnelId, status, error } = payload;
  const callbacks = portForwardStatusListeners.get(tunnelId);
  if (callbacks) {
    callbacks.forEach((cb) => {
      try {
        cb(status, error);
      } catch (err) {
        console.error("Port forward status callback failed", err);
      }
    });
  }
});

ipcRenderer.on("netcatty:portforward:runtime", (_event, payload) => {
  portForwardRuntimeListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("Port forward runtime callback failed", err);
    }
  });
});

// File watcher listeners (for auto-sync feature)
const fileWatchSyncedListeners = new Set();
const fileWatchErrorListeners = new Set();
const fileWatchStoppedListeners = new Set();

ipcRenderer.on("netcatty:filewatch:synced", (_event, payload) => {
  fileWatchSyncedListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("File watch synced callback failed", err);
    }
  });
});

ipcRenderer.on("netcatty:filewatch:error", (_event, payload) => {
  fileWatchErrorListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("File watch error callback failed", err);
    }
  });
});

ipcRenderer.on("netcatty:filewatch:stopped", (_event, payload) => {
  fileWatchStoppedListeners.forEach((cb) => {
    try {
      cb(payload);
    } catch (err) {
      console.error("File watch stopped callback failed", err);
    }
  });
});

// Buffer the latest tray menu data so it can be replayed when the React
// component subscribes after lazy-mount (avoiding the first-open race).
let _lastTrayMenuData = null;
ipcRenderer.on("netcatty:trayPanel:setMenuData", (_event, data) => {
  _lastTrayMenuData = data;
});

const api = createPreloadApi({
  ipcRenderer,
  os,
  webUtils,
  randomUUID,
  dataListeners,
  displayDataListeners,
  exitListeners,
  closedTerminalDataSessions,
  globalSftpTransferListeners,
  pluginContributionsChangedListeners,
  chainProgressListeners,
  connectionReuseFallbackListeners,
  zmodemListeners,
  zmodemOverwriteListeners,
  sftpConnectionProgressListeners,
  authFailedListeners,
  telnetAutoLoginCompleteListeners,
  telnetAutoLoginCancelledListeners,
  telnetEchoModeListeners,
  moshSessionReadyListeners,
  terminalDataBacklog,
  terminalOutputPorts,
  clearTerminalOutputSessionState: clearMcpSessionState,
  terminalOutputDrainListeners,
  terminalUrgentInputPorts,
  languageChangeListeners,
  fullscreenChangeListeners,
  windowShownListeners,
  windowFocusRequestedListeners,
  windowWillHideListeners,
  keyboardInteractiveListeners,
  keyboardInteractiveCancelledListeners,
  hostKeyVerificationListeners,
  passphraseListeners,
  passphraseTimeoutListeners,
  passphraseCancelledListeners,
  passphraseAuthFailedListeners,
  updateDownloadProgressListeners,
  updateDownloadedListeners,
  updateAvailableListeners,
  updateNotAvailableListeners,
  updateErrorListeners,
  updateNeedsSaveListeners,
  terminalPopupConfigState,
  portForwardStatusListeners,
  portForwardRuntimeListeners,
  fileWatchSyncedListeners,
  fileWatchErrorListeners,
  fileWatchStoppedListeners,
  get _lastTrayMenuData() { return _lastTrayMenuData; },
  set _lastTrayMenuData(value) { _lastTrayMenuData = value; },
});

// Fig autocomplete spec loading via main process
const figSpecApi = {
  listFigSpecs: () => ipcRenderer.invoke("netcatty:figspec:list"),
  loadFigSpec: (commandName) => ipcRenderer.invoke("netcatty:figspec:load", commandName),
  listAutocompleteRemoteDir: (sessionId, dirPath, foldersOnly, filterPrefix, limit) => ipcRenderer.invoke("netcatty:ssh:listdir", {
    sessionId,
    path: dirPath,
    foldersOnly,
    filterPrefix,
    limit,
  }),
  listAutocompleteLocalDir: (dirPath, foldersOnly, filterPrefix, limit) => ipcRenderer.invoke("netcatty:local:listdir", {
    path: dirPath,
    foldersOnly,
    filterPrefix,
    limit,
  }),
};

// Merge with existing netcatty (if any) to avoid stale objects on hot reload
const existing = (typeof window !== "undefined" && window.netcatty) ? window.netcatty : {};

function getAllowedRendererOrigins() {
  const origins = new Set(["app://netcatty"]);
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (typeof devServerUrl === "string" && devServerUrl.length > 0) {
    try {
      const u = new URL(devServerUrl);
      origins.add(u.origin);
      // Vite often binds to 0.0.0.0, but Chromium navigates via localhost.
      if (
        u.hostname === "0.0.0.0" ||
        u.hostname === "127.0.0.1" ||
        u.hostname === "::1" ||
        u.hostname === "[::1]" ||
        u.hostname === "::" ||
        u.hostname === "[::]"
      ) {
        u.hostname = "localhost";
        origins.add(u.origin);
      }
    } catch {
      // ignore invalid dev URL
    }
  }
  return origins;
}

function isTrustedRendererLocation(allowedOrigins) {
  try {
    const origin = window?.location?.origin;
    return typeof origin === "string" && allowedOrigins.has(origin);
  } catch {
    return false;
  }
}

const allowedOrigins = getAllowedRendererOrigins();
if (isTrustedRendererLocation(allowedOrigins)) {
  contextBridge.exposeInMainWorld("netcatty", { ...existing, ...api, ...figSpecApi });
} else {
  // If a window navigates to an untrusted origin, do NOT expose the bridge.
  try {
    console.warn("[Preload] Refusing to expose netcatty bridge to untrusted origin:", window?.location?.origin);
  } catch {
    // ignore
  }
}
