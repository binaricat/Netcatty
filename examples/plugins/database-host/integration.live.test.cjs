"use strict";
/* global __dirname */
// Disposable fixtures only: no user hosts, credentials or databases are read.
const process = require("node:process");
const { setTimeout, setImmediate } = require("node:timers");
const assert = require("node:assert/strict");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { randomBytes, randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createPluginHostService } = require("../../../electron/plugins/hostService.cjs");
const { inProcessBrowserRuntime } = require("../../../electron/plugins/fixtures/inProcessBrowserRuntime.cjs");
const { sshForwardFixture } = require("../../../electron/plugins/fixtures/sshForwardFixture.cjs");
const IMAGE = "mariadb:11.4@sha256:250e1609e93c0e6aecf64bfbab2d84d5e89d2481540fe77447ff6c855c3b1873";
const docker = (args, input) => execFileSync("docker", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 60_000 }).trim();

test("installed database plugin selects a host and performs real MariaDB CRUD over SSH", {
  skip: process.env.NETCATTY_HOST_STREAM_DATABASE_TEST !== "1", timeout: 180_000,
}, async (t) => {
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const previous = new Map();
  for (const key of ["window", "document", "MutationObserver", "HTMLElement", "Element", "Node", "Text", "customElements"]) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value: key === "window" ? dom.window : dom.window[key] });
  }
  t.after(() => { dom.window.close(); for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const container = `netcatty-host-db-${randomUUID().slice(0, 8)}`;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "netcatty-host-db-"));
  const password = randomBytes(24).toString("hex");
  let service;
  let created = false;
  t.after(async () => {
    await service?.manager.shutdown();
    if (created) docker(["rm", "--force", container]);
    await fs.rm(root, { recursive: true, force: true });
  });
  docker(["run", "--detach", "--rm", "--name", container, "-p", "127.0.0.1::3306", "--env", "MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=1", IMAGE]);
  created = true;
  let ready = false;
  for (let i = 0; i < 90; i++) {
    try { docker(["exec", container, "mariadb-admin", "--host=127.0.0.1", "ping", "--silent"]); ready = true; break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 500)); }
  }
  assert.ok(ready, "disposable database starts");
  docker(["exec", "--interactive", container, "mariadb", "--user=root"], `
CREATE DATABASE plugin_demo;
CREATE TABLE plugin_demo.items (id INT PRIMARY KEY, value VARCHAR(64));
CREATE USER 'plugin_demo'@'%' IDENTIFIED BY '${password}';
GRANT SELECT, INSERT, UPDATE, DELETE ON plugin_demo.* TO 'plugin_demo'@'%';
CREATE USER 'plugin_reader'@'%' IDENTIFIED BY '${password}';
GRANT SELECT ON plugin_demo.* TO 'plugin_reader'@'%';
`);
  const mapping = docker(["port", container, "3306/tcp"]);
  assert.match(mapping, /^127\.0\.0\.1:\d+$/u);
  const port = Number(mapping.split(":")[1]);
  const ssh = await sshForwardFixture(t, { destinationPort: port });
  const endpoint = `tcp://127.0.0.1:${port}`;
  const prompts = [], responseErrors = [];
  let cancelOpen = false, tamperHost = false;
  const sender = Object.assign(new EventEmitter(), { id: 501, isDestroyed: () => false,
    send(channel, prompt) {
      if (channel !== "netcatty:plugins:host-interaction" || prompt.closed) return;
      prompts.push(prompt);
      setImmediate(() => { void (async () => {
        const response = { requestId: prompt.requestId, actionToken: prompt.actionToken, action: "submit" };
        if (prompt.request.kind === "vault.selectHosts") response.resources = [{ resourceId: "fixture-host", revision: "revision-one", label: "Disposable SSH", hostname: "127.0.0.1", username: "fixture", port: ssh.options.port, protocol: "ssh", tags: [], group: "" }];
        if (prompt.request.kind === "network.stream.connectViaHost") {
          assert.equal(prompt.request.endpoint, endpoint);
          if (cancelOpen) response.action = "cancel";
          else if (prompt.phase === "commit") {
            response.action = "commit";
            return service.interactionService.respond(sender, response, { ...ssh.options, ...(tamperHost ? { hostId: "other-host" } : {}) });
          }
        }
        if (prompt.request.kind === "quickPick") response.value = "execute";
        return service.interactionService.respond(sender, response);
      })().catch((error) => responseErrors.push(error)); });
    },
  });
  const owner = Object.assign(new EventEmitter(), { webContents: sender, isFocused: () => true, isVisible: () => true, isDestroyed: () => false });
  const locks = new Set();
  service = createPluginHostService({
    app: { getAppPath: () => process.cwd(), getPath: () => root, getVersion: () => "0.0.0" }, electron: {}, env: {},
    getInteractionWindow: () => owner, isAppLocked: () => false,
    subscribeAppLock: (fn) => { locks.add(fn); return () => locks.delete(fn); },
    requestPermissionDecision: async (request) => ({ requestId: request.requestId, decision: "allow", scope: "once" }),
  });
  service.runtimeSupervisor.runtimeFactories.browser = inProcessBrowserRuntime;
  await service.manager.initialize();
  const { buildPluginPackage } = await import("@netcatty/plugin-cli");
  const archive = path.join(root, "database.ncpkg");
  await buildPluginPackage(path.join(__dirname, ".package"), archive);
  await service.manager.install(archive, { enable: true });
  service.interactionService.setReady(sender, true);
  let requestTime = Date.now();
  service.interactionService.clock = () => requestTime;
  const command = (name, args) => { requestTime += 60_001; return service.contributionService.executeCommand(`com.netcatty.database-host.${name}`, args); };
  const connect = (username = "plugin_demo") => command("connect", { endpoint, username, password, database: "plugin_demo" });
  const query = (sql) => command("query", { sql });
  assert.equal((await connect()).connected, true);
  assert.equal((await query("INSERT INTO items VALUES (1, 'created')")).affectedRows, 1);
  assert.deepEqual((await query("SELECT id, value FROM items")).rows, [["1", "created"]]);
  assert.equal((await query("UPDATE items SET value = 'updated' WHERE id = 1")).affectedRows, 1);
  assert.deepEqual((await query("SELECT value FROM items")).rows, [["updated"]]);
  assert.equal((await query("DELETE FROM items WHERE id = 1")).affectedRows, 1);
  assert.deepEqual((await query("SELECT value FROM items")).rows, []);
  await command("disconnect");
  assert.equal(service.byteStreamService.records.size, 0);
  assert.equal(ssh.sessions, 0);
  assert.equal(responseErrors.length, 0);
  await connect("plugin_reader");
  await assert.rejects(query("INSERT INTO items VALUES (2, 'denied')"));
  assert.equal(docker(["exec", container, "mariadb", "--user=root", "--skip-column-names", "--execute=SELECT COUNT(*) FROM plugin_demo.items"]), "0");
  assert.equal(service.byteStreamService.records.size, 0);
  await connect();
  for (const callback of locks) callback({ locked: true });
  assert.equal(service.byteStreamService.records.size, 0, "app lock closes the stream");
  await command("disconnect");
  cancelOpen = true;
  const before = ssh.forwarded.length;
  await assert.rejects(connect());
  assert.equal(ssh.forwarded.length, before, "cancel does not connect");
  cancelOpen = false; tamperHost = true;
  await assert.rejects(connect());
  assert.equal(ssh.forwarded.length, before, "a different server cannot use the reviewed token");
  const audit = JSON.stringify(service.database.listSecurityAudit("com.netcatty.database-host", 500));
  assert.equal(audit.includes(password), false);
  assert.equal(audit.includes(ssh.options.password), false);
  assert.equal(audit.includes("INSERT INTO"), false);
  assert.ok(prompts.some((prompt) => prompt.request.kind === "network.stream.connectViaHost"));
});
