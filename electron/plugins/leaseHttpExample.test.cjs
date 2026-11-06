"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { MessageChannel } = require("node:worker_threads");
const { PluginRpcRouter } = require("./rpcRouter.cjs");

test("browser lease example negotiates its feature and forwards only an opaque lease", async () => {
  const { startPluginRuntime } = await import("./runtime/runtimePeer.mjs");
  const fixture = await import("../../examples/plugins/lease-http/browser.js");
  const calls = [];
  const secret = { kind: "secret", id: "s".repeat(32), key: "synthetic-token" };
  const lease = { kind: "secret-lease", id: "l".repeat(32), operationId: "network:https://example.invalid", expiresAt: Date.now() + 30_000 };
  const { port1, port2 } = new MessageChannel();
  const host = new PluginRpcRouter({
    pluginId: "com.netcatty.lease-http",
    send: (message) => port1.postMessage(message),
    handlers: {
      "secrets.set": async (params) => { calls.push("secret"); assert.equal(params.key, secret.key); return { secret }; },
      "credentials.createLease": async (params) => {
        calls.push("lease"); assert.deepEqual(params.secret, secret); assert.equal(params.operationId, lease.operationId); return lease;
      },
      "network.request": async (params) => {
        calls.push("network");
        assert.deepEqual(params, { url: "https://example.invalid/synthetic", credentialLease: lease, authorization: { scheme: "Bearer" } });
        assert.equal(JSON.stringify(params).includes("synthetic-acceptance-token"), false);
        return { status: 200, url: params.url, headers: {}, body: { encoding: "base64", data: "" } };
      },
    },
  });
  port1.on("message", (message) => { void host.accept(message); });
  const peer = await startPluginRuntime({
    port: port2,
    config: { pluginId: "com.netcatty.lease-http", pluginVersion: "0.1.0", netcattyVersion: "0.0.0", apiVersion: "0.1.0-internal.1", enabledFeatures: ["network.credential-lease"] },
    loadPlugin: async () => fixture,
  });
  try {
    const initialized = await host.request("plugin.initialize", { netcattyVersion: "0.0.0", apiVersion: "0.1.0-internal.1", supportedFeatures: ["network.credential-lease"] });
    assert.deepEqual(initialized.enabledFeatures, ["network.credential-lease"]);
    await host.request("plugin.activate", {});
    assert.deepEqual(await host.request("plugin.command.execute", { command: "com.netcatty.lease-http.request", invocation: { source: "palette" } }), { status: 200 });
    assert.deepEqual(calls, ["secret", "lease", "network"]);
  } finally {
    await peer.dispose();
    host.close();
    port1.close();
  }
});
