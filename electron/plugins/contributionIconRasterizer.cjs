"use strict";

const { randomUUID } = require("node:crypto");

const DEFAULT_RASTER_TIMEOUT_MS = 5_000;
const DEFAULT_POOLED_RASTER_TIMEOUT_MS = 15_000;
const DEFAULT_POOLED_IDLE_MS = 15_000;
const RASTER_BLANK_HTML_URL = "data:text/html;charset=utf-8,%3Cmeta%20http-equiv%3D%22Content-Security-Policy%22%20content%3D%22default-src%20'none'%3B%20img-src%20data%3A%3B%22%3E";

function withTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function browserRasterizeExpression(payload) {
  return `(async (payload) => {
    const image = new Image();
    image.decoding = "sync";
    if (payload.mimeType === "image/svg+xml") {
      const bytes = Uint8Array.from(atob(payload.source), (character) => character.charCodeAt(0));
      const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const document = new DOMParser().parseFromString(source, "image/svg+xml");
      const root = document.documentElement;
      if (root.localName !== "svg" || document.querySelector("parsererror")) {
        throw new Error("Plugin contribution SVG icon is invalid");
      }
      root.setAttribute("width", String(payload.width));
      root.setAttribute("height", String(payload.height));
      const normalized = new XMLSerializer().serializeToString(root);
      image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(normalized);
    } else {
      image.src = "data:" + payload.mimeType + ";base64," + payload.source;
    }
    await image.decode();
    if (image.naturalWidth !== payload.width || image.naturalHeight !== payload.height) {
      throw new Error("Plugin contribution icon dimensions changed during decoding");
    }
    const scale = Math.min(1, payload.maxEdge / image.naturalWidth, payload.maxEdge / image.naturalHeight);
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: true, desynchronized: false });
    if (!context) throw new Error("Plugin contribution icon canvas is unavailable");
    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL("image/png");
  })(${JSON.stringify(payload)})`;
}

function createIsolatedContributionIconRasterizer(options) {
  const BrowserWindow = options?.BrowserWindow;
  const randomUUIDFn = options?.randomUUID ?? randomUUID;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_RASTER_TIMEOUT_MS;
  return async ({ body, mimeType, width, height, maxEdge }) => {
    if (typeof BrowserWindow !== "function") {
      throw new Error("Isolated plugin contribution icon rasterizer is unavailable");
    }
    const partition = `plugin-icon-raster-${randomUUIDFn()}`;
    const win = new BrowserWindow({
      show: false,
      width: maxEdge,
      height: maxEdge,
      webPreferences: {
        partition,
        sandbox: true,
        spellcheck: false,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        backgroundThrottling: false,
      },
    });
    try {
      win.removeMenu?.();
      win.webContents?.session?.webRequest?.onBeforeRequest?.(
        { urls: ["http://*/*", "https://*/*", "file://*/*", "ftp://*/*"] },
        (_details, callback) => callback({ cancel: true }),
      );
      await withTimeout(
        Promise.resolve(win.loadURL(RASTER_BLANK_HTML_URL)),
        timeoutMs,
        "Plugin contribution icon rasterizer did not load in time",
      );
      const result = await withTimeout(
        Promise.resolve(win.webContents.executeJavaScript(browserRasterizeExpression({
          source: body.toString("base64"),
          mimeType,
          width,
          height,
          maxEdge,
        }), true)),
        timeoutMs,
        "Plugin contribution icon rasterization timed out",
      );
      const prefix = "data:image/png;base64,";
      if (typeof result !== "string" || !result.startsWith(prefix)) {
        throw new Error("Plugin contribution icon rasterizer returned an invalid result");
      }
      return Buffer.from(result.slice(prefix.length), "base64");
    } finally {
      try { win.destroy(); } catch {}
    }
  };
}

/**
 * Reuses a single sandboxed, network-denied BrowserWindow across burst decodes
 * (e.g. plugin view icon grids) and destroys it automatically after idleMs, on
 * any error/timeout, or on dispose(). Preserves the exact same sandbox, CSP,
 * spellcheck:false, and network-deny guarantees as per-call windows while
 * eliminating repeated OS window creation overhead.
 */
function createPooledContributionIconRasterizer(options) {
  const BrowserWindow = options?.BrowserWindow;
  const randomUUIDFn = options?.randomUUID ?? randomUUID;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_POOLED_RASTER_TIMEOUT_MS;
  const idleMs = options?.idleMs ?? DEFAULT_POOLED_IDLE_MS;

  let activeWindow = null;
  let windowReadyPromise = null;
  let inFlight = 0;
  let idleTimer = null;
  let generation = 0;

  const clearIdleTimer = () => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const destroyCurrent = (expectedGen) => {
    if (expectedGen !== undefined && expectedGen !== generation) return;
    clearIdleTimer();
    const win = activeWindow;
    activeWindow = null;
    windowReadyPromise = null;
    generation += 1;
    if (win) {
      try { win.destroy(); } catch {}
    }
  };

  const scheduleIdleDestroy = (expectedGen) => {
    clearIdleTimer();
    if (inFlight > 0 || !activeWindow || idleMs <= 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (inFlight === 0 && generation === expectedGen) destroyCurrent(expectedGen);
    }, idleMs);
    idleTimer.unref?.();
  };

  const acquireWindow = async () => {
    if (typeof BrowserWindow !== "function") {
      throw new Error("Isolated plugin contribution icon rasterizer is unavailable");
    }
    clearIdleTimer();
    if (activeWindow && windowReadyPromise && !activeWindow.isDestroyed?.()) {
      const currentGen = generation;
      await windowReadyPromise;
      if (activeWindow && generation === currentGen && !activeWindow.isDestroyed?.()) {
        return { win: activeWindow, gen: currentGen };
      }
    }
    destroyCurrent();
    const currentGen = generation;
    const partition = `plugin-icon-raster-${randomUUIDFn()}`;
    const win = new BrowserWindow({
      show: false,
      width: 64,
      height: 64,
      webPreferences: {
        partition,
        sandbox: true,
        spellcheck: false,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        backgroundThrottling: false,
      },
    });
    activeWindow = win;
    win.webContents?.once?.("render-process-gone", () => destroyCurrent(currentGen));
    const ready = (async () => {
      win.removeMenu?.();
      win.webContents?.session?.webRequest?.onBeforeRequest?.(
        { urls: ["http://*/*", "https://*/*", "file://*/*", "ftp://*/*"] },
        (_details, callback) => callback({ cancel: true }),
      );
      await withTimeout(
        Promise.resolve(win.loadURL(RASTER_BLANK_HTML_URL)),
        timeoutMs,
        "Plugin contribution icon rasterizer did not load in time",
      );
    })();
    windowReadyPromise = ready;
    try {
      await ready;
      return { win, gen: currentGen };
    } catch (error) {
      destroyCurrent(currentGen);
      throw error;
    }
  };

  const rasterize = async ({ body, mimeType, width, height, maxEdge }) => {
    inFlight += 1;
    let gen;
    try {
      const acquired = await acquireWindow();
      gen = acquired.gen;
      const result = await withTimeout(
        Promise.resolve(acquired.win.webContents.executeJavaScript(browserRasterizeExpression({
          source: body.toString("base64"),
          mimeType,
          width,
          height,
          maxEdge,
        }), true)),
        timeoutMs,
        "Plugin contribution icon rasterization timed out",
      );
      const prefix = "data:image/png;base64,";
      if (typeof result !== "string" || !result.startsWith(prefix)) {
        throw new Error("Plugin contribution icon rasterizer returned an invalid result");
      }
      return Buffer.from(result.slice(prefix.length), "base64");
    } catch (error) {
      if (gen !== undefined) destroyCurrent(gen);
      throw error;
    } finally {
      inFlight = Math.max(0, inFlight - 1);
      if (inFlight === 0 && activeWindow) scheduleIdleDestroy(generation);
    }
  };

  rasterize.dispose = () => destroyCurrent();
  return rasterize;
}

module.exports = {
  DEFAULT_RASTER_TIMEOUT_MS,
  DEFAULT_POOLED_RASTER_TIMEOUT_MS,
  DEFAULT_POOLED_IDLE_MS,
  browserRasterizeExpression,
  createIsolatedContributionIconRasterizer,
  createPooledContributionIconRasterizer,
};
