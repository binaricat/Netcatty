"use strict";
if (!process.versions.electron) {
  require("node:test")("database plugin UI and real sandbox", { skip: "requires Electron, Docker and Vite on port 5182" }, () => {});
} else {
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { EventEmitter } = require("node:events");
  const { execFileSync } = require("node:child_process");
  const { randomBytes, randomUUID } = require("node:crypto");
  const electron = require("electron");
  const { createPluginHostService } = require("./hostService.cjs");
  const { registerPluginBridge } = require("./pluginBridge.cjs");
  const { PLUGIN_PROTOCOL_SCHEME } = require("./constants.cjs");
  const { sshForwardFixture } = require("./fixtures/sshForwardFixture.cjs");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-host-db-ui-"));
  electron.app.setPath("userData", directory);
  electron.app.on("window-all-closed", () => {});
  electron.protocol.registerSchemesAsPrivileged([{ scheme: PLUGIN_PROTOCOL_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } }]);
  const cleanup = [];
  const docker = (args, input) => execFileSync("docker", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 60_000 }).trim();
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  void electron.app.whenReady().then(async () => {
    const container = `netcatty-db-ui-${randomUUID().slice(0, 8)}`;
    docker(["run", "--detach", "--rm", "--name", container, "-p", "127.0.0.1::3306", "--env", "MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=1", "mariadb:11.4@sha256:250e1609e93c0e6aecf64bfbab2d84d5e89d2481540fe77447ff6c855c3b1873"]);
    cleanup.push(() => docker(["rm", "--force", container]));
    let ready = false;
    for (let i = 0; i < 90; i++) {
      try { docker(["exec", container, "mariadb-admin", "--host=127.0.0.1", "ping", "--silent"]); ready = true; break; }
      catch { await delay(500); }
    }
    assert.ok(ready);
    const password = randomBytes(20).toString("hex");
    docker(["exec", "--interactive", container, "mariadb", "--user=root"], `CREATE DATABASE plugin_demo; CREATE TABLE plugin_demo.items (id INT PRIMARY KEY, value VARCHAR(64)); CREATE USER 'plugin_demo'@'%' IDENTIFIED BY '${password}'; GRANT SELECT,INSERT,UPDATE,DELETE ON plugin_demo.* TO 'plugin_demo'@'%';`);
    const port = Number(docker(["port", container, "3306/tcp"]).split(":")[1]);
    const ssh = await sshForwardFixture({ after: (fn) => cleanup.push(fn) }, { destinationPort: port });
    const owner = new electron.BrowserWindow({ show: true, width: 1100, height: 1050, title: "数据库插件验证", webPreferences: { sandbox: true, contextIsolation: true, preload: path.join(__dirname, "fixtures/hostDatabasePreload.cjs") } });
    cleanup.push(() => owner.destroy());
    const appRoot = path.resolve(__dirname, "../..");
    const runtimeRoot = path.join(directory, "runtime-app");
    const runtimeDirectory = path.join(runtimeRoot, "electron/plugins/runtime");
    for (const name of ["plugin-contract", "plugin-sdk"]) fs.cpSync(path.join(appRoot, "node_modules/@netcatty", name, "dist"), path.join(runtimeRoot, "node_modules/@netcatty", name, "dist"), { recursive: true });
    fs.cpSync(path.join(__dirname, "runtime"), runtimeDirectory, { recursive: true });
    // OS focus belongs to the user's desktop while automation runs. The real
    // focus/blur guard is covered by hostInteractionService tests; keep this
    // renderer/IPC/sandbox integration deterministic without stealing focus.
    const interactionOwner = Object.assign(new EventEmitter(), { webContents: owner.webContents,
      isFocused: () => true, isVisible: () => true, isDestroyed: () => owner.isDestroyed() });
    const service = createPluginHostService({ app: electron.app, electron, appRoot: runtimeRoot, runtimeDirectory,
      getInteractionWindow: () => interactionOwner, isAppLocked: () => false,
      requestPermissionDecision: async (request) => ({ requestId: request.requestId, decision: "allow", scope: "once" }),
    });
    cleanup.push(() => service.manager.shutdown());
    await service.manager.initialize();
    const { buildPluginPackage } = await import("@netcatty/plugin-cli");
    const archive = path.join(directory, "database.ncpkg");
    await buildPluginPackage(path.join(appRoot, "examples/plugins/database-host/.package"), archive);
    await service.manager.install(archive, { enable: true });
    await service.runtimeSupervisor.start("com.netcatty.database-host");
    electron.ipcMain.handle("fixture:configuration", (event) => {
      assert.equal(event.sender, owner.webContents);
      return { host: { id: "fixture-host", label: "临时测试服务器", hostname: "127.0.0.1", username: "fixture", port: ssh.options.port, password: ssh.options.password, protocol: "ssh", authMethod: "password", tags: [], os: "linux" } };
    });
    registerPluginBridge(electron.ipcMain, { ...service, isTrustedSender: (event) => !owner.isDestroyed() && event.sender === owner.webContents && event.senderFrame === owner.webContents.mainFrame });
    const evaluate = (code) => owner.webContents.executeJavaScript(code);
    const wait = async (expression) => {
      for (let i = 0; i < 300; i++) { if (await evaluate(`Boolean(${expression})`)) return; await delay(30); }
      console.log("Fixture stream count:", service.byteStreamService.records.size);
      console.log("Fixture HTML:", await evaluate("document.body.innerHTML + (window.testPluginShadow?.innerHTML || 'no shadow')"));
      throw new Error(`UI condition failed: ${expression}; ${await evaluate("document.body.innerText + (window.testPluginShadow?.textContent || '')")}`);
    };
    let requestTime = Date.now();
    service.interactionService.clock = () => requestTime;
    await owner.loadURL("http://localhost:5182/scripts/fixtures/host-plugin-database.html");

    await wait("window.testPluginShadow?.querySelector('#connect')");
    const set = async (id, value) => evaluate(`(()=>{const element=window.testPluginShadow.getElementById(${JSON.stringify(id)});element.value=${JSON.stringify(value)};element.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await set("endpoint", `tcp://127.0.0.1:${port}`);
    await set("password", password);
    await delay(100);
    await evaluate("window.testPluginShadow.getElementById('connect').click()");
    await wait("document.querySelector('[role=option]')");
    await evaluate("document.querySelector('[role=option]').click()");
    await wait("[...document.querySelectorAll('button')].some(b => b.textContent.startsWith('继续') && !b.disabled)");
    await evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.startsWith('继续') && !b.disabled).click()");
    await wait("document.querySelector('[role=dialog]')?.textContent.includes('不打开终端')");
    const confirmation = await evaluate("document.querySelector('[role=dialog]').textContent");
    assert.ok(confirmation.includes(`tcp://127.0.0.1:${port}`));
    assert.equal(confirmation.includes(password), false);
    assert.equal(confirmation.includes(ssh.options.password), false);
    await delay(150);
    if (process.env.NETCATTY_HOST_STREAM_SCREENSHOT) fs.writeFileSync(`${process.env.NETCATTY_HOST_STREAM_SCREENSHOT}-confirm.png`, (await owner.capturePage()).toPNG());
    await evaluate("[...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent === '连接').click()");
    await wait("window.testPluginShadow?.getElementById('status')?.textContent.startsWith('已连接')");
    assert.equal(await evaluate("window.testPluginShadow.getElementById('password').value"), "");
    for (const [sql, expected] of [
      ["INSERT INTO items VALUES (1, 'created')", '"affectedRows": 1'],
      ["SELECT value FROM items", '"created"'],
      ["UPDATE items SET value = 'updated' WHERE id = 1", '"affectedRows": 1'],
      ["SELECT value FROM items", '"updated"'],
      ["DELETE FROM items WHERE id = 1", '"affectedRows": 1'],
    ]) {
      requestTime += 60_001;
      await set("sql", sql);
      await evaluate("window.testPluginShadow.getElementById('execute').click()");
      await wait("document.querySelector('input[type=radio][value=execute]')");
      await evaluate("document.querySelector('input[type=radio][value=execute]').click()");
      await evaluate("[...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent === '继续').click()");
      await wait("!window.testPluginShadow.getElementById('execute').disabled");
      assert.ok((await evaluate("window.testPluginShadow.getElementById('result').textContent")).includes(expected));
    }
    await delay(150);
    if (process.env.NETCATTY_HOST_STREAM_SCREENSHOT) fs.writeFileSync(`${process.env.NETCATTY_HOST_STREAM_SCREENSHOT}-result.png`, (await owner.capturePage()).toPNG());
    await evaluate("window.testPluginShadow.getElementById('disconnect').click()");
    await wait("window.testPluginShadow.getElementById('status').textContent === '已断开'");
    assert.equal(service.byteStreamService.records.size, 0);
    assert.equal(ssh.sessions, 0);
    await owner.loadURL("http://localhost:5182/scripts/fixtures/host-plugin-database.html?surface=sidebar");
    await wait("window.testPluginShadow?.querySelector('#connect')");
    assert.equal(await evaluate("window.testPluginShadow.querySelector('main').scrollWidth <= window.testPluginShadow.querySelector('main').clientWidth"), true);
    await owner.loadURL("about:blank");
    await delay(100);
    console.log("PASS: real sandbox, native server selection and destination confirmation, database CRUD, password clearing, disconnect and sidebar rendering");
  }).then(async () => {
    for (const fn of cleanup.reverse()) await fn();
    fs.rmSync(directory, { recursive: true, force: true }); electron.app.exit(0);
  }).catch(async (error) => {
    console.error(error);
    for (const fn of cleanup.reverse()) { try { await fn(); } catch {} }
    fs.rmSync(directory, { recursive: true, force: true }); electron.app.exit(1);
  });
}
