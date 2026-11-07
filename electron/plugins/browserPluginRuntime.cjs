"use strict";

const { randomUUID } = require("node:crypto");
const path = require("node:path");

const {
  PLUGIN_ACTIVATION_TIMEOUT_MS,
  PLUGIN_DEACTIVATION_TIMEOUT_MS,
  PLUGIN_PROTOCOL_SCHEME,
} = require("./constants.cjs");
const { PluginRpcRouter } = require("./rpcRouter.cjs");

function encodePackagePath(packagePath) {
  return packagePath.split("/").map(encodeURIComponent).join("/");
}

function waitForLoad(webContents) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      webContents.removeListener("did-finish-load", loaded);
      webContents.removeListener("did-fail-load", failed);
    };
    const loaded = () => { cleanup(); resolve(); };
    const failed = (_event, code, description) => {
      cleanup();
      reject(new Error(`Plugin browser failed to load (${code}): ${description}`));
    };
    webContents.once("did-finish-load", loaded);
    webContents.once("did-fail-load", failed);
  });
}

function normalizeConsoleLevel(level) {
  if (level === "error" || (typeof level === "number" && level >= 3)) return "error";
  if (level === "warning" || level === "warn" || level === 2) return "warn";
  if (level === "debug" || level === 0) return "debug";
  return "info";
}

function sanitizePluginSource(source) {
  try { return new URL(String(source)).pathname.slice(0, 512); }
  catch { return "[plugin resource]"; }
}

class BrowserPluginRuntime {
  constructor(options) {
    this.electron = options.electron;
    this.protocol = options.protocol;
    this.plugin = options.plugin;
    this.packageRoot = options.packageRoot;
    this.preloadPath = options.preloadPath;
    this.requestHandlers = options.requestHandlers ?? options.handlers;
    this.notificationHandlers = options.notificationHandlers ?? options.handlers;
    this.onIncomingStream = options.onIncomingStream;
    this.onBeforeMessage = options.onBeforeMessage;
    this.onProgress = options.onProgress;
    this.onProcessReady = options.onProcessReady ?? (() => {});
    this.logger = options.logger ?? { write() {} };
    this.onExit = options.onExit ?? (() => {});
    this.onProtocolError = options.onProtocolError ?? (() => {});
    this.window = null;
    this.router = null;
    this.registration = null;
    this.sessionRegistration = null;
    this.port = null;
    this.stopping = false;
  }

  #assertStarting(signal) {
    signal?.throwIfAborted();
    if (this.stopping) throw new Error("Plugin browser runtime startup was stopped");
  }

  async start(runtimeConfig, options = {}) {
    const { signal, getActivationEnvironment } = options;
    this.#assertStarting(signal);
    const { BrowserWindow, MessageChannelMain, session } = this.electron;
    if (!BrowserWindow || !MessageChannelMain || !session?.fromPartition) {
      throw new Error("Electron browser plugin runtime is unavailable");
    }
    const partition = `netcatty-plugin-${randomUUID()}`;
    const pluginSession = session.fromPartition(partition, { cache: false });
    const config = { ...runtimeConfig };
    this.registration = this.protocol.registerRuntime({
      pluginId: this.plugin.id,
      packageRoot: this.packageRoot,
      config,
    });
    config.entryUrl = `${PLUGIN_PROTOCOL_SCHEME}://${this.registration.token}/package/${encodePackagePath(
      this.plugin.manifest.main.browser,
    )}`;
    this.sessionRegistration = this.protocol.registerSession(pluginSession);
    await pluginSession.setProxy({
      mode: "fixed_servers",
      proxyRules: "http=127.0.0.1:9;https=127.0.0.1:9;socks=127.0.0.1:9",
      proxyBypassRules: "<-loopback>",
    });
    this.#assertStarting(signal);
    pluginSession.enableNetworkEmulation({ offline: true });
    pluginSession.on("will-download", (event) => event.preventDefault());
    pluginSession.setPermissionCheckHandler?.(() => false);
    pluginSession.setPermissionRequestHandler?.((_webContents, _permission, callback) => callback(false));
    pluginSession.setDevicePermissionHandler?.(() => false);
    pluginSession.webRequest.onBeforeRequest((details, callback) => {
      try {
        const url = new URL(details.url);
        const cancel = url.protocol !== `${PLUGIN_PROTOCOL_SCHEME}:` || url.hostname !== this.registration.token;
        callback({ cancel });
      } catch {
        callback({ cancel: true });
      }
    });
    pluginSession.webRequest.onErrorOccurred((details) => {
      let requestPath = "unknown";
      try { requestPath = new URL(details.url).pathname.slice(0, 1_024); } catch {}
      void this.logger.write("error", "Plugin browser resource failed", {
        error: details.error,
        requestPath,
        resourceType: details.resourceType,
      });
    });
    pluginSession.webRequest.onCompleted((details) => {
      if (details.statusCode < 400) return;
      let requestPath = "unknown";
      try { requestPath = new URL(details.url).pathname.slice(0, 1_024); } catch {}
      void this.logger.write("error", "Plugin browser resource returned an error", {
        requestPath,
        resourceType: details.resourceType,
        statusCode: details.statusCode,
      });
    });
    this.window = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      paintWhenInitiallyHidden: false,
      webPreferences: {
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        webSecurity: true,
        javascript: true,
        images: false,
        webgl: false,
        plugins: false,
        devTools: false,
        disableDialogs: true,
        safeDialogs: true,
        navigateOnDragDrop: false,
        backgroundThrottling: false,
        spellcheck: false,
        session: pluginSession,
        preload: this.preloadPath,
      },
    });
    this.onProcessReady();
    const contents = this.window.webContents;
    contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    contents.on("console-message", (details) => {
      const resolvedMessage = details?.message ?? "Plugin renderer console message";
      const resolvedLevel = details?.level ?? "info";
      const logLevel = normalizeConsoleLevel(resolvedLevel);
      void this.logger.write(logLevel, resolvedMessage, {
        line: details?.lineNumber ?? 0,
        source: sanitizePluginSource(details?.sourceId ?? ""),
      });
    });
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, url) => {
      if (url !== this.registration.url) event.preventDefault();
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on("render-process-gone", (_event, details) => {
      this.#handleExit(new Error(`Plugin renderer exited: ${details.reason}`));
    });
    this.window.on("closed", () => this.#handleExit(new Error("Plugin renderer closed")));
    const { port1, port2 } = new MessageChannelMain();
    this.port = port1;
    this.router = new PluginRpcRouter({
      pluginId: this.plugin.id,
      send: (message, transfer = []) => port1.postMessage(message, transfer),
      requestHandlers: this.requestHandlers,
      notificationHandlers: this.notificationHandlers,
      onBeforeMessage: this.onBeforeMessage,
      onIncomingStream: this.onIncomingStream,
      onProgress: this.onProgress,
      onProtocolError: (error) => {
        this.onProtocolError(error);
        this.#handleExit(error);
      },
    });
    port1.on("message", (event) => this.router?.accept(event.data));
    port1.on("close", () => this.#handleExit(new Error("Plugin message port closed")));
    port1.start();
    let resolvePreloadReady;
    const preloadReady = new Promise((resolve) => { resolvePreloadReady = resolve; });
    let resolveRuntimeConnected;
    const runtimeConnected = new Promise((resolve) => { resolveRuntimeConnected = resolve; });
    const onPreloadMessage = (_event, channel) => {
      if (channel === "netcatty-plugin:preload-ready") {
        void this.logger.write("debug", "Plugin browser preload ready");
        resolvePreloadReady();
      }
      if (channel === "netcatty-plugin:runtime-connected") {
        void this.logger.write("debug", "Plugin browser message port connected");
        resolveRuntimeConnected();
      }
    };
    contents.on("ipc-message", onPreloadMessage);
    const loading = contents.loadURL(this.registration.url);
    let preloadTimer;
    const preloadDeadline = new Promise((_, reject) => {
      preloadTimer = setTimeout(
        () => reject(new Error("Plugin browser preload did not become ready")),
        PLUGIN_ACTIVATION_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([
        preloadReady,
        preloadDeadline,
        loading.then(() => preloadReady),
      ]);
    } finally {
      clearTimeout(preloadTimer);
    }
    this.#assertStarting(signal);
    contents.postMessage("netcatty-plugin:connect", null, [port2]);
    let connectionTimer;
    const connectionDeadline = new Promise((_, reject) => {
      connectionTimer = setTimeout(
        () => reject(new Error("Plugin browser runtime did not accept its message port")),
        PLUGIN_ACTIVATION_TIMEOUT_MS,
      );
    });
    try {
      await Promise.all([
        loading,
        Promise.race([runtimeConnected, connectionDeadline]),
      ]);
    } finally {
      clearTimeout(connectionTimer);
      contents.removeListener("ipc-message", onPreloadMessage);
    }
    this.#assertStarting(signal);
    const initialized = await this.router.request("plugin.initialize", {
      netcattyVersion: config.netcattyVersion,
      apiVersion: config.apiVersion,
      supportedFeatures: config.supportedFeatures,
    }, { timeoutMs: PLUGIN_ACTIVATION_TIMEOUT_MS });
    this.#assertStarting(signal);
    const activationEnvironment = typeof getActivationEnvironment === "function"
      ? getActivationEnvironment()
      : config.environment;
    await this.router.request("plugin.activate", activationEnvironment == null
      ? {}
      : { environment: activationEnvironment }, { timeoutMs: PLUGIN_ACTIVATION_TIMEOUT_MS });
    this.#assertStarting(signal);
    return initialized;
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    try {
      await this.router?.request("plugin.deactivate", {}, {
        timeoutMs: PLUGIN_DEACTIVATION_TIMEOUT_MS,
      });
    } finally {
      const router = this.router;
      this.router = null;
      router?.close();
      this.port?.close();
      this.registration?.dispose();
      this.sessionRegistration?.dispose();
      if (this.window && !this.window.isDestroyed()) this.window.destroy();
    }
  }

  request(method, params, options) {
    if (!this.router) return Promise.reject(new Error("Plugin browser runtime is not connected"));
    return this.router.request(method, params, options);
  }

  notify(method, params) {
    if (!this.router) throw new Error("Plugin browser runtime is not connected");
    this.router.notify(method, params);
  }

  openStream(streamId, windowBytes, options) {
    if (!this.router) return Promise.reject(new Error("Plugin browser runtime is not connected"));
    return this.router.streams.openOutgoing(streamId, windowBytes, options);
  }

  getProcessId() {
    if (!this.window || this.window.isDestroyed()) return null;
    return this.window.webContents.getOSProcessId?.() ?? null;
  }

  #handleExit(error) {
    if (!this.router) return;
    const router = this.router;
    this.router = null;
    router.close(error);
    this.port?.close();
    this.registration?.dispose();
    this.sessionRegistration?.dispose();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    const expected = this.stopping;
    this.onExit({ expected, error });
  }
}

module.exports = {
  BrowserPluginRuntime,
  encodePackagePath,
  normalizeConsoleLevel,
  sanitizePluginSource,
  waitForLoad,
};
