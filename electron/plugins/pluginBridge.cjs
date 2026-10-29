"use strict";

const fs = require("node:fs/promises");
const { randomUUID } = require("node:crypto");

const { createDefinitionValidator } = require("./contractValidator.cjs");
const validateManagedPluginId = createDefinitionValidator("PluginId");

const { raceWithAbort } = require("./rpcRouter.cjs");
const {
  INLINE_SYNC_OBJECT_SAFE_BYTES,
  MAX_SYNC_OBJECT_BYTES,
  STREAM_WINDOW_BYTES,
} = require("./extensionProviderService.cjs");
const { assertSecretKey } = require("./secretStore.cjs");

const CHANNELS = Object.freeze({
  themeCatalog: "netcatty:plugins:theme-catalog",
  themeApply: "netcatty:plugins:theme-apply",
  themesChanged: "netcatty:plugins:themes-changed",
  status: "netcatty:plugins:status",
  logStatus: "netcatty:plugins:log-status",
  logConfigure: "netcatty:plugins:log-configure",
  logOpen: "netcatty:plugins:log-open",
  logExport: "netcatty:plugins:log-export",
  logClear: "netcatty:plugins:log-clear",
  terminalTarget: "netcatty:plugins:terminal-target",
  interactionReady: "netcatty:plugins:interaction-ready",
  interactionResponse: "netcatty:plugins:interaction-response",
  list: "netcatty:plugins:list",
  permissions: "netcatty:plugins:permissions",
  setPermissionMode: "netcatty:plugins:set-permission-mode",
  permissionReady: "netcatty:plugins:permission-ready",
  permissionResponse: "netcatty:plugins:permission-response",
  revokePermissions: "netcatty:plugins:revoke-permissions",
  resetSource: "netcatty:plugins:reset-source",
  sourceBinding: "netcatty:plugins:source-binding",
  sources: "netcatty:plugins:sources",
  addSource: "netcatty:plugins:add-source",
  updateSource: "netcatty:plugins:update-source",
  removeSource: "netcatty:plugins:remove-source",
  catalog: "netcatty:plugins:catalog",
  catalogChanged: "netcatty:plugins:catalog-changed",
  catalogReadme: "netcatty:plugins:catalog-readme",
  catalogReadmeImages: "netcatty:plugins:catalog-readme-images",
  author: "netcatty:plugins:author",
  catalogInstall: "netcatty:plugins:catalog-install",
  install: "netcatty:plugins:install",
  setEnabled: "netcatty:plugins:set-enabled",
  restart: "netcatty:plugins:restart",
  uninstall: "netcatty:plugins:uninstall",
  contributions: "netcatty:plugins:contributions",
  brandIcon: "netcatty:plugins:brand-icon",
  contributionIcon: "netcatty:plugins:contribution-icon",
  contributionsChanged: "netcatty:plugins:contributions-changed",
  executeCommand: "netcatty:plugins:execute-command",
  updateSetting: "netcatty:plugins:update-setting",
  resetSetting: "netcatty:plugins:reset-setting",
  setEnvironment: "netcatty:plugins:set-environment",
  terminalProviders: "netcatty:plugins:terminal-providers",
  terminalProvide: "netcatty:plugins:terminal-provide",
  terminalCancel: "netcatty:plugins:terminal-cancel",
  terminalSessionEvent: "netcatty:plugins:terminal-session-event",
  extensionProviders: "netcatty:plugins:extension-providers",
  extensionInvoke: "netcatty:plugins:extension-invoke",
  extensionCancel: "netcatty:plugins:extension-cancel",
  syncConnect: "netcatty:plugins:sync-connect",
  syncDisconnect: "netcatty:plugins:sync-disconnect",
  syncGetAccount: "netcatty:plugins:sync-get-account",
  syncGetCapabilities: "netcatty:plugins:sync-get-capabilities",
  syncReadObject: "netcatty:plugins:sync-read-object",
  syncReadChunk: "netcatty:plugins:sync-read-chunk",
  syncWriteObject: "netcatty:plugins:sync-write-object",
  syncWriteBegin: "netcatty:plugins:sync-write-begin",
  syncWriteChunk: "netcatty:plugins:sync-write-chunk",
  syncWriteCommit: "netcatty:plugins:sync-write-commit",
  syncDeleteObject: "netcatty:plugins:sync-delete-object",
  syncPutSecret: "netcatty:plugins:sync-put-secret",
  syncDeleteSecrets: "netcatty:plugins:sync-delete-secrets",
  syncRestoreSecrets: "netcatty:plugins:sync-restore-secrets",
  syncSidecarsCollect: "netcatty:plugins:sync-sidecars-collect",
  syncSidecarsApply: "netcatty:plugins:sync-sidecars-apply",
  hostAvailableSync: "netcatty:plugins:host-available-sync",
  connectionStart: "netcatty:plugins:connection-start",
  connectionWrite: "netcatty:plugins:connection-write",
  connectionControl: "netcatty:plugins:connection-control",
  connectionData: "netcatty:plugins:connection-data",
  connectionClosed: "netcatty:plugins:connection-closed",
  credentialCatalogUpdate: "netcatty:plugins:credential-catalog-update",
  authenticationChallenge: "netcatty:plugins:authentication-challenge",
  authenticationRespond: "netcatty:plugins:authentication-respond",
  importerDetect: "netcatty:plugins:importer-detect",
  importerSelectFile: "netcatty:plugins:importer-select-file",
  importerReleaseFile: "netcatty:plugins:importer-release-file",
  importerParseFile: "netcatty:plugins:importer-parse-file",
  importerProgress: "netcatty:plugins:importer-progress",
  hostDrawnOpen: "netcatty:plugins:host-ui-open",
  hostDrawnClose: "netcatty:plugins:host-ui-close",
  hostDrawnEvent: "netcatty:plugins:host-ui-event",
  getScopeCatalog: "netcatty:plugins:get-scope-catalog",
  setScopeCatalog: "netcatty:plugins:set-scope-catalog",
  scopeCatalogChanged: "netcatty:plugins:scope-catalog-changed",
});

const SCOPE_KINDS = Object.freeze(["workspace", "host", "session", "device"]);
const MAX_ACTIVE_TERMINAL_REQUESTS_PER_SENDER = 64;
const MAX_SYNC_TRANSFERS_PER_SENDER = 8;
const SYNC_TRANSFER_TTL_MS = 5 * 60_000;
const MAX_IMPORT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_IMPORT_SELECTIONS_PER_SENDER = 8;
const IMPORT_SELECTION_TTL_MS = 5 * 60_000;
const DEFAULT_CONNECTION_STATUS_POLL_MS = 500;

function boundedErrorMessage(value, fallback = "Plugin connection failed") {
  const message = typeof value === "string" && value
    ? value
    : value && typeof value === "object" && typeof value.message === "string" && value.message
      ? value.message
      : fallback;
  return String(message).slice(0, 2048);
}

function connectionOutputCloseDetails(reason) {
  if (reason === "end") return { reason: "exited", exitCode: 0 };
  if (typeof reason === "string") return { reason: "closed" };
  if (reason && typeof reason === "object") {
    return {
      reason: "error",
      error: boundedErrorMessage(reason, "Plugin connection output stream failed"),
    };
  }
  return { reason: "closed" };
}

function boundedConnectionDiagnostics(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 256).flatMap((issue) => {
    if (!issue || typeof issue !== "object" || Array.isArray(issue)) return [];
    const severity = issue.severity === "error" ? "error" : "warning";
    const message = typeof issue.message === "string" && issue.message
      ? issue.message.slice(0, 2048)
      : "";
    if (!message) return [];
    const code = typeof issue.code === "string" && issue.code
      ? issue.code.slice(0, 128)
      : undefined;
    const path = typeof issue.path === "string" && issue.path
      ? issue.path.slice(0, 1024)
      : undefined;
    return [Object.freeze({
      severity,
      message,
      ...(code ? { code } : {}),
      ...(path ? { path } : {}),
    })];
  });
}

function connectionStatusCloseDetails(status) {
  const diagnostics = boundedConnectionDiagnostics(status?.diagnostics);
  return {
    reason: status?.status === "error" ? "error" : "closed",
    ...(status?.message ? { error: boundedErrorMessage(status.message) } : {}),
    ...(diagnostics.length > 0 ? { diagnostics } : {}),
  };
}

function normalizePluginScopeCatalog(value) {
  const source = value && typeof value === "object" ? value : {};
  const result = {};
  let total = 0;
  for (const kind of SCOPE_KINDS) {
    const entries = Array.isArray(source[kind]) ? source[kind] : [];
    const seen = new Set();
    result[kind] = [];
    for (const entry of entries) {
      const id = typeof entry?.id === "string" ? entry.id.trim() : "";
      const label = typeof entry?.label === "string" ? entry.label.trim() : "";
      if (!id || id.length > 256 || id.includes("\0") || !label || label.length > 512 || seen.has(id)) continue;
      if (++total > 4096) throw new TypeError("Plugin setting scope catalog is too large");
      seen.add(id);
      result[kind].push(Object.freeze({ id, label }));
    }
    Object.freeze(result[kind]);
  }
  return Object.freeze(result);
}

function mergePluginScopeCatalogs(catalogs) {
  const result = {};
  let total = 0;
  for (const kind of SCOPE_KINDS) {
    const seen = new Set();
    result[kind] = [];
    for (const catalog of catalogs) {
      for (const entry of catalog?.[kind] ?? []) {
        if (seen.has(entry.id) || total >= 4096) continue;
        seen.add(entry.id);
        total += 1;
        result[kind].push(entry);
      }
    }
    Object.freeze(result[kind]);
  }
  return Object.freeze(result);
}

function createTrustedPluginBridgeSender(options = {}) {
  const devServerOrigin = options.devServerUrl ? new URL(options.devServerUrl).origin : null;
  return (event) => {
    // The app may embed untrusted frames; a trusted URL alone is not authority.
    if (event?.sender?.mainFrame && event.senderFrame !== event.sender.mainFrame) return false;
    const senderUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || "";
    try {
      const url = new URL(senderUrl);
      if (url.protocol === "app:" && url.hostname === "netcatty") return true;
      return Boolean(devServerOrigin && url.origin === devServerOrigin);
    } catch {
      return false;
    }
  };
}

function registerPluginBridge(ipcMain, options) {
  const manager = options.manager;
  const contributionService = options.contributionService;
  const terminalProviderService = options.terminalProviderService;
  const terminalDataPipelineService = options.terminalDataPipelineService;
  const extensionProviderService = options.extensionProviderService;
  const syncSidecarService = options.syncSidecarService;
  const credentialResolver = options.credentialResolver;
  const secretStore = options.secretStore;
  const connectionStatusPollMs = Number.isSafeInteger(options.connectionStatusPollMs)
    && options.connectionStatusPollMs >= 0
    && options.connectionStatusPollMs <= 60_000
    ? options.connectionStatusPollMs
    : DEFAULT_CONNECTION_STATUS_POLL_MS;
  const getTerminalWorkerManager = options.getTerminalWorkerManager ?? (() => null);
  const selectImporterFile = options.selectImporterFile;
  const hostDrawnViewHost = options.hostDrawnViewHost;
  const isTrustedSender = options.isTrustedSender;
  const defaultScopeCatalog = normalizePluginScopeCatalog({ device: [{ id: "device", label: "This device" }] });
  const scopeCatalogs = new Map();
  const scopeCatalogOwners = new Map();
  const observedScopeCatalogSenders = new WeakSet();
  const terminalRequestsBySender = new WeakMap();
  const observedTerminalRequestSenders = new WeakSet();
  const extensionRequestsBySender = new WeakMap();
  const observedExtensionRequestSenders = new WeakSet();
  const connectionSessionsBySender = new WeakMap();
  const connectionMonitorsBySender = new WeakMap();
  const observedConnectionSenders = new WeakSet();
  const authenticationChallengesBySender = new WeakMap();
  const observedAuthenticationSenders = new WeakSet();
  const importerSelectionsBySender = new WeakMap();
  const observedImporterSelectionSenders = new WeakSet();
  const syncTransfersBySender = new WeakMap();
  const observedSyncTransferSenders = new WeakSet();
  const scopeCatalogSenderKey = (event) => {
    const id = event?.sender?.id;
    return Number.isSafeInteger(id) && id > 0 ? id : "default";
  };
  const currentScopeCatalog = () => mergePluginScopeCatalogs([
    ...scopeCatalogs.values(),
    defaultScopeCatalog,
  ]);
  const publishScopeCatalog = (event) => {
    const catalog = currentScopeCatalog();
    if (typeof options.broadcast === "function") options.broadcast(CHANNELS.scopeCatalogChanged, catalog);
    else event?.sender?.send?.(CHANNELS.scopeCatalogChanged, catalog);
  };
  const observeScopeCatalogSender = (event, key) => {
    const sender = event?.sender;
    if (!sender || typeof sender !== "object" || observedScopeCatalogSenders.has(sender)) return;
    observedScopeCatalogSenders.add(sender);
    sender.once?.("destroyed", () => {
      if (scopeCatalogOwners.get(key) !== sender) return;
      scopeCatalogOwners.delete(key);
      if (scopeCatalogs.delete(key)) publishScopeCatalog();
    });
  };
  const configured = Boolean(manager)
    && typeof manager.initialize === "function";
  const resolveManager = async () => {
    if (!configured) throw new Error("Plugin runtime is disabled or unavailable");
    try {
      await manager.initialize();
    } catch (cause) {
      throw new Error("Plugin runtime is disabled or unavailable", { cause });
    }
    return manager;
  };
  const handle = (channel, callback) => {
    ipcMain.handle(channel, async (event, payload) => {
      if (!isTrustedSender(event)) throw new Error("Untrusted plugin management sender");
      const activeManager = await resolveManager();
      return callback(activeManager, payload, event);
    });
  };
  // These channels are called by ordinary host/terminal lifecycles even when
  // the experimental plugin runtime is disabled. Treat the disabled runtime as
  // an empty provider set instead of throwing (and making Electron print a
  // stack trace) on every terminal mount, Vault refresh, and scope update.
  const handlePassive = (channel, fallback, callback) => {
    ipcMain.handle(channel, async (event, payload) => {
      if (!isTrustedSender(event)) throw new Error("Untrusted plugin management sender");
      let activeManager;
      try {
        activeManager = await resolveManager();
      } catch {
        return typeof fallback === "function" ? fallback(payload, event) : fallback;
      }
      return callback(activeManager, payload, event);
    });
  };
  const terminalRequestMap = (sender) => {
    if (!sender || typeof sender !== "object") throw new Error("Plugin terminal request sender is unavailable");
    let requests = terminalRequestsBySender.get(sender);
    if (!requests) {
      requests = new Map();
      terminalRequestsBySender.set(sender, requests);
    }
    if (!observedTerminalRequestSenders.has(sender)) {
      observedTerminalRequestSenders.add(sender);
      sender.once?.("destroyed", () => {
        for (const controller of requests.values()) controller.abort();
        requests.clear();
      });
    }
    return requests;
  };
  const extensionRequestMap = (sender) => {
    if (!sender || typeof sender !== "object") throw new Error("Plugin extension request sender is unavailable");
    let requests = extensionRequestsBySender.get(sender);
    if (!requests) {
      requests = new Map();
      extensionRequestsBySender.set(sender, requests);
    }
    if (!observedExtensionRequestSenders.has(sender)) {
      observedExtensionRequestSenders.add(sender);
      sender.once?.("destroyed", () => {
        for (const controller of requests.values()) controller.abort();
        requests.clear();
      });
    }
    return requests;
  };
  const runExtensionRequest = async (event, payload, callback) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted plugin management sender");
    const requestId = payload?.requestId;
    if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 128 || requestId.includes("\0")) {
      throw new TypeError("Plugin extension request ID is invalid");
    }
    const requests = extensionRequestMap(event.sender);
    if (requests.has(requestId)) throw new Error("Plugin extension request ID is already active");
    if (requests.size >= MAX_ACTIVE_TERMINAL_REQUESTS_PER_SENDER) {
      throw new Error("Too many active Plugin extension requests");
    }
    const controller = new AbortController();
    requests.set(requestId, controller);
    try {
      await raceWithAbort(resolveManager(), controller.signal);
      return await callback(controller.signal);
    } finally {
      if (requests.get(requestId) === controller) requests.delete(requestId);
    }
  };
  const connectionSessionMap = (sender) => {
    if (!sender || typeof sender !== "object") throw new Error("Plugin connection sender is unavailable");
    let sessions = connectionSessionsBySender.get(sender);
    if (!sessions) {
      sessions = new Map();
      connectionSessionsBySender.set(sender, sessions);
    }
    if (!observedConnectionSenders.has(sender)) {
      observedConnectionSenders.add(sender);
      sender.once?.("destroyed", () => {
        const monitors = connectionMonitorsBySender.get(sender);
        for (const monitor of monitors?.values?.() ?? []) monitor.controller.abort();
        monitors?.clear?.();
        const ownedSessions = [...sessions];
        sessions.clear();
        for (const [sessionId, sessionOwner] of ownedSessions) {
          void (async () => {
            try {
              await extensionProviderService?.control?.(sessionId, "close", {}, { sessionOwner });
            } catch {
              extensionProviderService?.closeSessionLocal?.(sessionId, undefined, sessionOwner);
            }
            try {
              await getTerminalWorkerManager()?.finishExternalSession?.(sessionId, { reason: "closed" }, sessionOwner);
            } catch {}
          })();
        }
      });
    }
    return sessions;
  };
  const connectionMonitorMap = (sender) => {
    if (!sender || typeof sender !== "object") throw new Error("Plugin connection sender is unavailable");
    let monitors = connectionMonitorsBySender.get(sender);
    if (!monitors) {
      monitors = new Map();
      connectionMonitorsBySender.set(sender, monitors);
    }
    return monitors;
  };
  const authenticationChallengeMap = (sender) => {
    if (!sender || typeof sender !== "object") throw new Error("Plugin authentication sender is unavailable");
    let challenges = authenticationChallengesBySender.get(sender);
    if (!challenges) {
      challenges = new Map();
      authenticationChallengesBySender.set(sender, challenges);
    }
    if (!observedAuthenticationSenders.has(sender)) {
      observedAuthenticationSenders.add(sender);
      sender.once?.("destroyed", () => {
        for (const pending of challenges.values()) pending.reject(new Error("Plugin authentication window closed"));
        challenges.clear();
      });
    }
    return challenges;
  };
  const requestAuthenticationChallenge = (event, requestId, challenge, signal) => {
    const challenges = authenticationChallengeMap(event.sender);
    const challengeRequestId = randomUUID();
    return new Promise((resolve, reject) => {
      const sendCancellation = () => {
        try {
          event.sender.send(CHANNELS.authenticationChallenge, {
            requestId,
            challengeRequestId,
            challengeId: challenge.id,
            cancelled: true,
          });
        } catch {}
      };
      const onAbort = () => {
        if (!challenges.delete(challengeRequestId)) return;
        signal?.removeEventListener?.("abort", onAbort);
        sendCancellation();
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      };
      const finish = (callback, value) => {
        signal?.removeEventListener?.("abort", onAbort);
        callback(value);
      };
      challenges.set(challengeRequestId, {
        requestId,
        challengeId: challenge.id,
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener?.("abort", onAbort, { once: true });
      try {
        event.sender.send(CHANNELS.authenticationChallenge, {
          requestId,
          challengeRequestId,
          challenge,
        });
      } catch (error) {
        challenges.delete(challengeRequestId);
        finish(reject, error);
      }
    });
  };
  const closeImporterSelection = (selection) => {
    if (!selection?.handle) return;
    void selection.handle.close().catch(() => {});
  };
  const waitForConnectionStatusPoll = (signal) => new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Plugin connection monitoring was cancelled", "AbortError"));
      return;
    }
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Plugin connection monitoring was cancelled", "AbortError"));
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, connectionStatusPollMs);
    // A zero-delay poll is used by deterministic tests and should retain the
    // event loop until its immediate callback runs. Longer production polls
    // remain unrefed so monitoring cannot keep the Electron process alive.
    if (connectionStatusPollMs > 0) timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
  const pluginConnectionReadyMeta = Object.freeze({ pluginPipelineIngressBytes: 0, pluginConnectionReady: true });
  const monitorPluginConnection = async ({
    sessionId,
    sessionOwner,
    sessions,
    monitors,
    controller,
    terminalWorkerManager,
    readyPublished = false,
  }) => {
    if (typeof extensionProviderService?.control !== "function") return;
    let hasPublishedReady = readyPublished;
    let reconnectAttempted = false;
    try {
      while (!controller.signal.aborted && sessions.get(sessionId) === sessionOwner) {
        await waitForConnectionStatusPoll(controller.signal);
        if (controller.signal.aborted || sessions.get(sessionId) !== sessionOwner) return;
        const status = await extensionProviderService.control(
          sessionId,
          "getStatus",
          {},
          { signal: controller.signal, sessionOwner },
        );
        if (status.status === "connected") {
          reconnectAttempted = false;
          // A zero-byte terminal delivery transitions silent protocols out of
          // the connecting UI without inventing visible terminal output.
          if (!hasPublishedReady) {
            await terminalWorkerManager.pushExternalOutput(sessionId, "", pluginConnectionReadyMeta, sessionOwner);
            hasPublishedReady = true;
          }
          continue;
        }
        if (status.status === "closed" || status.status === "error") {
          if (status.retryable === true && !reconnectAttempted) {
            reconnectAttempted = true;
            await extensionProviderService.control(
              sessionId,
              "reconnect",
              {},
              { signal: controller.signal, sessionOwner },
            );
            continue;
          }
          if (sessions.get(sessionId) === sessionOwner) sessions.delete(sessionId);
          try {
            await terminalWorkerManager.finishExternalSession(
              sessionId,
              connectionStatusCloseDetails(status),
              sessionOwner,
            );
          } finally {
            extensionProviderService.closeSessionLocal(sessionId, undefined, sessionOwner);
          }
          return;
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      if (sessions.get(sessionId) === sessionOwner) sessions.delete(sessionId);
      try {
        await terminalWorkerManager.finishExternalSession(sessionId, {
          reason: "error",
          error: boundedErrorMessage(error),
        }, sessionOwner);
      } finally {
        extensionProviderService.closeSessionLocal(sessionId, undefined, sessionOwner);
      }
    } finally {
      if (monitors.get(sessionId)?.sessionOwner === sessionOwner) monitors.delete(sessionId);
    }
  };
  const importerSelectionMap = (sender) => {
    if (!sender || typeof sender !== "object") throw new Error("Plugin importer sender is unavailable");
    let selections = importerSelectionsBySender.get(sender);
    if (!selections) {
      selections = new Map();
      importerSelectionsBySender.set(sender, selections);
    }
    if (!observedImporterSelectionSenders.has(sender)) {
      observedImporterSelectionSenders.add(sender);
      sender.once?.("destroyed", () => {
        for (const selection of selections.values()) closeImporterSelection(selection);
        selections.clear();
      });
    }
    const now = Date.now();
    for (const [token, selection] of selections) {
      if (selection.expiresAt <= now) {
        selections.delete(token);
        closeImporterSelection(selection);
      }
    }
    return selections;
  };
  const syncTransferMap = (sender) => {
    if (!sender || typeof sender !== "object") throw new Error("Plugin sync transfer sender is unavailable");
    let transfers = syncTransfersBySender.get(sender);
    if (!transfers) {
      transfers = new Map();
      syncTransfersBySender.set(sender, transfers);
    }
    if (!observedSyncTransferSenders.has(sender)) {
      observedSyncTransferSenders.add(sender);
      sender.once?.("destroyed", () => {
        for (const [transferId, transfer] of [...transfers.entries()]) {
          try {
            transfer.controller?.abort();
            if (transfer.requestId) {
              extensionRequestMap(sender).delete(transfer.requestId);
            }
          } catch { /* ignore */ }
          transfers.delete(transferId);
        }
      });
    }
    const now = Date.now();
    for (const [transferId, transfer] of [...transfers.entries()]) {
      if (typeof transfer.expiresAt === "number" && transfer.expiresAt <= now) {
        try {
          transfer.controller?.abort();
          if (transfer.requestId) extensionRequestMap(sender).delete(transfer.requestId);
        } catch { /* ignore */ }
        transfers.delete(transferId);
      }
    }
    return transfers;
  };
  const releaseSyncTransfer = (sender, transferId, transfer) => {
    const transfers = syncTransfersBySender.get(sender);
    if (transfers && transferId && transfers.get(transferId) === transfer) {
      transfers.delete(transferId);
    }
    if (transfer?.requestId) {
      const requests = extensionRequestMap(sender);
      if (requests.get(transfer.requestId) === transfer.controller || transfer.controller == null) {
        requests.delete(transfer.requestId);
      }
    }
  };
  const assertSyncTransferBudget = (transfers) => {
    if (transfers.size >= MAX_SYNC_TRANSFERS_PER_SENDER) {
      throw new Error("Too many active Plugin sync transfers");
    }
  };
  const coerceIpcBytes = (value, label) => {
    if (value instanceof Uint8Array) return value;
    if (Buffer.isBuffer(value)) return value;
    if (ArrayBuffer.isView(value)) {
      return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    }
    if (value && typeof value === "object" && value.type === "Buffer" && Array.isArray(value.data)) {
      return Buffer.from(value.data);
    }
    throw new TypeError(`${label} must be binary bytes`);
  };
  const registerStreamingWriteRequest = (event, requestId) => {
    if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 128 || requestId.includes("\0")) {
      throw new TypeError("Plugin extension request ID is invalid");
    }
    const requests = extensionRequestMap(event.sender);
    if (requests.has(requestId)) throw new Error("Plugin extension request ID is already active");
    if (requests.size >= MAX_ACTIVE_TERMINAL_REQUESTS_PER_SENDER) {
      throw new Error("Too many active Plugin extension requests");
    }
    const controller = new AbortController();
    requests.set(requestId, controller);
    return controller;
  };
  ipcMain.handle(CHANNELS.status, async (event) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted plugin management sender");
    let available = false;
    try {
      await resolveManager();
      available = true;
    } catch {}
    return { available, experimental: true,
      ...(typeof credentialResolver?.isAvailable === "function"
        ? { credentialStorageAvailable: credentialResolver.isAvailable() } : {}),
    };
  });
  handle(CHANNELS.sources, async () => options.catalogService?.listSources() ?? []);
  handle(CHANNELS.addSource, async (_manager, payload) => options.catalogService.addSource(payload));
  handle(CHANNELS.updateSource, async (_manager, payload) => options.catalogService.updateSource(payload));
  handle(CHANNELS.removeSource, async (_manager, payload) => options.catalogService.removeSource(payload));
  handle(CHANNELS.catalog, async (_manager, payload) => options.catalogService?.list(payload?.sourceId) ?? { entries: [], source: "builtin", error: "Plugin catalog unavailable" });
  handle(CHANNELS.author, async (_manager, payload) => {
    if (!options.catalogService) throw new Error("Plugin catalog unavailable");
    return options.catalogService.author(payload);
  });
  handle(CHANNELS.catalogReadme, async (_manager, payload) => {
    if (!options.catalogService) throw new Error("Plugin catalog unavailable");
    return options.catalogService.readme(payload?.id, payload?.selectionToken, payload?.sourceId);
  });
  handle(CHANNELS.catalogReadmeImages, async (_manager, payload) => {
    if (!options.catalogService) throw new Error("Plugin catalog unavailable");
    return options.catalogService.readmeImages(payload?.id, payload?.selectionToken, payload?.sourceId);
  });
  handle(CHANNELS.catalogInstall, async (_manager, payload) => {
    if (!options.catalogService) throw new Error("Plugin catalog unavailable");
    return options.catalogService.install(payload?.id, payload?.selectionToken, payload?.sourceId, payload?.acceptedSourceId);
  });
  handle(CHANNELS.interactionReady, async (_manager, payload, event) => {
    if (!options.interactionService) throw new Error("Host interactions are unavailable");
    return options.interactionService.setReady(event.sender, payload?.ready);
  });
  handle(CHANNELS.interactionResponse, async (_manager, payload, event) => {
    if (!options.interactionService) throw new Error("Host interactions are unavailable");
    return options.interactionService.respond(event.sender, payload);
  });
  handle(CHANNELS.list, async (activeManager) => activeManager.list());
  handle(CHANNELS.sourceBinding, async (activeManager, payload) => activeManager.database.getRetainedPluginSource(assertManagedPluginId(payload)));
  handle(CHANNELS.resetSource, async (activeManager, payload) => activeManager.resetUninstalledSource(assertManagedPluginId(payload), payload?.expectedSourceId));
  const assertManagedPluginId = (payload) => {
    const id = payload?.pluginId;
    if (!validateManagedPluginId(id)) {
      throw new TypeError("Plugin ID is invalid");
    }
    return id;
  };
  for (const [channel, action] of [
    [CHANNELS.logStatus, "status"], [CHANNELS.logConfigure, "configure"],
    [CHANNELS.logOpen, "openFolder"], [CHANNELS.logExport, "exportLogs"], [CHANNELS.logClear, "clear"],
  ]) handle(channel, async (_manager, payload) => {
    if (!options.logService) throw new Error("Local plugin logging is unavailable");
    await options.logService.ready;
    return options.logService[action](payload);
  });
  const permissionSender = (event) => {
    if ("senderFrame" in event && (!event.senderFrame || event.senderFrame !== event.sender?.mainFrame)) throw new Error("Untrusted permission UI frame");
    return event.sender;
  };
  handle(CHANNELS.permissionReady, async (_manager, payload, event) => options.permissionDecisionHost?.setReady(permissionSender(event), payload?.ready));
  handle(CHANNELS.permissionResponse, async (_manager, payload, event) => options.permissionDecisionHost?.respond(permissionSender(event), payload));
  handle(CHANNELS.setPermissionMode, async (_manager, payload) => {
    const pluginId = assertManagedPluginId(payload);
    const plugin = options.database?.getActivePlugin(pluginId);
    if (!plugin || !options.permissionEngine) throw new Error("Plugin permissions are unavailable");
    if (typeof payload?.policyRevision !== "string" || payload.policyRevision !== options.permissionEngine.getPolicyRevision(plugin)) {
      throw new Error("Plugin permissions changed; refresh before editing");
    }
    await options.permissionEngine.setMode(plugin, payload?.permission, payload?.mode);
    return true;
  });
  handle(CHANNELS.permissions, async (_manager, payload) => {
    const pluginId = assertManagedPluginId(payload);
    if (!options.permissionEngine || !options.database) throw new Error("Plugin permissions are unavailable");
    const plugin = options.database.getActivePlugin(pluginId);
    const identity = options.runtimeSupervisor?.getRuntimeIdentity(pluginId);
    // A stored grant is effective only for its matching host-owned activation.
    // Disabled/lazy/stopped plugins retain saved grants without claiming they
    // currently apply. Never infer a principal from plugin-provided metadata.
    const context = plugin?.enabled && identity?.pluginVersion === plugin.activeVersion
      ? { ...identity, manifest: plugin.manifest }
      : null;
    const groups = options.permissionEngine.describeGrants(pluginId, context);
    // Host-only summaries: never return arbitrary audit details, reasons,
    // operation IDs, credentials, terminal content or future database columns.
    const grants = ["always", "application", "session"].flatMap((scope) => (
      (groups[scope] ?? []).map((grant) => ({
        permission: grant.permission, resource: grant.resource,
        resourceKind: grant.resourceKind, scope,
        sessionId: grant.sessionId ?? null, grantedAt: grant.grantedAt,
        matchesCurrentActivation: grant.matchesCurrentActivation,
      }))
    ));
    const audit = options.database.listSecurityAudit(pluginId, 100).map((entry) => ({
      event: entry.event, createdAt: entry.createdAt,
      ...(typeof entry.details?.permission === "string" ? { permission: entry.details.permission } : {}),
      ...(typeof entry.details?.scope === "string" ? { scope: entry.details.scope } : {}),
      ...(["allow", "ask", "deny"].includes(entry.details?.mode) ? { mode: entry.details.mode } : {}),
      ...(["completed", "cancelled", "preview-confirmed", "share-confirmed", "copy-confirmed", "draft-reviewed", "action-confirmed", "action-claimed"].includes(entry.details?.action)
        ? { action: entry.details.action } : {}),
    }));
    return { grants, audit, ...(options.permissionEngine.describePolicies && plugin
      ? { policies: options.permissionEngine.describePolicies(plugin), policyRevision: options.permissionEngine.getPolicyRevision(plugin) } : {}) };
  });
  handle(CHANNELS.revokePermissions, async (activeManager, payload) => (
    activeManager.revokePermissions(assertManagedPluginId(payload))
  ));
  handle(CHANNELS.install, async (activeManager, payload) => activeManager.install(
    payload?.archivePath,
    { enable: typeof payload?.enable === "boolean" ? payload.enable : undefined },
  ));
  handle(CHANNELS.setEnabled, async (activeManager, payload) => activeManager.setEnabled(
    payload?.pluginId,
    payload?.enabled === true,
  ));
  handle(CHANNELS.restart, async (activeManager, payload) => activeManager.restart(payload?.pluginId));
  handle(CHANNELS.uninstall, async (activeManager, payload) => activeManager.uninstall(payload?.pluginId));
  handle(CHANNELS.terminalTarget, async (_manager, target, event) => {
    if (!options.interactionService) throw new Error("Host interactions unavailable");
    return options.interactionService.setTerminalTarget(event.sender, target);
  });
  handle(CHANNELS.themeCatalog, async () => {
    if (!options.themeService) throw new Error("Plugin themes are unavailable");
    return options.themeService.catalog();
  });
  handle(CHANNELS.themeApply, async (_manager, request) => {
    if (!options.themeService) throw new Error("Plugin themes are unavailable");
    return options.themeService.apply(request);
  });
  options.themeService?.onDidChange?.(() => options.broadcast?.(CHANNELS.themesChanged, {}));
  handle(CHANNELS.contributions, async (_activeManager, payload) => {
    if (!contributionService) throw new Error("Plugin contributions are unavailable");
    return contributionService.snapshot(payload ?? {});
  });
  handle(CHANNELS.brandIcon, async (_activeManager, payload) => {
    if (!options.resolveBrandIcon) throw new Error("Plugin brand icons are unavailable");
    return options.resolveBrandIcon(payload?.pluginId);
  });
  handle(CHANNELS.contributionIcon, async (_activeManager, payload) => {
    if (!options.resolveContributionIcon) throw new Error("Plugin contribution icons are unavailable");
    return options.resolveContributionIcon(payload);
  });
  handle(CHANNELS.executeCommand, async (_activeManager, payload) => {
    if (!contributionService) throw new Error("Plugin contributions are unavailable");
    return contributionService.executeCommand(payload?.command, payload?.args, {
      source: "renderer",
      context: payload?.context,
    });
  });
  handle(CHANNELS.updateSetting, async (_activeManager, payload) => {
    if (!contributionService) throw new Error("Plugin contributions are unavailable");
    return contributionService.updateSetting(
      payload?.pluginId,
      payload?.settingId,
      payload?.value,
      payload?.scopeId,
      { source: "host" },
    );
  });
  handle(CHANNELS.resetSetting, async (_activeManager, payload) => {
    if (!contributionService) throw new Error("Plugin contributions are unavailable");
    return contributionService.resetSetting(payload?.pluginId, payload?.settingId, payload?.scopeId);
  });
  handle(CHANNELS.setEnvironment, async (_activeManager, payload) => {
    if (!contributionService) throw new Error("Plugin contributions are unavailable");
    await contributionService.setEnvironment(payload ?? {});
    return null;
  });
  handlePassive(CHANNELS.terminalProviders, [], async (_activeManager, payload) => {
    if (!terminalProviderService) throw new Error("Plugin Terminal Providers are unavailable");
    return terminalProviderService.listProviders(payload ?? {});
  });
  ipcMain.handle(CHANNELS.terminalProvide, async (event, payload) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted plugin management sender");
    if (!terminalProviderService) throw new Error("Plugin Terminal Providers are unavailable");
    const requestId = payload?.requestId;
    if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 128 || requestId.includes("\0")) {
      throw new TypeError("Plugin terminal request ID is invalid");
    }
    const requests = terminalRequestMap(event.sender);
    if (requests.has(requestId)) throw new Error("Plugin terminal request ID is already active");
    if (requests.size >= MAX_ACTIVE_TERMINAL_REQUESTS_PER_SENDER) {
      throw new Error("Too many active Plugin terminal requests");
    }
    const controller = new AbortController();
    requests.set(requestId, controller);
    try {
      await raceWithAbort(resolveManager(), controller.signal);
      const { requestId: _requestId, ...providerRequest } = payload;
      return await terminalProviderService.provide(providerRequest, { signal: controller.signal });
    } finally {
      if (requests.get(requestId) === controller) requests.delete(requestId);
    }
  });
  ipcMain.handle(CHANNELS.terminalCancel, async (event, payload) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted plugin management sender");
    const requestId = payload?.requestId;
    if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 128) {
      throw new TypeError("Plugin terminal request ID is invalid");
    }
    const requests = terminalRequestMap(event.sender);
    const controller = requests.get(requestId);
    controller?.abort();
    return controller != null;
  });
  handlePassive(CHANNELS.terminalSessionEvent, [], async (_activeManager, payload, event) => {
    if (!terminalProviderService) throw new Error("Plugin Terminal Providers are unavailable");
    if (terminalDataPipelineService?.acceptsSessionEvent
      && !terminalDataPipelineService.acceptsSessionEvent(payload, event?.sender?.id)) {
      return [];
    }
    const [providers] = await Promise.all([
      terminalProviderService.publishSessionEvent(payload),
      terminalDataPipelineService?.handleSessionEvent?.(payload, {
        webContentsId: event?.sender?.id,
      }) ?? [],
    ]);
    return providers;
  });
  handlePassive(CHANNELS.extensionProviders, [], async (_activeManager, payload) => {
    if (!extensionProviderService) throw new Error("Plugin extension Providers are unavailable");
    return extensionProviderService.listProviders(payload ?? {});
  });

  // Synchronous readiness probe for renderer restore paths (no await).
  ipcMain.on(CHANNELS.hostAvailableSync, (event) => {
    event.returnValue = Boolean(syncSidecarService);
  });

  // Fallback null = host gated off / manager unavailable. Renderer must treat
  // null as "unavailable" (last-known) rather than an authoritative empty set.
  handlePassive(CHANNELS.syncSidecarsCollect, null, async () => {
    if (!syncSidecarService) return null;
    return syncSidecarService.collectForSync();
  });

  handlePassive(CHANNELS.syncSidecarsApply, null, async (_activeManager, payload) => {
    if (!syncSidecarService) return { applied: false };
    const entries = await syncSidecarService.applyFromSync(payload ?? { version: 1, entries: [] });
    // Include merged entries so the renderer can refresh last-known without a
    // follow-up collect (preserves missing-plugin rows remote omitted).
    return { applied: true, count: entries.length, entries };
  });

  const runSyncProvider = (channel, methodName) => {
    ipcMain.handle(channel, async (event, payload) => runExtensionRequest(event, payload, async (signal) => {
      if (!extensionProviderService) throw new Error("Plugin sync Providers are unavailable");
      const method = extensionProviderService[methodName];
      if (typeof method !== "function") throw new Error(`Plugin sync method missing: ${methodName}`);
      return method.call(extensionProviderService, payload ?? {}, { signal });
    }));
  };

  runSyncProvider(CHANNELS.syncConnect, "connectSync");
  runSyncProvider(CHANNELS.syncDisconnect, "disconnectSync");
  runSyncProvider(CHANNELS.syncGetAccount, "getSyncAccount");
  runSyncProvider(CHANNELS.syncGetCapabilities, "getSyncCapabilities");
  runSyncProvider(CHANNELS.syncDeleteObject, "deleteSyncObject");

  ipcMain.handle(CHANNELS.syncReadObject, async (event, payload) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted plugin management sender");
    if (!extensionProviderService) throw new Error("Plugin sync Providers are unavailable");
    const requestId = payload?.requestId;
    const controller = registerStreamingWriteRequest(event, requestId);
    try {
      await raceWithAbort(resolveManager(), controller.signal);
      const result = await extensionProviderService.readSyncObject(payload ?? {}, {
        signal: controller.signal,
      });
      if (!result?.found || !result.bytes) {
        extensionRequestMap(event.sender).delete(requestId);
        return { found: false, key: payload?.key, data: null };
      }
      const bytes = result.bytes instanceof Uint8Array
        ? result.bytes
        : new Uint8Array(result.bytes);
      const preferStream = payload?.preferStream === true;
      if (!preferStream && bytes.byteLength <= INLINE_SYNC_OBJECT_SAFE_BYTES) {
        extensionRequestMap(event.sender).delete(requestId);
        return {
          found: true,
          key: result.key,
          data: bytes,
          revision: result.revision,
          contentType: result.contentType,
        };
      }
      const transfers = syncTransferMap(event.sender);
      assertSyncTransferBudget(transfers);
      const transferId = randomUUID();
      const transfer = {
        kind: "read",
        sender: event.sender,
        requestId,
        controller,
        bytes,
        offset: 0,
        expiresAt: Date.now() + SYNC_TRANSFER_TTL_MS,
      };
      transfers.set(transferId, transfer);
      const onAbort = () => releaseSyncTransfer(event.sender, transferId, transfer);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      transfer.onAbort = onAbort;
      return {
        found: true,
        key: result.key,
        streamed: true,
        transferId,
        byteLength: bytes.byteLength,
        revision: result.revision,
        contentType: result.contentType,
      };
    } catch (error) {
      extensionRequestMap(event.sender).delete(requestId);
      throw error;
    }
  });

  ipcMain.handle(CHANNELS.syncReadChunk, async (event, payload) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted plugin management sender");
    const transferId = payload?.transferId;
    if (typeof transferId !== "string" || transferId.length < 1) {
      throw new TypeError("Sync read transfer ID is invalid");
    }
    const transfers = syncTransferMap(event.sender);
    const transfer = transfers.get(transferId);
    if (!transfer || transfer.kind !== "read") {
      throw new Error("Sync read transfer is not owned by this window");
    }
    if (payload?.requestId !== transfer.requestId) {
      throw new Error("Sync read transfer request ID mismatch");
    }
    if (transfer.controller?.signal?.aborted) {
      releaseSyncTransfer(event.sender, transferId, transfer);
      throw new DOMException("Aborted", "AbortError");
    }
    transfer.expiresAt = Date.now() + SYNC_TRANSFER_TTL_MS;
    const maxBytes = Number.isSafeInteger(payload?.maxBytes) && payload.maxBytes > 0
      ? Math.min(payload.maxBytes, STREAM_WINDOW_BYTES)
      : STREAM_WINDOW_BYTES;
    const start = transfer.offset;
    const end = Math.min(transfer.bytes.byteLength, start + maxBytes);
    const chunk = transfer.bytes.subarray(start, end);
    transfer.offset = end;
    const done = end >= transfer.bytes.byteLength;
    if (done) releaseSyncTransfer(event.sender, transferId, transfer);
    return { chunk, done };
  });

  ipcMain.handle(CHANNELS.syncWriteObject, async (event, payload) => runExtensionRequest(event, payload, async (signal) => {
    if (!extensionProviderService) throw new Error("Plugin sync Providers are unavailable");
    const data = coerceIpcBytes(payload?.data ?? payload?.bytes, "Sync writeObject data");
    if (data.byteLength > INLINE_SYNC_OBJECT_SAFE_BYTES) {
      throw new Error("Sync writeObject payload requires the streamed write path");
    }
    if (data.byteLength > MAX_SYNC_OBJECT_BYTES) {
      throw new Error("Sync writeObject payload exceeds the size limit");
    }
    return extensionProviderService.writeSyncObject({
      ...payload,
      bytes: data instanceof Uint8Array ? data : new Uint8Array(data),
      preferStream: false,
    }, { signal });
  }));

  ipcMain.handle(CHANNELS.syncWriteBegin, async (event, payload) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted plugin management sender");
    if (!extensionProviderService) throw new Error("Plugin sync Providers are unavailable");
    const requestId = payload?.requestId;
    const controller = registerStreamingWriteRequest(event, requestId);
    const failBegin = (error) => {
      controller.abort();
      extensionRequestMap(event.sender).delete(requestId);
      throw error;
    };
    const byteLength = payload?.byteLength;
    if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_SYNC_OBJECT_BYTES) {
      failBegin(new TypeError("Sync writeObject byteLength is invalid"));
    }
    const providerId = payload?.providerId;
    const key = payload?.key;
    if (typeof providerId !== "string" || providerId.length < 1) {
      failBegin(new TypeError("Sync writeObject provider ID is invalid"));
    }
    if (typeof key !== "string" || key.length < 1) {
      failBegin(new TypeError("Sync writeObject key is invalid"));
    }
    const transfers = syncTransferMap(event.sender);
    try {
      assertSyncTransferBudget(transfers);
    } catch (error) {
      failBegin(error);
    }
    const transferId = randomUUID();
    const transfer = {
      kind: "write",
      sender: event.sender,
      requestId,
      controller,
      providerId,
      key,
      expectedRevision: payload?.expectedRevision,
      deadlineMs: payload?.deadlineMs,
      byteLength,
      received: 0,
      sequence: -1,
      chunks: [],
      signal: controller.signal,
      expiresAt: Date.now() + SYNC_TRANSFER_TTL_MS,
    };
    transfers.set(transferId, transfer);
    const onAbort = () => releaseSyncTransfer(event.sender, transferId, transfer);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    transfer.onAbort = onAbort;
    return { transferId, windowBytes: STREAM_WINDOW_BYTES };
  });

  ipcMain.handle(CHANNELS.syncWriteChunk, async (event, payload) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted plugin management sender");
    const transferId = payload?.transferId;
    if (typeof transferId !== "string" || transferId.length < 1) {
      throw new TypeError("Sync write transfer ID is invalid");
    }
    const transfers = syncTransferMap(event.sender);
    const transfer = transfers.get(transferId);
    if (!transfer || transfer.kind !== "write") {
      throw new Error("Sync write transfer is not owned by this window");
    }
    const failChunk = (error) => {
      try { transfer.controller?.abort(); } catch { /* ignore */ }
      releaseSyncTransfer(event.sender, transferId, transfer);
      throw error;
    };
    if (payload?.requestId !== transfer.requestId) {
      failChunk(new Error("Sync write transfer request ID mismatch"));
    }
    if (transfer.signal.aborted) {
      failChunk(new DOMException("Aborted", "AbortError"));
    }
    const sequence = payload?.sequence;
    if (!Number.isSafeInteger(sequence) || sequence !== transfer.sequence + 1) {
      failChunk(new TypeError("Sync write chunk sequence is invalid"));
    }
    let chunk;
    try {
      chunk = coerceIpcBytes(payload?.chunk, "Sync write chunk");
    } catch (error) {
      failChunk(error);
    }
    if (chunk.byteLength < 1 || chunk.byteLength > STREAM_WINDOW_BYTES) {
      failChunk(new TypeError("Sync write chunk size is invalid"));
    }
    if (transfer.received + chunk.byteLength > transfer.byteLength) {
      failChunk(new Error("Sync write exceeded declared byteLength"));
    }
    transfer.chunks.push(Buffer.from(chunk));
    transfer.received += chunk.byteLength;
    transfer.sequence = sequence;
    transfer.expiresAt = Date.now() + SYNC_TRANSFER_TTL_MS;
    return { accepted: chunk.byteLength };
  });

  ipcMain.handle(CHANNELS.syncWriteCommit, async (event, payload) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted plugin management sender");
    if (!extensionProviderService) throw new Error("Plugin sync Providers are unavailable");
    const transferId = payload?.transferId;
    if (typeof transferId !== "string" || transferId.length < 1) {
      throw new TypeError("Sync write transfer ID is invalid");
    }
    const transfers = syncTransferMap(event.sender);
    const transfer = transfers.get(transferId);
    if (!transfer || transfer.kind !== "write") {
      throw new Error("Sync write transfer is not owned by this window");
    }
    const failCommit = (error) => {
      try { transfer.controller?.abort(); } catch { /* ignore */ }
      releaseSyncTransfer(event.sender, transferId, transfer);
      throw error;
    };
    if (payload?.requestId !== transfer.requestId) {
      failCommit(new Error("Sync write transfer request ID mismatch"));
    }
    if (transfer.received !== transfer.byteLength) {
      failCommit(new Error("Sync write commit size does not match byteLength"));
    }
    const bytes = Buffer.concat(transfer.chunks);
    transfers.delete(transferId);
    try {
      if (transfer.signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      await raceWithAbort(resolveManager(), transfer.signal);
      return await extensionProviderService.writeSyncObject({
        providerId: transfer.providerId,
        key: transfer.key,
        bytes: new Uint8Array(bytes),
        expectedRevision: transfer.expectedRevision,
        preferStream: true,
        deadlineMs: transfer.deadlineMs,
      }, { signal: transfer.signal });
    } catch (error) {
      throw error;
    } finally {
      if (extensionRequestMap(event.sender).get(transfer.requestId) === transfer.controller
        || extensionRequestMap(event.sender).has(transfer.requestId)) {
        extensionRequestMap(event.sender).delete(transfer.requestId);
      }
    }
  });

  ipcMain.handle(CHANNELS.syncPutSecret, async (event, payload) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted plugin management sender");
    if (!secretStore || typeof secretStore.set !== "function") {
      throw new Error("Plugin sync secret storage is unavailable");
    }
    if (!extensionProviderService) throw new Error("Plugin sync Providers are unavailable");
    const providerId = payload?.providerId;
    if (typeof providerId !== "string" || providerId.length < 1) {
      throw new TypeError("Sync provider ID is invalid");
    }
    const key = assertSecretKey(typeof payload?.key === "string" && payload.key
      ? payload.key
      : "sync-credential");
    const value = payload?.value;
    if (typeof value !== "string" || value.length < 1) {
      throw new TypeError("Sync secret value is invalid");
    }
    const providers = extensionProviderService.listProviders({ kind: "sync" });
    const match = Array.isArray(providers)
      ? providers.find((entry) => entry?.provider?.id === providerId || entry?.id === providerId)
      : null;
    if (!match || typeof match.pluginId !== "string") {
      throw new Error(`Plugin sync provider is unavailable: ${providerId}`);
    }
    const existing = typeof secretStore.getReference === "function"
      ? secretStore.getReference(match.pluginId, key)
      : null;
    const stored = typeof secretStore.set === "function"
      ? secretStore.set(match.pluginId, key, value, { stashPrevious: true })
      : null;
    if (!stored) {
      throw new Error("Plugin sync secret storage is unavailable");
    }
    // Remember which plugin owns this provider so disconnect can clean secrets
    // after the contribution is gone (disabled/uninstalled).
    if (typeof secretStore.bindSyncProviderPlugin === "function") {
      try {
        secretStore.bindSyncProviderPlugin(match.pluginId, providerId);
      } catch {
        /* binding is best-effort; credential write already succeeded */
      }
    }
    return Object.freeze({ ...stored, created: !existing });
  });

  ipcMain.handle(CHANNELS.syncDeleteSecrets, async (event, payload) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted plugin management sender");
    if (!secretStore || typeof secretStore.delete !== "function") {
      throw new Error("Plugin sync secret storage is unavailable");
    }
    if (!extensionProviderService) throw new Error("Plugin sync Providers are unavailable");
    // Wait for package recovery + binding seed before resolving ownership so a
    // schema-2 disconnect during startup cannot miss retained bindings (Codex P2).
    try {
      await resolveManager();
    } catch {
      // Runtime disabled: continue with whatever secretStore already has.
    }
    const providerId = payload?.providerId;
    if (typeof providerId !== "string" || providerId.length < 1) {
      throw new TypeError("Sync provider ID is invalid");
    }
    const providers = extensionProviderService.listProviders({ kind: "sync" });
    const match = Array.isArray(providers)
      ? providers.find((entry) => entry?.provider?.id === providerId || entry?.id === providerId)
      : null;
    let pluginId = match && typeof match.pluginId === "string" ? match.pluginId : null;
    if (!pluginId && typeof secretStore.resolveSyncProviderPlugin === "function") {
      pluginId = secretStore.resolveSyncProviderPlugin(providerId) ?? null;
    }
    if (!pluginId) {
      // No live contribution and no retained binding — nothing to delete.
      return { deleted: 0 };
    }
    const keys = Array.isArray(payload?.keys) && payload.keys.length > 0
      ? payload.keys
      : null;
    if (!keys) {
      // Wipe every sync-credential* key (well-known + schema writeOnly fields).
      let deleted = 0;
      if (typeof secretStore.deleteByKeyPrefix === "function") {
        deleted = Number(secretStore.deleteByKeyPrefix(pluginId, "sync-credential")) || 0;
      }
      if (typeof secretStore.unbindSyncProviderPlugin === "function") {
        secretStore.unbindSyncProviderPlugin(pluginId, providerId);
      }
      return { deleted };
    }
    let deleted = 0;
    for (const rawKey of keys ?? [
      "sync-credential",
      "sync-credential:token",
      "sync-credential:secret",
      "sync-credential:apiKey",
      "sync-credential:accessToken",
    ]) {
      if (typeof rawKey !== "string" || rawKey.length < 1) continue;
      const key = assertSecretKey(rawKey);
      try {
        secretStore.delete(pluginId, key);
        deleted += 1;
      } catch {
        /* ignore missing / unavailable keys */
      }
    }
    return { deleted };
  });

  ipcMain.handle(CHANNELS.syncRestoreSecrets, async (event, payload) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted plugin management sender");
    if (!secretStore) {
      throw new Error("Plugin sync secret restore is unavailable");
    }
    if (!extensionProviderService) throw new Error("Plugin sync Providers are unavailable");
    const providerId = payload?.providerId;
    if (typeof providerId !== "string" || providerId.length < 1) {
      throw new TypeError("Sync provider ID is invalid");
    }
    const keys = Array.isArray(payload?.keys) ? payload.keys : [];
    if (keys.length < 1) return { restored: 0, discarded: 0 };
    const providers = extensionProviderService.listProviders({ kind: "sync" });
    const match = Array.isArray(providers)
      ? providers.find((entry) => entry?.provider?.id === providerId || entry?.id === providerId)
      : null;
    let pluginId = match && typeof match.pluginId === "string" ? match.pluginId : null;
    if (!pluginId && typeof secretStore.resolveSyncProviderPlugin === "function") {
      pluginId = secretStore.resolveSyncProviderPlugin(providerId) ?? null;
    }
    if (!pluginId) return { restored: 0, discarded: 0 };
    const discard = payload?.discard === true;
    let restored = 0;
    let discarded = 0;
    for (const rawKey of keys) {
      if (typeof rawKey !== "string" || rawKey.length < 1) continue;
      const key = assertSecretKey(rawKey);
      try {
        if (discard) {
          if (typeof secretStore.clearOverwriteStash === "function") {
            secretStore.clearOverwriteStash(pluginId, key);
            discarded += 1;
          }
        } else if (typeof secretStore.restoreOverwrite === "function"
          && secretStore.restoreOverwrite(pluginId, key)) {
          restored += 1;
        }
      } catch {
        /* best-effort restore/discard */
      }
    }
    return { restored, discarded };
  });

  handlePassive(CHANNELS.credentialCatalogUpdate, 0, async (_activeManager, payload) => {
    if (!credentialResolver || typeof credentialResolver.update !== "function") {
      throw new Error("Plugin Vault credential catalog is unavailable");
    }
    return credentialResolver.update(payload?.entries);
  });
  ipcMain.handle(CHANNELS.extensionInvoke, async (event, payload) => runExtensionRequest(event, payload, async (signal) => {
    if (!extensionProviderService) throw new Error("Plugin extension Providers are unavailable");
    if ((payload?.kind === "connection"
        && payload?.operation !== "validateConfiguration"
        && payload?.operation !== "probe")
      || payload?.kind === "authentication"
      || (payload?.kind === "importer" && payload?.operation === "parse")) {
      throw new TypeError("Stateful Provider operations require their dedicated host workflow");
    }
    return extensionProviderService.invoke(payload ?? {}, { signal });
  }));
  ipcMain.handle(CHANNELS.extensionCancel, async (event, payload) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted plugin management sender");
    const requestId = payload?.requestId;
    if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 128) {
      throw new TypeError("Plugin extension request ID is invalid");
    }
    const controller = extensionRequestMap(event.sender).get(requestId);
    controller?.abort();
    return controller != null;
  });
  ipcMain.handle(CHANNELS.connectionStart, async (event, payload) => runExtensionRequest(event, payload, async (signal) => {
    if (!extensionProviderService) throw new Error("Plugin connection Providers are unavailable");
    const terminalWorkerManager = getTerminalWorkerManager();
    if (!terminalWorkerManager?.startExternalSession) {
      throw new Error("Host terminal pipeline is unavailable for plugin connections");
    }
    const sessions = connectionSessionMap(event.sender);
    const monitors = connectionMonitorMap(event.sender);
    const sessionId = payload?.sessionId;
    const sessionOwner = Symbol(`plugin-connection:${sessionId}`);
    const outputDecoder = new TextDecoder("utf-8");
    let credential = payload?.credential;
    let closedDuringStart = false;
    let providerOpened = false;
    let providerCloseStarted = false;
    let acceptProviderOutput = true;
    const connectionController = new AbortController();
    const abortConnection = () => connectionController.abort(
      signal.reason ?? new DOMException("Plugin connection request was cancelled", "AbortError"),
    );
    if (signal.aborted) abortConnection();
    else signal.addEventListener("abort", abortConnection, { once: true });
    try {
      if (connectionController.signal.aborted) throw connectionController.signal.reason;
      await terminalWorkerManager.startExternalSession({
        sessionId,
        ownerToken: sessionOwner,
        webContentsId: event.sender.id,
        columns: payload?.columns,
        rows: payload?.rows,
        protocol: payload?.protocol,
        hostLabel: payload?.hostLabel,
        hostname: payload?.hostname,
        sessionLog: payload?.sessionLog,
        onInput: (data) => (providerOpened
          ? extensionProviderService.write(sessionId, data, sessionOwner)
          : undefined),
        onResize: ({ columns, rows }) => extensionProviderService.control(
          sessionId,
          "resize",
          { columns, rows },
          { sessionOwner },
        ),
        onClose: async () => {
          acceptProviderOutput = false;
          if (sessions.get(sessionId) === sessionOwner) sessions.delete(sessionId);
          if (monitors.get(sessionId)?.sessionOwner === sessionOwner) monitors.delete(sessionId);
          connectionController.abort(new DOMException("Terminal session closed", "AbortError"));
          providerCloseStarted = true;
          if (providerOpened) {
            try { await extensionProviderService.control(sessionId, "close", {}, { sessionOwner }); }
            catch { extensionProviderService.closeSessionLocal(sessionId, undefined, sessionOwner); }
          } else {
            extensionProviderService.closeSessionLocal(sessionId, undefined, sessionOwner);
          }
        },
      });
      if (payload?.authenticationProviderId) {
        const authentication = await extensionProviderService.authenticate({
          providerId: payload.authenticationProviderId,
          connectionProviderId: payload?.providerId,
          configuration: payload?.configuration,
          ...(credential === undefined ? {} : { credential }),
        }, (challenge) => requestAuthenticationChallenge(
          event,
          payload.requestId,
          challenge,
          connectionController.signal,
        ), { signal: connectionController.signal });
        if (authentication.status !== "authenticated") {
          throw new Error(authentication.message || "Plugin authentication did not complete");
        }
        credential = authentication.credential;
      }
      const opened = await extensionProviderService.openConnection({
        ...payload,
        ...(credential === undefined ? {} : { credential }),
      }, {
        signal: connectionController.signal,
        sessionOwner,
        onData: async (bytes) => {
          if (!acceptProviderOutput || (providerOpened && sessions.get(sessionId) !== sessionOwner)) return;
          const data = outputDecoder.decode(bytes, { stream: true });
          if (!data) return;
          try {
            await terminalWorkerManager.pushExternalOutput(sessionId, data, undefined, sessionOwner);
          } catch (error) {
            if (!acceptProviderOutput
              || connectionController.signal.aborted
              || (providerOpened && sessions.get(sessionId) !== sessionOwner)) return;
            throw error;
          }
        },
        onOutputClose: async (reason) => {
          const shouldFlushOutput = acceptProviderOutput
            && !connectionController.signal.aborted
            && (!providerOpened || sessions.get(sessionId) === sessionOwner);
          acceptProviderOutput = false;
          closedDuringStart = true;
          if (sessions.get(sessionId) === sessionOwner) sessions.delete(sessionId);
          if (monitors.get(sessionId)?.sessionOwner === sessionOwner) monitors.delete(sessionId);
          connectionController.abort(new DOMException("Plugin connection output closed", "AbortError"));
          const finalData = outputDecoder.decode();
          let finalOutputError;
          if (shouldFlushOutput && finalData) {
            try { await terminalWorkerManager.pushExternalOutput(sessionId, finalData, undefined, sessionOwner); }
            catch (error) { finalOutputError = error; }
          }
          await terminalWorkerManager.finishExternalSession(
            sessionId,
            finalOutputError
              ? { reason: "error", error: boundedErrorMessage(finalOutputError, "Plugin connection final output failed") }
              : connectionOutputCloseDetails(reason),
            sessionOwner,
          );
        },
      });
      providerOpened = true;
      if (!closedDuringStart) {
        sessions.set(opened.sessionId, sessionOwner);
        monitors.set(opened.sessionId, { sessionOwner, controller: connectionController });
        if (opened.status === "connected") {
          // The terminal renderer treats the first delivery as the connection
          // readiness boundary. Preserve that boundary for silent protocols
          // whose Provider completes open before producing terminal bytes.
          await terminalWorkerManager.pushExternalOutput(
            opened.sessionId,
            "",
            pluginConnectionReadyMeta,
            sessionOwner,
          );
        }
        void monitorPluginConnection({
          sessionId: opened.sessionId,
          sessionOwner,
          sessions,
          monitors,
          controller: connectionController,
          terminalWorkerManager,
          readyPublished: opened.status === "connected",
        });
      }
      return opened;
    } catch (error) {
      acceptProviderOutput = false;
      if (sessions.get(sessionId) === sessionOwner) sessions.delete(sessionId);
      if (monitors.get(sessionId)?.sessionOwner === sessionOwner) monitors.delete(sessionId);
      connectionController.abort(error);
      if (!providerCloseStarted && providerOpened) {
        try { await extensionProviderService.control(sessionId, "close", {}, { sessionOwner }); }
        catch { extensionProviderService.closeSessionLocal(sessionId, undefined, sessionOwner); }
      } else if (!providerCloseStarted && !closedDuringStart) {
        extensionProviderService.closeSessionLocal(sessionId, undefined, sessionOwner);
      }
      await terminalWorkerManager.finishExternalSession(sessionId, {
        reason: "error",
        error: boundedErrorMessage(error),
      }, sessionOwner);
      throw error;
    } finally {
      signal.removeEventListener("abort", abortConnection);
    }
  }));
  ipcMain.handle(CHANNELS.authenticationRespond, async (event, payload) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted plugin management sender");
    const challengeRequestId = payload?.challengeRequestId;
    if (typeof challengeRequestId !== "string" || challengeRequestId.length < 1 || challengeRequestId.length > 128) {
      throw new TypeError("Plugin authentication challenge request ID is invalid");
    }
    const challenges = authenticationChallengeMap(event.sender);
    const pending = challenges.get(challengeRequestId);
    if (!pending
      || pending.requestId !== payload?.requestId
      || pending.challengeId !== payload?.challengeId) {
      throw new Error("Plugin authentication challenge is not owned by this window");
    }
    challenges.delete(challengeRequestId);
    if (payload?.cancelled === true) pending.reject(new DOMException("Cancelled", "AbortError"));
    else pending.resolve(payload?.response);
    return null;
  });
  handle(CHANNELS.connectionWrite, async (_activeManager, payload, event) => {
    if (!extensionProviderService) throw new Error("Plugin connection Providers are unavailable");
    const sessions = connectionSessionMap(event.sender);
    const sessionOwner = sessions.get(payload?.sessionId);
    if (sessionOwner === undefined) throw new Error("Plugin connection session is not owned by this window");
    await extensionProviderService.write(payload.sessionId, payload.data, sessionOwner);
    return null;
  });
  handle(CHANNELS.connectionControl, async (_activeManager, payload, event) => {
    if (!extensionProviderService) throw new Error("Plugin connection Providers are unavailable");
    const sessions = connectionSessionMap(event.sender);
    const monitors = connectionMonitorMap(event.sender);
    const terminalWorkerManager = getTerminalWorkerManager();
    const sessionOwner = sessions.get(payload?.sessionId);
    if (sessionOwner === undefined) throw new Error("Plugin connection session is not owned by this window");
    const isClose = payload.operation === "close";
    if (isClose) {
      if (sessions.get(payload.sessionId) === sessionOwner) sessions.delete(payload.sessionId);
      const monitor = monitors.get(payload.sessionId);
      if (monitor?.sessionOwner === sessionOwner) {
        monitors.delete(payload.sessionId);
        monitor.controller.abort(new DOMException("Plugin connection closed", "AbortError"));
      }
    }
    const controlResult = Promise.resolve(extensionProviderService.control(
      payload.sessionId,
      payload.operation,
      payload.payload ?? {},
      { sessionOwner },
    ));
    if (!isClose) return controlResult;
    const settledControl = controlResult.then(
      (value) => ({ status: "fulfilled", value }),
      (reason) => ({ status: "rejected", reason }),
    );
    try {
      await terminalWorkerManager?.finishExternalSession?.(
        payload.sessionId,
        { reason: "closed" },
        sessionOwner,
      );
    } catch {}
    const outcome = await settledControl;
    if (outcome.status === "rejected") throw outcome.reason;
    return outcome.value;
  });
  ipcMain.handle(CHANNELS.importerDetect, async (event, payload) => runExtensionRequest(event, payload, async (signal) => {
    if (!extensionProviderService) throw new Error("Plugin importer Providers are unavailable");
    return extensionProviderService.detectImporter({ ...payload, sample: payload?.sample }, { signal });
  }));
  handle(CHANNELS.importerSelectFile, async (_activeManager, _payload, event) => {
    if (typeof selectImporterFile !== "function") throw new Error("Plugin importer file selection is unavailable");
    const filePath = await selectImporterFile(event);
    if (!filePath) return null;
    const handle = await fs.open(filePath, "r");
    let retained = false;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_IMPORT_FILE_BYTES) {
        throw new TypeError("Plugin importer file is not a supported regular file");
      }
      const sample = Buffer.allocUnsafe(Math.min(stat.size, 128 * 1024));
      const { bytesRead } = await handle.read(sample, 0, sample.byteLength, 0);
      if (bytesRead !== sample.byteLength) throw new Error("Plugin importer file changed while sampling");
      const selections = importerSelectionMap(event.sender);
      if (selections.size >= MAX_IMPORT_SELECTIONS_PER_SENDER) {
        throw new Error("Too many pending Plugin importer file selections");
      }
      const selectionToken = randomUUID();
      selections.set(selectionToken, {
        handle,
        filePath,
        fileName: filePath.split(/[\\/]/u).at(-1) || "import",
        size: stat.size,
        dev: stat.dev,
        ino: stat.ino,
        mtimeMs: stat.mtimeMs,
        expiresAt: Date.now() + IMPORT_SELECTION_TTL_MS,
      });
      retained = true;
      return { selectionToken, fileName: selections.get(selectionToken).fileName, sample: sample.subarray(0, bytesRead) };
    } finally {
      if (!retained) await handle.close();
    }
  });
  handle(CHANNELS.importerReleaseFile, async (_activeManager, payload, event) => {
    const selectionToken = payload?.selectionToken;
    if (typeof selectionToken !== "string" || selectionToken.length < 1 || selectionToken.length > 128) {
      throw new TypeError("Plugin importer selection token is invalid");
    }
    const selections = importerSelectionMap(event.sender);
    const selection = selections.get(selectionToken);
    const deleted = selections.delete(selectionToken);
    closeImporterSelection(selection);
    return deleted;
  });
  ipcMain.handle(CHANNELS.importerParseFile, async (event, payload) => runExtensionRequest(event, payload, async (signal) => {
    if (!extensionProviderService) throw new Error("Plugin importer Providers are unavailable");
    const selectionToken = payload?.selectionToken;
    if (typeof selectionToken !== "string" || selectionToken.length < 1 || selectionToken.length > 128) {
      throw new TypeError("Plugin importer selection token is invalid");
    }
    const selections = importerSelectionMap(event.sender);
    const selection = selections.get(selectionToken);
    selections.delete(selectionToken);
    if (!selection || selection.expiresAt <= Date.now()) throw new Error("Plugin importer file selection expired");
    const handle = selection.handle;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== selection.size || stat.dev !== selection.dev
        || stat.ino !== selection.ino || stat.mtimeMs !== selection.mtimeMs) {
        throw new Error("Plugin importer file changed after selection");
      }
      return await extensionProviderService.parseImporter({
        ...payload,
        fileName: selection.fileName,
        source: handle.createReadStream({ autoClose: false, signal, start: 0 }),
        sourceByteLength: stat.size,
      }, {
        signal,
        onProgress: (progress) => {
          if (!event.sender.isDestroyed?.()) {
            event.sender.send(CHANNELS.importerProgress, {
              requestId: payload.requestId,
              providerId: payload.providerId,
              progress,
            });
          }
        },
      });
    } finally {
      await handle.close();
    }
  }));
  handle(CHANNELS.hostDrawnOpen, async (_activeManager, payload, event) => {
    if (!hostDrawnViewHost) throw new Error("Host-drawn plugin views are unavailable");
    return hostDrawnViewHost.open(payload, event.sender);
  });
  handle(CHANNELS.hostDrawnClose, async (_activeManager, payload, event) => {
    if (!hostDrawnViewHost) throw new Error("Host-drawn plugin views are unavailable");
    await hostDrawnViewHost.close(payload?.instanceId, event.sender); return null;
  });
  handle("netcatty:plugins:host-ui-resource", async (_activeManager, payload, event) => {
    if (!hostDrawnViewHost) throw new Error("Plugin views unavailable");
    if (!createDefinitionValidator("PluginViewResourceRequest")(payload)) throw new TypeError("Invalid plugin resource request");
    return hostDrawnViewHost.resource(payload.instanceId, payload.path, event.sender);
  });
  handle(CHANNELS.hostDrawnEvent, async (_activeManager, payload, event) => {
    if (!hostDrawnViewHost) throw new Error("Host-drawn plugin views are unavailable");
    await hostDrawnViewHost.event(payload?.instanceId, payload?.event, event.sender); return null;
  });
  handlePassive(CHANNELS.getScopeCatalog, () => currentScopeCatalog(), async () => currentScopeCatalog());
  handlePassive(CHANNELS.setScopeCatalog, null, async (_activeManager, payload, event) => {
    const key = scopeCatalogSenderKey(event);
    const scopeCatalog = normalizePluginScopeCatalog(payload);
    scopeCatalogs.set(key, scopeCatalog);
    scopeCatalogOwners.set(key, event?.sender);
    observeScopeCatalogSender(event, key);
    publishScopeCatalog(event);
    return null;
  });
  options.catalogService?.onDidChange?.((event) => options.broadcast?.(CHANNELS.catalogChanged, event));
  contributionService?.onDidChange?.((event) => options.broadcast?.(CHANNELS.contributionsChanged, event));

}

module.exports = {
  CHANNELS,
  createTrustedPluginBridgeSender,
  mergePluginScopeCatalogs,
  normalizePluginScopeCatalog,
  registerPluginBridge,
};
