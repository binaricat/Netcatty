"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");

test("native logging fixture packs reproducibly and exposes only synthetic commands", async (t) => {
  const root = path.join(__dirname, "fixtures", "local-logging-plugin");
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "netcatty-synthetic-logging-package-"));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  const { buildPluginPackage } = await import("@netcatty/plugin-cli");
  await buildPluginPackage(root, path.join(output, "one.ncpkg"));
  await buildPluginPackage(root, path.join(output, "two.ncpkg"));
  assert.deepEqual(await fs.readFile(path.join(output, "one.ncpkg")), await fs.readFile(path.join(output, "two.ncpkg")));
  const manifest = JSON.parse(await fs.readFile(path.join(root, "netcatty.plugin.json"), "utf8"));
  assert.deepEqual(manifest.permissions, { required: ["commands", "menus"], optional: [] });
  const plugin = (await import(pathToFileURL(path.join(root, "index.js")).href)).default;
  const commands = new Map();
  const logs = [];
  let deniedRequests = 0;
  plugin.activate({
    subscriptions: { add() {} },
    commands: { registerCommand(id, handler) { commands.set(id, handler); } },
    logger: { info(...args) { logs.push(args); } },
    network: { async request(request) { assert.equal(request.method, "GET"); assert.equal(request.body, undefined); deniedRequests++; throw Object.assign(new Error("synthetic permission denial"), { code: "permission_denied" }); } },
  });
  assert.deepEqual(await commands.get(`${manifest.id}.emit`)(), { ok: true, synthetic: true });
  assert.match(logs[0][0], /Synthetic/);
  assert.equal(logs[0][1].sourceId, "official", "spoofed field is deliberately nested plugin text, never host provenance");
  assert.deepEqual(await commands.get(`${manifest.id}.denied`)(), { denied: true, synthetic: true });
  assert.equal(deniedRequests, 1);
});
