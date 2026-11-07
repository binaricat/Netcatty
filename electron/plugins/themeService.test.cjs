"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { PluginDatabase } = require("./database.cjs");
const { PluginThemeService } = require("./themeService.cjs");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-theme-test-"));
  const database = new PluginDatabase(path.join(root, "plugins.sqlite"));
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(
        __dirname,
        "../../examples/plugins/forest-theme-pack/netcatty.plugin.json",
      ),
      "utf8",
    ),
  );
  const install = (version = "0.1.0", digest = "a".repeat(64)) =>
    database.installVersion(
      {
        pluginId: manifest.id,
        version,
        manifest: { ...manifest, version },
        archiveSha256: digest,
        packageRelativePath: "theme",
      },
      { enable: true },
    );
  install();
  for (const mode of ["light", "dark"])
    fs.copyFileSync(
      path.join(
        __dirname,
        "../../examples/plugins/forest-theme-pack",
        mode + ".json",
      ),
      path.join(root, mode + ".json"),
    );
  let change;
  const packageStore = {
    async preparePackageRoot() {
      return root;
    },
  };
  const service = new PluginThemeService({
    database,
    packageStore,
    contributionService: {
      onDidChange(listener) {
        change = listener;
        return () => {};
      },
    },
  });
  t.after(() => {
    service.shutdown();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    database,
    service,
    packageStore,
    install,
    change: () => change({ reason: "plugin-disabled" }),
  };
}
test("data-only themes enumerate without runtime, apply with CAS and fixed audit, retain missing preference after disable", async (t) => {
  const f = fixture(t),
    catalog = await f.service.catalog();
  assert.equal(catalog.entries.length, 2);
  assert.ok(catalog.entries.every((e) => e.dataOnly));
  assert.equal(catalog.selection.revision, 0);
  const ref = catalog.entries[0].ref;
  const applied = await f.service.apply({
    expectedRevision: 0,
    mode: "light",
    choice: { ref },
  });
  assert.equal(applied.selection.light.ref.digest, "a".repeat(64));
  await assert.rejects(
    f.service.apply({ expectedRevision: 0, mode: "light", choice: { ref } }),
    /changed/,
  );
  assert.deepEqual(f.database.listSecurityAudit(ref.pluginId)[0].details, {
    revision: 1,
    action: "apply",
  });
  f.database.setEnabled(ref.pluginId, false);
  f.change();
  const disabled = await f.service.catalog();
  assert.equal(disabled.entries.length, 0);
  assert.deepEqual(disabled.selection.light, { ref });
  await assert.rejects(
    f.service.apply({ expectedRevision: 1, mode: "light", choice: { ref } }),
    /no longer available/,
  );
  const restored = await f.service.apply({
    expectedRevision: 1,
    mode: "light",
    choice: null,
  });
  assert.equal(restored.selection.light, null);
});
test("palette validation rejects unsupported values, low contrast, mode mismatch and bounded oversize", async (t) => {
  const f = fixture(t);
  for (const palette of [
    { formatVersion: 1, base: "light", colors: { accent: "var(--x)" } },
    { formatVersion: 1, base: "light", colors: { foreground: "#ffffff" } },
    { formatVersion: 1, base: "light", colors: { muted: "#000000", mutedForeground: "#ffffff" } },
    { formatVersion: 1, base: "dark", colors: { accent: "#86efac" } },
    " ".repeat(65537),
  ]) {
    fs.writeFileSync(
      path.join(f.root, "light.json"),
      typeof palette === "string" ? palette : JSON.stringify(palette),
    );
    f.change();
    const catalog = await f.service.catalog();
    assert.equal(catalog.entries.length, 1);
    assert.equal(catalog.diagnostics[0].code, "invalid");
  }
});
test("replacement during an awaited package read cannot publish or apply the old identity", async (t) => {
  const f = fixture(t);
  const before = await f.service.catalog(),
    ref = before.entries[0].ref;
  f.change();
  let once = true;
  f.packageStore.preparePackageRoot = async () => {
    if (once) {
      once = false;
      f.install("0.1.1", "b".repeat(64));
      f.change();
    }
    return f.root;
  };
  const catalog = await f.service.catalog();
  assert.ok(catalog.entries.every((e) => e.ref.version === "0.1.1"));
  await assert.rejects(
    f.service.apply({ expectedRevision: 0, mode: "light", choice: { ref } }),
    /no longer available/,
  );
});
test("preference and audit roll back together on audit failure and survive schema-3 migration", async (t) => {
  const f = fixture(t),
    ref = (await f.service.catalog()).entries[0].ref;
  f.database.db.exec(
    "CREATE TRIGGER reject_theme_audit BEFORE INSERT ON plugin_security_audit BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END",
  );
  await assert.rejects(
    f.service.apply({ expectedRevision: 0, mode: "light", choice: { ref } }),
    /synthetic audit failure/,
  );
  assert.equal(f.database.getHostThemeSelection().revision, 0);
  f.database.db.exec("DROP TRIGGER reject_theme_audit");
  const file = path.join(f.root, "v3.sqlite");
  const old = new PluginDatabase(file);
  old.db.exec("DROP TABLE plugin_host_preferences; PRAGMA user_version=3");
  old.close();
  const migrated = new PluginDatabase(file);
  assert.equal(migrated.getHostThemeSelection().revision, 0);
  migrated.close();
});
