"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { PluginDatabase } = require("./database.cjs");
const {
  ARCHIVE_SNAPSHOT_FILE,
  PackageStore,
  REMOVAL_METADATA_FILE,
  REMOVED_PLUGIN_DIRECTORY,
} = require("./packageStore.cjs");
const { createPluginPaths } = require("./paths.cjs");

async function createPackage(root, overrides = {}) {
  const source = path.join(root, `source-${Math.random().toString(16).slice(2)}`);
  await fs.promises.mkdir(path.join(source, "dist"), { recursive: true });
  const pluginManifest = {
    manifestVersion: 1,
    id: "com.example.runtime-test",
    name: "runtime-test",
    version: "1.0.0",
    publisher: "example",
    engines: { netcatty: ">=0.0.0", api: ">=0.1.0-internal <0.2.0" },
    main: { browser: "dist/index.js" },
    ...overrides.manifest,
  };
  await Promise.all([
    fs.promises.writeFile(
      path.join(source, "netcatty.plugin.json"),
      `${JSON.stringify(pluginManifest, null, 2)}\n`,
    ),
    fs.promises.writeFile(path.join(source, "dist/index.js"), overrides.source ?? "export default {};\n"),
  ]);
  const archive = path.join(root, `${pluginManifest.id}-${Date.now()}-${Math.random()}.ncpkg`);
  const { buildPluginPackage } = await import("@netcatty/plugin-cli");
  await buildPluginPackage(source, archive);
  return { archive, manifest: pluginManifest };
}

function createStore(context, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-plugin-store-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = createPluginPaths(root);
  const database = new PluginDatabase(paths.database);
  context.after(() => {
    try { database.close(); } catch {}
  });
  const store = new PackageStore({
    paths,
    database,
    netcattyVersion: "0.0.0",
    apiVersion: "0.1.0-internal",
    supportedFeatures: [],
    ...options,
  });
  return { root, paths, database, store };
}

test("package install stages, validates, atomically publishes, and records the active version", async (context) => {
  const fixture = createStore(context);
  await fixture.store.initialize();
  const pluginPackage = await createPackage(fixture.root);

  const installed = await fixture.store.install(pluginPackage.archive, { enable: true });
  assert.equal(installed.id, pluginPackage.manifest.id);
  assert.equal(installed.enabled, true);
  const packageRoot = fixture.store.resolvePackageRoot(installed);
  assert.equal(
    await fs.promises.readFile(path.join(packageRoot, "dist/index.js"), "utf8"),
    "export default {};\n",
  );
  const versionDirectory = path.dirname(packageRoot);
  const retainedArchive = path.join(versionDirectory, ARCHIVE_SNAPSHOT_FILE);
  assert.equal((await fs.promises.stat(retainedArchive)).isFile(), true);
  assert.equal(
    createHash("sha256").update(await fs.promises.readFile(retainedArchive)).digest("hex"),
    installed.archiveSha256,
  );
  const installMetadata = JSON.parse(await fs.promises.readFile(
    path.join(versionDirectory, "install.json"),
    "utf8",
  ));
  assert.match(installMetadata.contentSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(await fs.promises.readdir(fixture.paths.staging), []);
});

test("runtime preparation rejects changed files and disables the active plugin", async (context) => {
  const fixture = createStore(context);
  await fixture.store.initialize();
  const pluginPackage = await createPackage(fixture.root);
  const installed = await fixture.store.install(pluginPackage.archive, { enable: true });
  const packageRoot = fixture.store.resolvePackageRoot(installed);
  await fs.promises.writeFile(path.join(packageRoot, "dist/index.js"), "export default { tampered: true };\n");

  await assert.rejects(
    fixture.store.preparePackageRoot(installed),
    /do not match the retained package archive/,
  );
  const failed = fixture.database.getActivePlugin(installed.id);
  assert.equal(failed.enabled, false);
  assert.equal(failed.runtime.status, "error");
  assert.match(failed.runtime.lastError, /integrity check failed/);
});

test("runtime preparation rejects unpackaged root entries hidden from source builds", async (context) => {
  const fixture = createStore(context);
  await fixture.store.initialize();
  const pluginPackage = await createPackage(fixture.root);
  const installed = await fixture.store.install(pluginPackage.archive, { enable: true });
  const packageRoot = fixture.store.resolvePackageRoot(installed);
  await fs.promises.mkdir(path.join(packageRoot, "node_modules", "injected"), { recursive: true });
  await fs.promises.writeFile(path.join(packageRoot, "node_modules", "injected", "index.js"), "throw 1;\n");

  await assert.rejects(
    fixture.store.preparePackageRoot(installed),
    /unpackaged root entry: node_modules/,
  );
  assert.equal(fixture.database.getActivePlugin(installed.id).enabled, false);
});

test("startup keeps a corrupted committed snapshot for diagnosis and fails closed", async (context) => {
  const fixture = createStore(context);
  await fixture.store.initialize();
  const pluginPackage = await createPackage(fixture.root);
  const installed = await fixture.store.install(pluginPackage.archive, { enable: true });
  const versionDirectory = path.dirname(fixture.store.resolvePackageRoot(installed));
  const retainedArchive = path.join(versionDirectory, ARCHIVE_SNAPSHOT_FILE);
  await fs.promises.writeFile(retainedArchive, "corrupt archive");

  await fixture.store.recover();

  assert.equal((await fs.promises.stat(retainedArchive)).isFile(), true);
  const failed = fixture.database.getActivePlugin(installed.id);
  assert.equal(failed.enabled, false);
  assert.equal(failed.runtime.status, "error");
  assert.match(failed.runtime.lastError, /integrity check failed/);
});

test("reinstalling identical bytes repairs a corrupted retained snapshot", async (context) => {
  const fixture = createStore(context);
  await fixture.store.initialize();
  const pluginPackage = await createPackage(fixture.root);
  const installed = await fixture.store.install(pluginPackage.archive, { enable: true });
  const versionDirectory = path.dirname(fixture.store.resolvePackageRoot(installed));
  const retainedArchive = path.join(versionDirectory, ARCHIVE_SNAPSHOT_FILE);
  await fs.promises.writeFile(retainedArchive, "corrupt archive");

  const repaired = await fixture.store.install(pluginPackage.archive);

  assert.equal(repaired.enabled, true);
  assert.equal(
    createHash("sha256").update(await fs.promises.readFile(retainedArchive)).digest("hex"),
    repaired.archiveSha256,
  );
  assert.equal(await fixture.store.preparePackageRoot(repaired), path.join(versionDirectory, "package"));
});

test("package install is idempotent for identical bytes and rejects version substitution", async (context) => {
  const fixture = createStore(context);
  await fixture.store.initialize();
  const first = await createPackage(fixture.root);
  await fixture.store.install(first.archive);
  const secondVersion = await createPackage(fixture.root, {
    manifest: { version: "2.0.0" },
    source: "export default { version: 2 };\n",
  });
  await fixture.store.install(secondVersion.archive);
  assert.equal(fixture.database.getActivePlugin(first.manifest.id).activeVersion, "2.0.0");
  const reactivated = await fixture.store.install(first.archive, { enable: true });
  assert.equal(reactivated.activeVersion, "1.0.0");
  assert.equal(reactivated.enabled, true);

  const changed = await createPackage(fixture.root, { source: "export default { changed: true };\n" });
  await assert.rejects(
    fixture.store.install(changed.archive),
    /already installed with different contents/,
  );
  assert.deepEqual(await fs.promises.readdir(fixture.paths.staging), []);
});

test("package activation hook runs before the active version changes", async (context) => {
  const fixture = createStore(context);
  await fixture.store.initialize();
  const first = await createPackage(fixture.root);
  const second = await createPackage(fixture.root, {
    manifest: { version: "2.0.0" },
    source: "export default { version: 2 };\n",
  });
  await fixture.store.install(first.archive, { enable: true });
  const observations = [];

  const installed = await fixture.store.install(second.archive, {
    beforeActivate(details) {
      observations.push({
        details,
        activeVersion: fixture.database.getActivePlugin(first.manifest.id).activeVersion,
      });
    },
  });

  assert.equal(installed.activeVersion, "2.0.0");
  assert.equal(installed.enabled, true);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].activeVersion, "1.0.0");
  assert.equal(observations[0].details.pluginId, first.manifest.id);
  assert.equal(observations[0].details.version, "2.0.0");
  assert.equal(observations[0].details.previousPlugin.activeVersion, "1.0.0");
  assert.equal(observations[0].details.reason, "switch-active-version");
});

test("failed activation preparation preserves the previous database selection", async (context) => {
  const fixture = createStore(context);
  await fixture.store.initialize();
  const first = await createPackage(fixture.root);
  const second = await createPackage(fixture.root, { manifest: { version: "2.0.0" } });
  await fixture.store.install(first.archive, { enable: true });

  await assert.rejects(
    fixture.store.install(second.archive, {
      beforeActivate() { throw new Error("runtime did not stop"); },
    }),
    /runtime did not stop/,
  );

  const active = fixture.database.getActivePlugin(first.manifest.id);
  assert.equal(active.activeVersion, "1.0.0");
  assert.equal(active.enabled, true);
  assert.equal(fixture.database.getVersion(first.manifest.id, "2.0.0"), null);
  await assert.rejects(
    fs.promises.stat(path.join(fixture.paths.packages, first.manifest.id, "2.0.0")),
    { code: "ENOENT" },
  );
});

test("startup recovery removes staging debris and reconstructs a committed orphan disabled", async (context) => {
  const fixture = createStore(context);
  await fixture.store.initialize();
  const pluginPackage = await createPackage(fixture.root);
  const installed = await fixture.store.install(pluginPackage.archive, { enable: true });
  await fs.promises.mkdir(path.join(fixture.paths.staging, "partial"));
  fixture.database.removePlugin(installed.id);

  await fixture.store.recover();

  assert.deepEqual(await fs.promises.readdir(fixture.paths.staging), []);
  const recovered = fixture.database.getActivePlugin(installed.id);
  assert.equal(recovered.activeVersion, "1.0.0");
  assert.equal(recovered.enabled, false);
});

test("startup recovery force-disables a newer orphan when an older version was enabled", async (context) => {
  const fixture = createStore(context);
  const donor = createStore(context);
  await Promise.all([fixture.store.initialize(), donor.store.initialize()]);
  const first = await createPackage(fixture.root);
  const second = await createPackage(donor.root, { manifest: { version: "2.0.0" } });
  await fixture.store.install(first.archive, { enable: true });
  await donor.store.install(second.archive);

  const orphanSource = path.join(donor.paths.packages, first.manifest.id, "2.0.0");
  const orphanTarget = path.join(fixture.paths.packages, first.manifest.id, "2.0.0");
  await fs.promises.cp(orphanSource, orphanTarget, { recursive: true, errorOnExist: true });

  assert.equal(fixture.database.getActivePlugin(first.manifest.id).enabled, true);
  await fixture.store.recover();

  const recovered = fixture.database.getActivePlugin(first.manifest.id);
  assert.equal(recovered.activeVersion, "2.0.0");
  assert.equal(recovered.enabled, false);
});

test("startup recovery discards incomplete removal staging before a package was moved", async (context) => {
  const fixture = createStore(context);
  await fixture.store.initialize();
  const emptyRemoval = path.join(fixture.paths.staging, "remove-empty");
  const partialRemoval = path.join(fixture.paths.staging, "remove-partial");
  await fs.promises.mkdir(emptyRemoval);
  await fs.promises.mkdir(partialRemoval);
  await fs.promises.writeFile(path.join(partialRemoval, REMOVAL_METADATA_FILE), "{\"pluginId\":");

  await fixture.store.recover();

  assert.deepEqual(await fs.promises.readdir(fixture.paths.staging), []);
});

test("startup recovery keeps an unidentified moved package fail-closed", async (context) => {
  const fixture = createStore(context);
  await fixture.store.initialize();
  const pluginPackage = await createPackage(fixture.root);
  const installed = await fixture.store.install(pluginPackage.archive, { enable: true });
  const removalDirectory = path.join(fixture.paths.staging, "remove-corrupt-metadata");
  const removedPluginPath = path.join(removalDirectory, REMOVED_PLUGIN_DIRECTORY);
  await fs.promises.mkdir(removalDirectory);
  await fs.promises.rename(path.join(fixture.paths.packages, installed.id), removedPluginPath);
  await fs.promises.writeFile(path.join(removalDirectory, REMOVAL_METADATA_FILE), "{\"pluginId\":");

  await assert.rejects(fixture.store.recover());

  assert.equal((await fs.promises.stat(removedPluginPath)).isDirectory(), true);
  assert.equal(fixture.database.getActivePlugin(installed.id).enabled, true);
});

test("startup recovery completes or rolls back an interrupted uninstall", async (context) => {
  const fixture = createStore(context);
  await fixture.store.initialize();
  const pluginPackage = await createPackage(fixture.root);
  const installed = await fixture.store.install(pluginPackage.archive, { enable: true });
  const installedPluginPath = path.join(fixture.paths.packages, installed.id);

  const stageRemoval = async (name) => {
    const removalDirectory = path.join(fixture.paths.staging, name);
    await fs.promises.mkdir(removalDirectory, { mode: 0o700 });
    await fs.promises.writeFile(
      path.join(removalDirectory, REMOVAL_METADATA_FILE),
      `${JSON.stringify({ pluginId: installed.id })}\n`,
    );
    await fs.promises.rename(
      installedPluginPath,
      path.join(removalDirectory, REMOVED_PLUGIN_DIRECTORY),
    );
    return removalDirectory;
  };

  const rollbackDirectory = await stageRemoval("remove-before-database");
  await fixture.store.recover();
  assert.equal((await fs.promises.stat(installedPluginPath)).isDirectory(), true);
  await assert.rejects(fs.promises.stat(rollbackDirectory), { code: "ENOENT" });
  assert.equal(fixture.database.getActivePlugin(installed.id).activeVersion, "1.0.0");

  const completionDirectory = await stageRemoval("remove-after-database");
  fixture.database.removePlugin(installed.id);
  await fixture.store.recover();
  await assert.rejects(fs.promises.stat(completionDirectory), { code: "ENOENT" });
  await assert.rejects(fs.promises.stat(installedPluginPath), { code: "ENOENT" });
  assert.equal(fixture.database.getActivePlugin(installed.id), null);
});

test("uninstall syncs the package-store source before deleting its database row", async (context) => {
  const synced = [];
  const fixture = createStore(context, {
    async syncDirectory(directory) { synced.push(directory); },
  });
  await fixture.store.initialize();
  const pluginPackage = await createPackage(fixture.root);
  const installed = await fixture.store.install(pluginPackage.archive, { enable: true });
  synced.length = 0;
  const removePlugin = fixture.database.removePlugin.bind(fixture.database);
  fixture.database.removePlugin = (pluginId) => {
    assert.equal(pluginId, installed.id);
    assert.equal(synced.at(-1), fixture.paths.packages);
    removePlugin(pluginId);
  };

  assert.equal(await fixture.store.uninstall(installed.id), true);
  assert.equal(synced.includes(fixture.paths.packages), true);
});

test("failed package validation removes every extracted staging file", async (context) => {
  const fixture = createStore(context);
  await fixture.store.initialize();
  const invalid = path.join(fixture.root, "invalid.ncpkg");
  await fs.promises.writeFile(invalid, "not a zip");

  await assert.rejects(fixture.store.install(invalid));
  assert.deepEqual(await fs.promises.readdir(fixture.paths.staging), []);
  assert.deepEqual(fixture.database.listPlugins(), []);
});

test("host upgrade disables incompatible lazy plugins before contributions and retains data", async (context) => {
  const fixture = createStore(context);
  await fixture.store.initialize();
  const archive = await createPackage(fixture.root, {
    manifest: { engines: { netcatty: "<1.0.0", api: ">=0.1.0-internal <0.2.0" } },
  });
  const installed = await fixture.store.install(archive.archive, { enable: true });
  fixture.database.setValue(installed.id, "synthetic", { retained: true });
  fixture.store.netcattyVersion = "1.0.0";
  await fixture.store.initialize();
  const disabled = fixture.database.getActivePlugin(installed.id);
  assert.equal(disabled.enabled, false);
  assert.match(disabled.runtime.lastError, /incompatible.*Netcatty/);
  assert.equal(disabled.activeVersion, installed.activeVersion);
  assert.deepEqual(fixture.database.getValue(installed.id, "synthetic"), { retained: true });
  assert.equal(fs.existsSync(fixture.store.resolvePackageRoot(disabled)), true);
  await assert.rejects(fixture.store.assertCompatible(disabled), { code: "PLUGIN_INCOMPATIBLE" });
  fixture.store.netcattyVersion = "0.0.0";
  await fixture.store.initialize();
  assert.equal(fixture.database.getActivePlugin(installed.id).enabled, false,
    "returning to a compatible host must not silently re-enable code");
});

for (const target of [
  { apiVersion: "0.2.0" },
  { supportedFeatures: [] },
]) {
  test(`startup checks API and required feature compatibility: ${JSON.stringify(target)}`, async (context) => {
    const fixture = createStore(context, { supportedFeatures: ["example.feature"] });
    await fixture.store.initialize();
    const archive = await createPackage(fixture.root, {
      manifest: { features: { required: ["example.feature"] } },
    });
    const installed = await fixture.store.install(archive.archive, { enable: true });
    Object.assign(fixture.store, target);
    await fixture.store.initialize();
    assert.equal(fixture.database.getActivePlugin(installed.id).enabled, false);
  });
}

test("explicit disabled import never auto-enables an update of an enabled plugin", async (context) => {
  const fixture = createStore(context);
  await fixture.store.initialize();
  const first = await createPackage(fixture.root);
  await fixture.store.install(first.archive, { enable: true });
  const update = await createPackage(fixture.root, { manifest: { version: "1.1.0" } });
  const installed = await fixture.store.install(update.archive, { enable: false });
  assert.equal(installed.activeVersion, "1.1.0");
  assert.equal(installed.enabled, false);
});

test("catalog installation verifies actual package manifest and rejects Node before activation", async (context) => {
  const fixture = createStore(context);
  await fixture.store.initialize();
  const archive = await createPackage(fixture.root, { manifest: { license: "MIT" } });
  const sha256 = createHash("sha256").update(await fs.promises.readFile(archive.archive)).digest("hex");
  const entry = { id: archive.manifest.id, version: archive.manifest.version, license: "MIT", manifest: archive.manifest, artifact: { sha256 } };
  await assert.rejects(fixture.store.install(archive.archive, { catalog: { ...entry, version: "9.0.0" } }), /identity\/version/);
  await assert.rejects(fixture.store.install(archive.archive, { catalog: { ...entry, artifact: { sha256: "0".repeat(64) } } }), /SHA-256/);
  await assert.rejects(fixture.store.install(archive.archive, { catalog: { ...entry, manifest: { ...archive.manifest, description: "different" } } }), /manifest does not match/);
  assert.equal(fixture.database.listPlugins().length, 0);
  assert.equal((await fixture.store.install(archive.archive, { enable: false, catalog: entry })).enabled, false);
  const advanced = await createPackage(fixture.root, { manifest: { version: "2.0.0", license: "MIT", main: { node: "dist/index.js" }, permissions: { required: ["runtime.advanced"] } } });
  const advancedEntry = { ...entry, version: "2.0.0", manifest: advanced.manifest, artifact: { sha256: createHash("sha256").update(await fs.promises.readFile(advanced.archive)).digest("hex") } };
  await assert.rejects(fixture.store.install(advanced.archive, { catalog: advancedEntry }), /browser-only packages/);
  assert.equal(fixture.database.getActivePlugin(entry.id).activeVersion, "1.0.0");
});

test("normal release refuses advanced local imports and disables previously installed lazy packages", async (context) => {
  const fixture = createStore(context);
  await fixture.store.initialize();
  const archive = await createPackage(fixture.root, { manifest: {
    main: { browser: "dist/index.js", node: "dist/index.js" },
    permissions: { optional: ["runtime.advanced"] },
  } });
  const installed = await fixture.store.install(archive.archive, { enable: true });
  fixture.database.setValue(installed.id, "synthetic", 42);
  fixture.store.allowAdvancedPlugins = false;
  await fixture.store.initialize();
  assert.equal(fixture.database.getActivePlugin(installed.id).enabled, false);
  assert.match(fixture.database.getActivePlugin(installed.id).runtime.lastError, /developer mode/);
  assert.equal(fixture.database.getValue(installed.id, "synthetic"), 42);
  await assert.rejects(fixture.store.install(archive.archive), /browser-only packages/);
  await assert.rejects(fixture.store.assertCompatible(installed), /browser-only packages/);
});
