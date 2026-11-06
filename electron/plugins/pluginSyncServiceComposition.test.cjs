"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PluginDatabase } = require("./database.cjs");
const { PluginContributionService } = require("./contributionService.cjs");
const { PluginSyncSidecarService } = require("./pluginSyncSidecarService.cjs");
const { registerPluginBridge, CHANNELS } = require("./pluginBridge.cjs");
const { OFFICIAL_SOURCE, thirdPartySource } = require("./sourceIdentity.cjs");

const id = "com.example.sync-composition";
const synced = `${id}.synced`, local = `${id}.local`;
const manifest = {
  manifestVersion: 1, id, name: "Synthetic sync composition", version: "1.0.0", publisher: "example",
  engines: { netcatty: ">=0.0.0", api: ">=0.1.0-internal <0.2.0" }, main: { browser: "index.js" },
  contributes: { settings: [
    { id: synced, label: "Synced", control: "text", scope: "application", default: "default-sync", sync: true },
    { id: local, label: "Local", control: "text", scope: "application", default: "default-local", sync: false },
  ] },
};
function install(database, source = OFFICIAL_SOURCE, enabled = true) {
  database.installVersion({ pluginId: id, version: manifest.version, manifest, source,
    archiveSha256: "a".repeat(64), packageRelativePath: "synthetic/no-executable-package" }, { enable: enabled });
}
function profile(context, label, clock) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `netcatty-sync-composition-${label}-`));
  const database = new PluginDatabase(path.join(root, "plugins.sqlite"), { clock: () => clock });
  context.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const runtimeSupervisor = {
    start: async () => { throw new Error("composition test must not execute a plugin"); },
    request: async () => { throw new Error("composition test must not call a plugin"); },
    notify: async () => {},
  };
  const contributions = new PluginContributionService({ database, runtimeSupervisor, getLocale: () => "en" });
  const sidecars = new PluginSyncSidecarService({ database, contributionService: contributions });
  const handlers = new Map();
  registerPluginBridge({ handle: (name, handler) => handlers.set(name, handler), on() {} }, {
    manager: { initialize: async () => {}, database }, contributionService: contributions,
    syncSidecarService: sidecars, isTrustedSender: (event) => event?.trusted === true,
  });
  return { database, contributions, sidecars,
    collect: () => handlers.get(CHANNELS.syncSidecarsCollect)({ trusted: true }),
    apply: (bundle) => handlers.get(CHANNELS.syncSidecarsApply)({ trusted: true }, bundle),
    untrustedApply: (bundle) => handlers.get(CHANNELS.syncSidecarsApply)({ trusted: false }, bundle) };
}

test("two real profiles collect/apply/hydrate only opted-in source-bound settings through registered host entries", async (context) => {
  for (const state of ["enabled", "disabled", "missing", "other-source"]) {
    await context.test(state, async (context) => {
      const a = profile(context, "sender", 200), b = profile(context, "recipient", 100);
      install(a.database);
      await a.contributions.updateSetting(id, synced, "synthetic-shared-value");
      await a.contributions.updateSetting(id, local, "synthetic-device-only-value");
      const bundle = await a.collect();
      assert.equal(bundle.entries.filter((entry) => entry.kind === "settings").length, 1);
      assert.equal(bundle.entries.some((entry) => entry.value === "synthetic-device-only-value"), false);
      const owner = a.database.privateOwner(id);
      assert.equal(bundle.entries[0].pluginId, owner);
      if (state !== "missing") install(b.database,
        state === "other-source" ? thirdPartySource("Synthetic community", "https://community.example.com") : OFFICIAL_SOURCE,
        state !== "disabled");
      await assert.rejects(b.untrustedApply(bundle), /Untrusted/);
      assert.equal(b.database.listAllSyncSidecars().length, 0, "untrusted sender never applies remote rows");
      const result = await b.apply(bundle);
      assert.equal(result.applied, true);
      assert.equal(b.database.getSetting(id, local, "application", "application"), undefined);
      if (state === "enabled") {
        assert.equal(await b.contributions.getSetting(id, synced), "synthetic-shared-value");
        assert.equal(await b.contributions.getSetting(id, local), "default-local");
      } else {
        assert.equal(b.database.getSetting(id, synced, "application", "application"), undefined,
          "missing, disabled or different-source plugins cannot receive active settings");
        assert.ok(b.database.listAllSyncSidecars().some((entry) => entry.pluginId === owner), "remote row is retained without execution");
        await b.sidecars.hydrateInstalledPluginSettings(id);
        assert.equal(b.database.getSetting(id, synced, "application", "application"), undefined);
        if (state === "disabled") b.database.setEnabled(id, true);
        if (state === "missing") install(b.database);
        await b.sidecars.hydrateInstalledPluginSettings(id);
        assert.equal(await b.contributions.getSetting(id, synced), state === "other-source" ? "default-sync" : "synthetic-shared-value");
        if (state === "other-source") assert.notEqual(b.database.privateOwner(id), owner);
      }
      const collected = await b.collect();
      assert.equal(collected.entries.some((entry) => entry.value === "synthetic-device-only-value"), false);
      assert.equal(await a.contributions.getSetting(id, local), "synthetic-device-only-value", "sender's local-only setting stays local");
    });
  }
});
