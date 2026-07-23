"use strict";

const { isPluginDevelopmentEnabled } = require("./constants.cjs");
const { raceWithAbort } = require("./rpcRouter.cjs");

const CHANNELS = Object.freeze({
  status: "netcatty:plugins:status",
  list: "netcatty:plugins:list",
  install: "netcatty:plugins:install",
  setEnabled: "netcatty:plugins:set-enabled",
  restart: "netcatty:plugins:restart",
  uninstall: "netcatty:plugins:uninstall",
  contributions: "netcatty:plugins:contributions",
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
  openView: "netcatty:plugins:open-view",
  closeView: "netcatty:plugins:close-view",
  setViewBounds: "netcatty:plugins:set-view-bounds",
  setViewVisibility: "netcatty:plugins:set-view-visibility",
  viewMessage: "netcatty:plugins:view-message",
  viewMessagePosted: "netcatty:plugins:view-message-posted",
  viewClosed: "netcatty:plugins:view-closed",
  getScopeCatalog: "netcatty:plugins:get-scope-catalog",
  setScopeCatalog: "netcatty:plugins:set-scope-catalog",
  scopeCatalogChanged: "netcatty:plugins:scope-catalog-changed",
});

const SCOPE_KINDS = Object.freeze(["workspace", "host", "session", "device"]);
const MAX_ACTIVE_TERMINAL_REQUESTS_PER_SENDER = 64;

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
  const viewHost = options.viewHost;
  const env = options.env ?? process.env;
  const isTrustedSender = options.isTrustedSender;
  const defaultScopeCatalog = normalizePluginScopeCatalog({ device: [{ id: "device", label: "This device" }] });
  const scopeCatalogs = new Map();
  const scopeCatalogOwners = new Map();
  const observedScopeCatalogSenders = new WeakSet();
  const terminalRequestsBySender = new WeakMap();
  const observedTerminalRequestSenders = new WeakSet();
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
  const configured = isPluginDevelopmentEnabled(env)
    && Boolean(manager)
    && typeof manager.initialize === "function";
  const resolveManager = async () => {
    if (!configured) throw new Error("Plugin development runtime is disabled or unavailable");
    try {
      await manager.initialize();
    } catch (cause) {
      throw new Error("Plugin development runtime is disabled or unavailable", { cause });
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
  ipcMain.handle(CHANNELS.status, async (event) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted plugin management sender");
    let available = false;
    try {
      await resolveManager();
      available = true;
    } catch {}
    return { available, experimental: true };
  });
  handle(CHANNELS.list, async (activeManager) => activeManager.list());
  handle(CHANNELS.install, async (activeManager, payload) => activeManager.install(
    payload?.archivePath,
    { enable: payload?.enable === true },
  ));
  handle(CHANNELS.setEnabled, async (activeManager, payload) => activeManager.setEnabled(
    payload?.pluginId,
    payload?.enabled === true,
  ));
  handle(CHANNELS.restart, async (activeManager, payload) => activeManager.restart(payload?.pluginId));
  handle(CHANNELS.uninstall, async (activeManager, payload) => activeManager.uninstall(payload?.pluginId));
  handle(CHANNELS.contributions, async (_activeManager, payload) => {
    if (!contributionService) throw new Error("Plugin contributions are unavailable");
    return contributionService.snapshot(payload ?? {});
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
    viewHost?.setEnvironment?.(payload ?? {});
    return null;
  });
  handle(CHANNELS.terminalProviders, async (_activeManager, payload) => {
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
  handle(CHANNELS.terminalSessionEvent, async (_activeManager, payload, event) => {
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
  handle(CHANNELS.openView, async (_activeManager, payload, event) => {
    if (!viewHost) throw new Error("Plugin views are unavailable");
    return viewHost.open(payload, event.sender);
  });
  handle(CHANNELS.closeView, async (_activeManager, payload, event) => {
    if (!viewHost) throw new Error("Plugin views are unavailable");
    await viewHost.close(payload?.instanceId, event.sender);
    return null;
  });
  handle(CHANNELS.setViewBounds, async (_activeManager, payload, event) => {
    if (!viewHost) throw new Error("Plugin views are unavailable");
    viewHost.setBounds(payload?.instanceId, payload?.bounds, event.sender);
    return null;
  });
  handle(CHANNELS.setViewVisibility, async (_activeManager, payload, event) => {
    if (!viewHost) throw new Error("Plugin views are unavailable");
    viewHost.setVisible(payload?.instanceId, payload?.visible, event.sender);
    return null;
  });
  handle(CHANNELS.viewMessage, async (_activeManager, payload, event) => {
    if (!viewHost) throw new Error("Plugin views are unavailable");
    await viewHost.postMessage(payload?.instanceId, payload?.message, event.sender);
    return null;
  });
  handle(CHANNELS.getScopeCatalog, async () => currentScopeCatalog());
  handle(CHANNELS.setScopeCatalog, async (_activeManager, payload, event) => {
    const key = scopeCatalogSenderKey(event);
    const scopeCatalog = normalizePluginScopeCatalog(payload);
    scopeCatalogs.set(key, scopeCatalog);
    scopeCatalogOwners.set(key, event?.sender);
    observeScopeCatalogSender(event, key);
    publishScopeCatalog(event);
    return null;
  });
  contributionService?.onDidChange?.((event) => options.broadcast?.(CHANNELS.contributionsChanged, event));
  contributionService?.onDidPostViewMessage?.((event) => options.broadcast?.(CHANNELS.viewMessagePosted, event));
  viewHost?.onDidClose?.((event) => options.broadcast?.(CHANNELS.viewClosed, event));
}

module.exports = {
  CHANNELS,
  createTrustedPluginBridgeSender,
  mergePluginScopeCatalogs,
  normalizePluginScopeCatalog,
  registerPluginBridge,
};
