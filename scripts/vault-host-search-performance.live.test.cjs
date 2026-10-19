"use strict";
/* global process, __dirname, console */

if (!process.versions.electron) {
  require("node:test")("large Vault searches keep input responsive", {
    skip: "run with Electron for actual React input and virtualized host rendering",
  }, () => {});
} else {
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const path = require("node:path");
  const { app, BrowserWindow } = require("electron");
  const esbuild = require("esbuild");
  const temp = require("../electron/bridges/tempDirBridge.cjs");
  const userData = fs.mkdtempSync(`${temp.getTempFilePath("vault-host-search-perf")}-`);
  const maximumInputMs = Number(process.env.NETCATTY_VAULT_SEARCH_MAX_INPUT_MS || "50");
  app.setPath("userData", userData);
  app.on("window-all-closed", () => {});
  let window;
  const cleanup = (code) => {
    window?.destroy();
    fs.rmSync(userData, { recursive: true, force: true });
    app.exit(code);
  };
  void app.whenReady().then(async () => {
    const bundle = esbuild.buildSync({
      entryPoints: [path.join(__dirname, "fixtures/vault-search-performance.tsx")],
      bundle: true, format: "cjs", platform: "browser", write: false,
      define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true", "import.meta": "{}", "process.env.NODE_ENV": '"production"' },
    }).outputFiles[0].text;
    window = new BrowserWindow({
      show: process.env.NETCATTY_VAULT_SEARCH_SHOW_WINDOW === "1",
      width: 1280, height: 800,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    await window.loadURL("data:text/html,<body><div id='root'></div>");
    const rows = await window.webContents.executeJavaScript(`(async () => {
      const loaded = { exports: {} };
      ((module, exports) => { ${bundle} })(loaded, loaded.exports);
      return loaded.exports.runVaultSearchPerformance();
    })()`);
    console.log("VAULT_HOST_SEARCH_MEASUREMENTS", JSON.stringify(rows));
    assert.ok(rows.every(row => row.actualInput === row.query), "drive actual onChange updates");
    assert.ok(rows.every(row => row.mountedHosts <= 20), "retain a bounded rendered list");
    const expectedMatches = { "production web": 5000, "Region 99": 95, "no-match-query": 0 };
    for (const [query, count] of Object.entries(expectedMatches)) {
      const samples = rows.filter(row => row.query === query);
      assert.ok(samples.every(row => row.matches === count), query);
      assert.equal(new Set(samples.map(row => row.orderHash)).size, 1, "stable matching order");
    }
    const warmRegion = rows.filter(row => row.round > 0 && row.query === "Region 99");
    assert.ok(warmRegion.every(row => row.inputDelayMs < maximumInputMs),
      `Vault search input exceeded ${maximumInputMs}ms: ${JSON.stringify(warmRegion)}`);
    console.log("VAULT_HOST_SEARCH_PERFORMANCE_OK");
    cleanup(0);
  }).catch(error => { console.error(error); cleanup(1); });
}
