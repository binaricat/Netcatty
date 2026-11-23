"use strict";
if (!process.versions.electron) {
  require("node:test")("host-rendered React plugin", { skip: "requires Electron" }, () => {});
} else {
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const electron = require("electron");
  const { createPluginHostService } = require("./hostService.cjs");
  const { PLUGIN_PROTOCOL_SCHEME } = require("./constants.cjs");
  const appRoot = path.resolve(__dirname, "../..");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-host-react-"));
  electron.app.setPath("userData", userData); electron.app.on("window-all-closed", () => {});
  electron.protocol.registerSchemesAsPrivileged([{ scheme: PLUGIN_PROTOCOL_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, codeCache: true } }]);
  void electron.app.whenReady().then(async () => {
    const runtimeAppRoot = path.join(userData, "runtime-app");
    const runtimeDirectory = path.join(runtimeAppRoot, "electron/plugins/runtime");
    for (const name of ["plugin-contract", "plugin-sdk"]) fs.cpSync(path.join(appRoot, "node_modules/@netcatty", name, "dist"), path.join(runtimeAppRoot, "node_modules/@netcatty", name, "dist"), { recursive: true });
    fs.cpSync(path.join(__dirname, "runtime"), runtimeDirectory, { recursive: true });
    const service = createPluginHostService({ app: electron.app, electron, appRoot: runtimeAppRoot, runtimeDirectory, supportedFeatures: ["views.host-drawn"],
      requestPermissionDecision: async (request) => ({ requestId: request.requestId, decision: "allow", scope: "application" }) });
    await service.manager.initialize();
    const { buildPluginPackage } = await import("@netcatty/plugin-cli");
    const archive = path.join(userData, "hello.ncpkg"); await buildPluginPackage(path.join(appRoot, "examples/plugins/hello-react-host"), archive);
    await service.manager.install(archive, { enable: true });
    const owner = new electron.BrowserWindow({ show: false, width: 800, height: 600 }); await owner.loadURL("data:text/html,<body>Test host</body>");
    const messages = []; const send = owner.webContents.send.bind(owner.webContents);
    owner.webContents.send = (channel, payload) => { messages.push({ channel, payload }); send(channel, payload); };
    const host = service.hostDrawnViewHost; const id = "react-test-instance";
    await host.open({ viewId: "com.netcatty.hello-react-host.vault", instanceId: id, scopeId: "smoke", context: { "netcatty.surface": "vault-page" } }, owner.webContents);
    const wait = async (predicate) => {
      const deadline = Date.now() + 10000;
      while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timed out waiting for plugin update: ${JSON.stringify(messages)}`); await new Promise((resolve) => setTimeout(resolve, 20)); }
    };
    const find = (node, name) => node?.element === name ? node : node?.children?.map((child) => find(child, name)).find(Boolean);
    const getButton = () => messages.filter((item) => item.channel === 'netcatty:plugins:host-ui-update').flatMap((item) => item.payload.mutations).map((mutation) => find(mutation[2], 'button')).find(Boolean);
    await wait(() => getButton());
    const button = getButton();
    assert.ok(button, "React button should be sent as plain data");
    await host.event(id, { nodeId: button.id, type: "click" }, owner.webContents);
    await wait(() => /你好，朋友/.test(JSON.stringify(messages)));
    assert.match(JSON.stringify(messages), /你好，朋友/);
    assert.equal(owner.contentView.children.length, 0, "host-drawn page must not attach a browser view");
    await host.close(id, owner.webContents); owner.destroy(); await service.manager.shutdown();
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); console.log("HOST_REACT_RUNTIME_OK"); electron.app.exit(0);
  }).catch((error) => { console.error(error); electron.app.exit(1); });
}
