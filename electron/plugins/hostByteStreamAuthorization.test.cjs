"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PluginHostInteractionService } = require("./hostInteractionService.cjs");
const { PluginHostVaultService } = require("./hostVaultService.cjs");
const { PluginHostRpcRegistry } = require("./hostRpcRegistry.cjs");

async function fixture(t) {
  const prompts = [], opens = [];
  let mode = "allow", now = Date.now(), release;
  const sender = Object.assign(new EventEmitter(), { id: 3, isDestroyed: () => false, send(_channel, prompt) { if (!prompt.closed) prompts.push(prompt); } });
  const owner = Object.assign(new EventEmitter(), { webContents: sender, isFocused: () => true, isVisible: () => true, isDestroyed: () => false });
  const interaction = new PluginHostInteractionService({ getWindow: () => owner, isLocked: () => false,
    database: { recordSecurityAudit() {} }, quotaManager: { chargeBytes() {} },
    permissionEngine: { getMode: () => mode, onDidRevoke: () => ({ dispose() {} }) },
  });
  interaction.setReady(sender, true);
  const binding = { runtimeId: "runtime", pluginId: "plugin" };
  const vault = new PluginHostVaultService({ interactionService: interaction, clock: () => now,
    sourceBinding: { resolve: async () => binding, releaseRuntime() {}, shutdown() {} },
    openStream: async (endpoint, context, actualSender, options) => {
      const open = { endpoint, context, actualSender, options, closed: false }; opens.push(open);
      if (release) await new Promise((resolve) => { release.resolve = resolve; });
      await context.assertActive();
      context.signal.addEventListener("abort", () => { open.closed = true; });
      return { descriptor: { handleId: "11111111-1111-4111-8111-111111111111", endpoint, inputStreamId: "input-one", outputStreamId: "output-one", windowBytes: 65536 }, close: () => { open.closed = true; } };
    },
  });
  t.after(() => interaction.shutdown());
  const registry = new PluginHostRpcRegistry(); vault.registerRpcCapabilities(registry);
  const identity = { ...binding, runtimeKind: "browser", pluginVersion: "1.0.0", manifest: { features: { required: ["network.byte-streams", "network.host-byte-streams"] } } };
  const routes = registry.createRoutes(identity);
  const call = (name, params) => routes.requestHandlers[name](params, { signal: new AbortController().signal });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const respond = (action, extra = {}, options) => {
    const prompt = prompts.at(-1);
    return interaction.respond(sender, { requestId: prompt.requestId, actionToken: prompt.actionToken, action, ...extra }, options);
  };
  const selection = call("vault.selectHosts", { title: "Choose" }); await tick();
  await respond("submit", { resources: [{ resourceId: "host-one", revision: "r1", label: "Test", hostname: "test.invalid", username: "fixture", group: "", tags: [], protocol: "ssh" }] });
  const selected = (await selection).hosts[0].target;
  const params = { target: selected, expectedRevision: selected.revision, endpoint: "tcp://127.0.0.1:3306" };
  return { interaction, vault, identity, prompts, opens, params, call, respond, tick,
    setMode(value) { mode = value; }, expire() { now += 300_001; }, stall() { release = {}; return release; },

  };
}

test("host stream requires negotiated features, exact endpoint and unmodified selected host reference", async (t) => {
  const f = await fixture(t);
  for (const params of [
    { ...f.params, password: "caller-secret" },
    { ...f.params, endpoint: "tcp://user:secret@localhost:3306" },
    { ...f.params, target: { ...f.params.target, handle: "forged" } },
    { ...f.params, expectedRevision: "changed" },
  ]) await assert.rejects(f.call("network.stream.connectViaHost", params));
  f.identity.manifest.features.required = ["network.byte-streams"];
  await assert.rejects(f.call("network.stream.connectViaHost", f.params), /negotiated/);
  assert.equal(f.opens.length, 0);
});

test("Allow still reviews destination, consumes the native commit once, and lock closes the stream", async (t) => {
  const f = await fixture(t);
  const pending = f.call("network.stream.connectViaHost", f.params); await f.tick();
  assert.equal(f.opens.length, 0);
  assert.equal(f.prompts.at(-1).request.endpoint, f.params.endpoint);
  await f.respond("submit");
  const prompt = f.prompts.at(-1);
  const response = { requestId: prompt.requestId, actionToken: prompt.actionToken, action: "commit" };
  assert.equal(await f.interaction.respond(f.interaction.owner, response, { hostId: "host-one" }), true);
  const descriptor = await pending;
  assert.equal(descriptor.endpoint, f.params.endpoint);
  assert.equal(await f.interaction.respond(f.interaction.owner, response, { hostId: "host-one" }), false);
  assert.equal(f.opens.length, 1);
  f.expire(); await f.opens[0].context.assertActive();
  f.interaction.cancelAll();
  assert.equal(f.opens[0].closed, true);
});

test("Deny, cancellation and a mismatched native host never dial", async (t) => {
  const f = await fixture(t);
  f.setMode("deny"); await assert.rejects(f.call("network.stream.connectViaHost", f.params));
  f.setMode("allow");
  let pending = f.call("network.stream.connectViaHost", f.params); await f.tick();
  await f.respond("cancel"); assert.deepEqual(await pending, { cancelled: true });
  pending = f.call("network.stream.connectViaHost", f.params); void pending.catch(() => {}); await f.tick();
  await f.respond("submit");
  await assert.rejects(f.respond("commit", {}, { hostId: "other-host" }));
  await assert.rejects(pending);
  assert.equal(f.opens.length, 0);
});

test("window closure during opening aborts the operation and rejects a late connection", async (t) => {
  const f = await fixture(t); const gate = f.stall();
  const pending = f.call("network.stream.connectViaHost", f.params); void pending.catch(() => {}); await f.tick();
  await f.respond("submit");
  const committing = f.respond("commit", {}, { hostId: "host-one" }); void committing.catch(() => {}); await f.tick();
  f.interaction.releaseWindow(f.interaction.owner);
  gate.resolve();
  await assert.rejects(committing); await assert.rejects(pending);
  assert.equal(f.opens[0].context.signal.aborted, true);
  assert.equal(f.vault.streams.size, 0);
});
