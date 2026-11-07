"use strict";

// Test transport harness only. This is Node, not an OS/browser sandbox test.
// Production continues to use the sandboxed BrowserPluginRuntime unchanged.
const { MessageChannel } = require("node:worker_threads");
const { pathToFileURL } = require("node:url");
const path = require("node:path");
const { PluginRpcRouter } = require("../rpcRouter.cjs");

function inProcessBrowserRuntime(options) {
  let host;
  let peer;
  let port;
  return {
    async start(config) {
      const { startPluginRuntime } = await import("../runtime/runtimePeer.mjs");
      const { port1, port2 } = new MessageChannel();
      port = port1;
      host = new PluginRpcRouter({ pluginId: config.pluginId,
        send: (message, transfer) => port1.postMessage(message, transfer),
        requestHandlers: options.requestHandlers, notificationHandlers: options.notificationHandlers,
        onIncomingStream: options.onIncomingStream, onBeforeMessage: options.onBeforeMessage,
        onProtocolError: options.onProtocolError,
      });
      port1.on("message", (message) => { void host.accept(message); });
      peer = await startPluginRuntime({ port: port2, config,
        loadPlugin: () => import(pathToFileURL(path.join(options.packageRoot, options.plugin.manifest.main.browser)).href),
      });
      const initialized = await host.request("plugin.initialize", {
        netcattyVersion: config.netcattyVersion, apiVersion: config.apiVersion, supportedFeatures: config.supportedFeatures,
      });
      await host.request("plugin.activate", {});
      return initialized;
    },
    request: (...args) => host.request(...args),
    notify: (...args) => host.notify(...args),
    openStream: (...args) => host.streams.openOutgoing(...args),
    async stop() {
      try { if (host) await host.request("plugin.deactivate", {}); }
      finally { await peer?.dispose(); host?.close(); port?.close(); }
    },
  };
}

module.exports = { inProcessBrowserRuntime };
