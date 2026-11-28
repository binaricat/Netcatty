import { startPluginRuntime } from "./runtimePeer.mjs";

function disableDirectBrowserCapability(name) {
  try {
    Object.defineProperty(globalThis, name, {
      configurable: false,
      enumerable: false,
      value: undefined,
      writable: false,
    });
  } catch {
    try { globalThis[name] = undefined; } catch {}
  }
}

function lockDirectBrowserCapabilities() {
  for (const name of [
    "EventSource",
    "RTCPeerConnection",
    "SharedWorker",
    "WebSocket",
    "WebSocketStream",
    "WebTransport",
    "Worker",
    "XMLHttpRequest",
    "fetch",
    "webkitRTCPeerConnection",
  ]) disableDirectBrowserCapability(name);
  try {
    Object.defineProperty(Navigator.prototype, "sendBeacon", {
      configurable: false,
      enumerable: false,
      value: () => false,
      writable: false,
    });
  } catch {}
}

function waitForPort() {
  return new Promise((resolve) => {
    const acceptPort = (event) => {
      if (
        event.data?.type !== "netcatty-plugin:connect"
        || event.data?.runtimeToken !== window.location.hostname
      ) return;
      const port = event.ports?.[0];
      if (!port) return;
      window.removeEventListener("message", acceptPort);
      resolve(port);
    };
    window.addEventListener("message", acceptPort);
    window.postMessage({
      type: "netcatty-plugin:runtime-ready",
      runtimeToken: window.location.hostname,
    }, "*");
  });
}

function readInlineConfig() {
  const element = document.getElementById("netcatty-plugin-config");
  if (!element) return null;
  const raw = element.textContent ?? "";
  element.remove();
  return JSON.parse(raw);
}

let config = readInlineConfig();
let port;
let preloadedModulePromise = null;
if (config) {
  // Lock direct browser networking before importing any package code, then load
  // the plugin module in parallel with the MessagePort handshake.
  lockDirectBrowserCapabilities();
  preloadedModulePromise = import(config.entryUrl);
  // Suppress unhandled-rejection warnings if the import fails before waitForPort resolves;
  // startPluginRuntime still awaits and surfaces the exact rejection from loadPlugin.
  preloadedModulePromise.catch(() => {});
  port = await waitForPort();
} else {
  const [configResponse, connectedPort] = await Promise.all([
    fetch(new URL("./config.json", import.meta.url), { cache: "no-store", credentials: "omit" }),
    waitForPort(),
  ]);
  if (!configResponse.ok) throw new Error("Unable to load plugin runtime configuration");
  config = await configResponse.json();
  port = connectedPort;
  lockDirectBrowserCapabilities();
}
await startPluginRuntime({
  port,
  config,
  // Electron's main-process port cannot deserialize transferred ArrayBuffers.
  // Clone bounded binary envelopes while continuing to transfer MessagePorts.
  transferArrayBuffers: false,
  loadPlugin: (entryUrl) => preloadedModulePromise ?? import(entryUrl),
});
window.postMessage({
  type: "netcatty-plugin:runtime-connected",
  runtimeToken: window.location.hostname,
}, "*");
