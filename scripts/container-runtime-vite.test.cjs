"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

// Use native ESM linking, rather than Node's CommonJS interop or a bundler,
// so a missing browser export fails exactly as it does in the renderer.
async function checkDevImport() {
  const { createServer } = await import("vite");
  const { SourceTextModule, createContext } = await import("node:vm");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const assert = (await import("node:assert/strict")).default;
  const require = createRequire(`${process.cwd()}/package.json`);
  const temp = require("./electron/bridges/tempDirBridge.cjs");
  const cacheDir = mkdtempSync(`${temp.getTempFilePath("container-runtime-vite")}-`);
  let server;
  try {
    server = await createServer({
      cacheDir,
      logLevel: "error",
      server: { port: 0, strictPort: false, open: false },
      optimizeDeps: { entries: [], noDiscovery: true },
    });
    await server.listen();
    const origin = server.resolvedUrls.local[0];
    const context = createContext({});
    const modules = new Map();
    async function load(url) {
      if (!modules.has(url)) {
        modules.set(url, (async () => {
          const response = await fetch(url);
          assert.equal(response.status, 200, url);
          return new SourceTextModule(await response.text(), { context, identifier: url });
        })());
      }
      return modules.get(url);
    }
    const managerResponse = await fetch(new URL("/components/settings/tabs/PluginPackageManager.tsx", origin));
    assert.equal(managerResponse.status, 200);
    const themeResponse = await fetch(new URL("/infrastructure/config/pluginThemeRegistry.ts", origin));
    assert.equal(themeResponse.status, 200);
    const managerSource = await managerResponse.text() + "\n" + await themeResponse.text();
    // The lazy settings entry also links the permission panel before it renders.
    // Probe its actual Vite-served import: Node's CJS interop and production
    // CommonJS conversion otherwise hide missing browser ESM exports.
    const settingsResponse = await fetch(new URL("/components/settings/tabs/SettingsPluginsTab.tsx", origin));
    assert.equal(settingsResponse.status, 200);
    assert.match(await settingsResponse.text(), /\/components\/settings\/tabs\/PluginPackageManager\.tsx/);
    assert.match(managerSource, /\/components\/settings\/tabs\/PluginPermissionPanel\.tsx/);
    const panelResponse = await fetch(new URL("/components/settings/tabs/PluginPermissionPanel.tsx", origin));
    assert.equal(panelResponse.status, 200);
    const panelSource = await panelResponse.text();
    const permissionImport = panelSource.match(/^import\s+.*from "[^"\n]*pluginPermissionDescriptions[^"\n]*";[^\n]*$/m);
    assert.ok(permissionImport, "Missing Vite-served permission helper import");
    const panelProbe = new SourceTextModule(`${permissionImport[0]}\nexport { describePluginPermission };`, { context, identifier: new URL("/permission-panel-probe", origin).href });
    await panelProbe.link((specifier, importer) => load(new URL(specifier, importer.identifier).href));
    await panelProbe.evaluate();
    assert.equal(panelProbe.namespace.describePluginPermission("network").label, "Network requests");
    for (const [helper, exported] of [["pluginRuntimePolicy", "describePluginRuntime"], ["pluginPermissionDescriptions", "describePluginPermission"], ["pluginThemePack", "resolveThemePalette"]]) {
      const match = managerSource.match(new RegExp('from "([^"\\n]*' + helper + '[^"\\n]*)"'));
      assert.ok(match, `Missing prebundled ${helper} import`);
      const module = await load(new URL(match[1], origin).href);
      if (module.status === "unlinked") await module.link((specifier, importer) => load(new URL(specifier, importer.identifier).href));
      await module.evaluate();
      assert.equal(typeof module.namespace.default[exported], "function");
    }
    const entry = await load(new URL("/domain/systemManager/containerRuntime.ts", origin).href);
    await entry.link((specifier, importer) => load(new URL(specifier, importer.identifier).href));
    await entry.evaluate();
    const runtime = entry.namespace;
    assert.equal(runtime.firstContainerRuntime(["podman"]), "podman");
    assert.equal(runtime.buildContainerExecShellCommand("podman", "abc").includes("podman exec"), true);
    assert.equal(runtime.describeRuntimeFailure({ errorCode: "nerdctlUnreachable" }, key => key, "fallback"), "systemManager.errors.nerdctlUnreachable");
    assert.equal(runtime.describeRuntimeFailure({ error: "original error" }, key => key, "fallback"), "original error");
    assert.equal(runtime.describeRuntimeFailure(null, key => key, "fallback"), "fallback");
  } finally {
    await server?.close();
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

test("Vite serves the renderer shared helpers with browser-compatible exports", { timeout: 60_000 }, () => {
  const result = spawnSync(process.execPath, [
    "--experimental-vm-modules", "--input-type=module", "-e",
    `(${checkDevImport.toString()})().catch(error => { console.error(error); process.exitCode = 1; });`,
  ], { cwd: path.resolve(__dirname, ".."), encoding: "utf8", timeout: 55_000 });
  assert.equal(result.status, 0, result.error?.message || `${result.stdout}\n${result.stderr}`);
});
