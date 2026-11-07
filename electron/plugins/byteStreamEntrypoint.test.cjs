"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { once } = require("node:events");
const { createPluginHostService } = require("./hostService.cjs");
const { inProcessBrowserRuntime } = require("./fixtures/inProcessBrowserRuntime.cjs");

test("installed browser entrypoint uses registered SDK/RPC streams, denial and revoke", { timeout: 15_000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "netcatty-byte-entry-"));
  let service;
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.on("data", (bytes) => socket.write(bytes));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await service?.manager.shutdown();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const endpoint = `tcp://127.0.0.1:${server.address().port}`;
  const packageRoot = path.join(root, "source");
  await fs.mkdir(packageRoot);
  const id = "com.netcatty.byte-entry-test";
  const manifest = {
    manifestVersion: 1, id, name: "byte-entry-test", version: "0.1.0", publisher: "netcatty",
    engines: { netcatty: ">=0.0.0", api: ">=0.1.0-internal.1 <0.2.0" },
    main: { browser: "browser.js" }, features: { required: ["network.byte-streams", "ai.model-invocation", "context.selected-read"] },
    activationEvents: [`onCommand:${id}.run`],
    permissions: { required: ["commands"], optional: [{ permission: "network.stream", resources: [endpoint] }, "ai.invoke", "context.selected.list", "context.selected.read"] },
    contributes: { commands: ["run", "retain", "readCancelled", "pending", "cancel", "cancelRead", "spoof", "ai", "selected", "aiSpoof"].map((name) => ({ id: `${id}.${name}`, title: name })) },
  };
  await fs.writeFile(path.join(packageRoot, "netcatty.plugin.json"), JSON.stringify(manifest));
  await fs.writeFile(path.join(packageRoot, "browser.js"), `
export default { activate(context) {
  let connection;
  for (const name of ["run", "retain", "readCancelled", "pending", "cancel", "cancelRead", "spoof", "ai", "selected", "aiSpoof"]) context.subscriptions.add(context.commands.registerCommand(${JSON.stringify(id)} + "." + name, async () => {
    if (name === "readCancelled") return connection.readable.read();
    if (name === "aiSpoof") return context.ai.openChat({ sourceOwner: "spoofed" });
    if (name === "selected") {
      const selected = await context.selectedContext.list({});
      return context.selectedContext.read({ handle: selected.items[0].handle, version: selected.items[0].version });
    }
    if (name === "ai") {
      const chat = await context.ai.openChat({});
      try {
        const turn = await context.ai.startTurn({ chatHandle: chat.chatHandle, prompt: "synthetic prompt" });
        const events = [];
        while (true) { const event = await context.ai.readTurn({ turnHandle: turn.turnHandle }); events.push(event); if (event.kind === "end") return events; }
      } finally { await context.ai.closeChat({ chatHandle: chat.chatHandle }); }
    }
    if (name === "cancel") { await connection?.close(); return true; }
    if (name === "spoof") return context.network.connect({ endpoint: ${JSON.stringify(endpoint)}, sourceOwner: "spoofed" });
    connection = await context.network.connect({ endpoint: ${JSON.stringify(endpoint)} });
    if (name === "pending") return { connected: true };
    if (name === "cancelRead") {
      const reading = connection.readable.read();
      connection.readable.cancel();
      try { await reading; return false; } catch { return true; } finally { await connection.close(); }
    }
    if (name === "retain") {
      await connection.writable.write(Uint8Array.of(42));
      return Array.from(await connection.readable.read());
    }
    try {
      await connection.writable.write(Uint8Array.of(0, 255, 42));
      return Array.from(await connection.readable.read());
    } finally { await connection.close(); await connection.close(); }
  }));
} };`);
  let allow = false;
  const decisions = [];
  service = createPluginHostService({
    app: { getAppPath: () => process.cwd(), getPath: () => root, getVersion: () => "0.0.0" },
    electron: {}, env: {},
    pluginAIHostAdapter: {
      assertActive: (context) => context.assertActive(),
      selectModel: async () => ({ label: "Synthetic fixture", isCurrent: async () => true,
        invoke: async () => (async function* () { yield { kind: "text", text: "synthetic model result" }; yield { kind: "usage", inputTokens: 2, outputTokens: 3, totalTokens: 5 }; })(),
      }),
      listSelected: async () => [{ key: "fixture", scope: "tab", title: "Synthetic tab", version: "v1",
        readText: async () => "synthetic selected text", isCurrent: async () => true }],
      reviewText: async () => true,
    },
    requestPermissionDecision: async (request) => {
      decisions.push(request);
      return request.permission === "network.stream" && !allow
        ? { requestId: request.requestId, decision: "deny" }
        : { requestId: request.requestId, decision: "allow", scope: request.permission === "context.selected.read" ? "once" : "application" };
    },
  });
  // Explicit test-only loopback fixture injection. The production constructor
  // exposes no option that forwards these overrides to the broker.
  service.byteStreamService.broker.testLocalEndpoints.add(endpoint);
  service.byteStreamService.broker.isControlEndpoint = () => false;
  service.runtimeSupervisor.runtimeFactories.browser = inProcessBrowserRuntime;
  await service.manager.initialize();
  const { buildPluginPackage } = await import("@netcatty/plugin-cli");
  const archive = path.join(root, "fixture.ncpkg");
  await buildPluginPackage(packageRoot, archive);
  await service.manager.install(archive, { enable: true });
  const run = (name) => service.contributionService.executeCommand(`${id}.${name}`);
  service.permissionEngine.setMode({ id, manifest }, "network.stream", "ask");
  await assert.rejects(run("run"), /denied/u);
  assert.equal(service.byteStreamService.broker.connections.size, 0);
  allow = true;
  assert.deepEqual(await run("run"), [0, 255, 42]);
  assert.equal(await run("cancelRead"), true);
  assert.equal(service.byteStreamService.records.size, 0);
  assert.deepEqual(decisions.find((request) => request.permission === "network.stream").resources, [endpoint]);
  await assert.rejects(run("spoof"), /contract/u);
  assert.deepEqual(await run("ai"), [
    { kind: "text", sequence: 0, text: "synthetic model result" },
    { kind: "usage", sequence: 1, inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    { kind: "end", sequence: 2 },
  ]);
  assert.equal((await run("selected")).text, "synthetic selected text");
  await assert.rejects(run("aiSpoof"), /invalid/u);
  assert.deepEqual(await run("retain"), [42]);
  service.permissionEngine.revokeApplication(id, "network.stream", endpoint);
  assert.equal(service.byteStreamService.records.size, 0);
  assert.equal(service.byteStreamService.broker.connections.size, 0);
  await assert.rejects(run("readCancelled"), /cancel/u);
  await run("cancel");
  await run("pending");
  await service.manager.setEnabled(id, false);
  assert.equal(service.byteStreamService.broker.connections.size, 0);
  assert.equal(service.byteStreamService.closedHandles.size, 0);
});
