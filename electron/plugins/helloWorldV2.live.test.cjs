"use strict";
if (!process.versions.electron) {
  require("node:test")("built DOM example views", { skip: "requires Electron and fixture server" }, () => {});
} else {
  const assert = require("node:assert/strict");
  const fs = require("node:fs"); const os = require("node:os"); const path = require("node:path");
  const electron = require("electron");
  const { createPluginHostService } = require("./hostService.cjs");
  const { registerPluginBridge } = require("./pluginBridge.cjs");
  const { PLUGIN_PROTOCOL_SCHEME } = require("./constants.cjs");
  const appRoot = path.resolve(__dirname, "../.."); const userData = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-host-ui-"));
  electron.app.setPath("userData", userData); electron.app.on("window-all-closed", () => {});
  electron.protocol.registerSchemesAsPrivileged([{ scheme: PLUGIN_PROTOCOL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }]);
  void electron.app.whenReady().then(async () => {
    const runtimeAppRoot = path.join(userData, "runtime-app"); const runtimeDirectory = path.join(runtimeAppRoot, "electron/plugins/runtime");
    for (const name of ["plugin-contract", "plugin-sdk"]) fs.cpSync(path.join(appRoot, "node_modules/@netcatty", name, "dist"), path.join(runtimeAppRoot, "node_modules/@netcatty", name, "dist"), { recursive: true });
    fs.cpSync(path.join(__dirname, "runtime"), runtimeDirectory, { recursive: true });
    const service = createPluginHostService({ app: { getPath: (key) => electron.app.getPath(key), getVersion: () => "0.0.0", getAppPath: () => appRoot }, electron, appRoot: runtimeAppRoot, runtimeDirectory, supportedFeatures: ["views.host-drawn"],
      requestPermissionDecision: async (request) => ({ requestId: request.requestId, decision: "allow", scope: "application" }) });
    await service.manager.initialize();
    const { buildPluginPackage } = await import("@netcatty/plugin-cli");
    for (const sample of ['hello-world-v2', 'hello-vault', 'starter-netcatty', 'session-scratchpad', 'vault-scratchpad', 'settings-view-fixture']) {
      const archive = path.join(userData, `${sample}.ncpkg`);
      await buildPluginPackage(path.join(appRoot, 'examples/plugins', sample, '.package'), archive);
      await service.manager.install(archive, { enable: true });
    }
    await service.contributionService.setEnvironment({ locale: 'zh-CN', theme: 'dark', reducedMotion: false, highContrast: false, themeTokens: {} });
    const owner = new electron.BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { sandbox: true, contextIsolation: true, preload: path.join(__dirname, "fixtures/hostReactPreload.cjs") } });
    registerPluginBridge(electron.ipcMain, { ...service, isTrustedSender: (event) => event.sender === owner.webContents && event.senderFrame === owner.webContents.mainFrame });
    const views = ['vault', 'sidebar', 'tab', 'aside', 'panel', 'modal'].map((name) => `com.netcatty.hello-world-v2.${name}`);
    views.push('com.netcatty.hello-vault.page', 'com.netcatty.starter.panel', 'com.netcatty.session-scratchpad.page', 'com.netcatty.vault-scratchpad.page', 'com.netcatty.settings-view-fixture.panel');
    for (const id of views) { console.log('opening', id);
      await owner.loadURL(`http://localhost:5182/scripts/fixtures/host-plugin-react.html?id=${id}`);
      await owner.webContents.executeJavaScript(`new Promise((resolve, reject) => { const end = Date.now() + 12000; const check = () => {
        const shadow = window.testPluginShadow;
        if (shadow?.querySelector('h1')) return resolve(true);
        if (document.body.dataset.failure || Date.now() > end) return reject(new Error('Example failed: ' + document.body.innerText));
        setTimeout(check, 30);
      }; check(); })`);
      if (id.startsWith('com.netcatty.hello-world-v2')) {
        await owner.webContents.executeJavaScript(`window.testPluginShadow.getElementById('button').click()`);
        await owner.webContents.executeJavaScript(`new Promise((resolve,reject) => { const end = Date.now() + 5000; const check = () => {
          if (window.testPluginShadow.getElementById('result').textContent.includes('1 次')) return resolve(true);
          if (Date.now() > end) return reject(new Error('Greeting did not update')); setTimeout(check,20);
        }; check(); })`);
      }
      assert.equal(owner.contentView.children.length, 0, id);
      console.log('HOST_DOM_EXAMPLE_OK', id);
    }
    owner.destroy(); await service.manager.shutdown(); fs.rmSync(userData, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    console.log("HOST_DOM_EXAMPLES_OK"); electron.app.exit(0);
  }).catch((error) => { console.error(error); electron.app.exit(1); });
}
