"use strict";

const { randomUUID } = require("node:crypto");

const { PLUGIN_PROTOCOL_SCHEME } = require("./constants.cjs");

/**
 * Single-use standby pool of isolated, offline, sandboxed BrowserWindows for
 * ordinary browser plugins.
 *
 * Security invariants:
 * - Every standby window owns a unique in-memory session partition.
 * - `onBeforeRequest` cancels 100% of requests until claimed and bound to one
 *   runtime's unguessable `netcatty-plugin://` authority token.
 * - `will-navigate` denies every navigation until bound to one runtime URL.
 * - Claiming removes the window from the pool permanently (single-use; never
 *   returned to the pool or shared across plugins/restarts).
 * - App Lock and host shutdown immediately destroy any standby window.
 */
class BrowserRuntimePool {
  constructor(options) {
    this.electron = options.electron;
    this.protocol = options.protocol;
    this.preloadPath = options.preloadPath;
    this.isLocked = options.isLocked ?? (() => false);
    this.standby = null;
    this.warming = null;
    this.closed = false;
    this.replenishTimer = null;
    this.unsubscribeLock = options.subscribeLock?.((state) => {
      if (state?.locked) this.clear();
    });
  }

  #canWarm() {
    if (this.closed || this.isLocked()) return false;
    const { BrowserWindow, session } = this.electron ?? {};
    return Boolean(BrowserWindow && session?.fromPartition && this.protocol && this.preloadPath);
  }

  warm() {
    if (!this.#canWarm() || this.standby || this.warming) return this.warming ?? Promise.resolve();
    const task = this.#createStandby().catch(() => null).finally(() => {
      if (this.warming === task) this.warming = null;
    });
    this.warming = task;
    return task;
  }

  scheduleWarm(delayMs = 150) {
    if (!this.#canWarm() || this.standby || this.warming || this.replenishTimer) return;
    this.replenishTimer = setTimeout(() => {
      this.replenishTimer = null;
      void this.warm();
    }, delayMs);
    this.replenishTimer.unref?.();
  }

  async #createStandby() {
    const { BrowserWindow, session } = this.electron;
    const partition = `netcatty-plugin-${randomUUID()}`;
    const pluginSession = session.fromPartition(partition, { cache: false });
    const sessionRegistration = this.protocol.registerSession(pluginSession);
    const gate = {
      allowedToken: null,
      allowedUrl: null,
      onError: null,
      onCompleted: null,
    };
    let window = null;
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      try { sessionRegistration.dispose(); } catch {}
      if (window && !window.isDestroyed()) {
        try { window.destroy(); } catch {}
      }
      window = null;
    };
    try {
      await pluginSession.setProxy({
        mode: "fixed_servers",
        proxyRules: "http=127.0.0.1:9;https=127.0.0.1:9;socks=127.0.0.1:9",
        proxyBypassRules: "<-loopback>",
      });
      if (this.closed || this.isLocked()) {
        cleanup();
        return null;
      }
      pluginSession.enableNetworkEmulation({ offline: true });
      pluginSession.on("will-download", (event) => event.preventDefault());
      pluginSession.setPermissionCheckHandler?.(() => false);
      pluginSession.setPermissionRequestHandler?.((_webContents, _permission, callback) => callback(false));
      pluginSession.setDevicePermissionHandler?.(() => false);
      pluginSession.webRequest.onBeforeRequest((details, callback) => {
        if (!gate.allowedToken) {
          callback({ cancel: true });
          return;
        }
        try {
          const url = new URL(details.url);
          const cancel = url.protocol !== `${PLUGIN_PROTOCOL_SCHEME}:` || url.hostname !== gate.allowedToken;
          callback({ cancel });
        } catch {
          callback({ cancel: true });
        }
      });
      pluginSession.webRequest.onErrorOccurred((details) => {
        gate.onError?.(details);
      });
      pluginSession.webRequest.onCompleted((details) => {
        gate.onCompleted?.(details);
      });
      window = new BrowserWindow({
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
      const contents = window.webContents;
      contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      contents.on("will-navigate", (event, url) => {
        if (!gate.allowedUrl || url !== gate.allowedUrl) event.preventDefault();
      });
      contents.on("will-attach-webview", (event) => event.preventDefault());
      const entry = {
        window,
        pluginSession,
        sessionRegistration,
        gate,
        claimed: false,
        cleanup,
      };
      const evictIfUnclaimed = () => {
        if (entry.claimed) return;
        if (this.standby === entry) this.standby = null;
        cleanup();
      };
      contents.once("render-process-gone", evictIfUnclaimed);
      window.once("closed", evictIfUnclaimed);
      if (this.closed || this.isLocked() || this.standby) {
        cleanup();
        return null;
      }
      this.standby = entry;
      return entry;
    } catch {
      cleanup();
      return null;
    }
  }

  claim() {
    if (this.closed || this.isLocked()) return null;
    const entry = this.standby;
    if (!entry) return null;
    this.standby = null;
    if (!entry.window || entry.window.isDestroyed()) {
      try { entry.sessionRegistration.dispose(); } catch {}
      return null;
    }
    entry.claimed = true;
    return entry;
  }

  clear() {
    if (this.replenishTimer) {
      clearTimeout(this.replenishTimer);
      this.replenishTimer = null;
    }
    const entry = this.standby;
    this.standby = null;
    if (!entry || entry.claimed) return;
    entry.cleanup();
  }

  dispose() {
    this.closed = true;
    this.unsubscribeLock?.();
    this.unsubscribeLock = null;
    this.clear();
  }
}

module.exports = { BrowserRuntimePool };
