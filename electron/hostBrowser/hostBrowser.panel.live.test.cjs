"use strict";

// Run with: electron electron/hostBrowser/hostBrowser.panel.live.test.cjs
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");
const tempDirBridge = require("../bridges/tempDirBridge.cjs");
const { Server } = require("ssh2");
const electron = require("electron");
const { app, BrowserWindow, WebContentsView } = electron;
const portForwardingBridge = require("../bridges/portForwardingBridge.cjs");
const { createHostBrowserManager } = require("./hostBrowserManager.cjs");

async function waitFor(read, expected) {
  for (let index = 0; index < 100; index += 1) {
    if (await read() === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(await read(), expected);
}

async function fixture(label) {
  const sockets = new Set();
  const allowed = new Set();
  let connections = 0;
  const site = http.createServer((request, response) => {
    assert.ok(allowed.has(request.socket.remotePort), "page must arrive through its SSH host");
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<title>${label}</title><h1>${label}</h1>`);
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("authentication", (context) => context.method === "password" ? context.accept() : context.reject());
    client.on("ready", () => client.on("tcpip", (accept, reject, info) => {
      if (info.destPort !== site.address().port) return reject();
      connections += 1;
      const channel = accept();
      const target = net.connect(site.address().port, "127.0.0.1");
      target.once("connect", () => { allowed.add(target.localPort); channel.pipe(target).pipe(channel); });
      target.on("close", () => allowed.delete(target.localPort));
      target.on("error", () => channel.destroy());
      channel.on("error", () => target.destroy());
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    options: { hostId: label, type: "dynamic", hostname: "127.0.0.1", port: server.address().port,
      username: "test", authMethod: "password", password: "fixture", verifyHostKeys: false, knownHosts: [] },
    url: `http://localhost:${site.address().port}/`,
    connections: () => connections,
    close() { for (const socket of sockets) socket.end(); server.close(); site.closeAllConnections(); site.close(); },
  };
}

async function main() {
  const profile = fs.mkdtempSync(tempDirBridge.getTempFilePath("browser-panel-"));
  app.setPath("userData", profile);
  fs.mkdirSync(path.join(profile, "downloads"));
  app.setPath("downloads", path.join(profile, "downloads"));
  const a = await fixture("Host A");
  const b = await fixture("Host B");
  const owner = new BrowserWindow({ width: 1100, height: 760, show: true });
  await owner.loadURL("data:text/html,<h1>Terminal workspace</h1>");
  const ownerEvents = ["blur", "resize", "maximize", "unmaximize", "closed"];
  const beforeListeners = ownerEvents.map((name) => owner.listenerCount(name));
  const handlers = new Map();
  const manager = createHostBrowserManager({ electron: { ...electron, ipcMain: {
    handle(name, handler) { handlers.set(name, handler); electron.ipcMain.handle(name, handler); },
  } }, app, portForwardingBridge });
  const event = { sender: owner.webContents };
  const bounds = { x: 680, y: 110, width: 400, height: 590 };
  const layout = (browserId, visible, nextBounds = bounds) => manager.updatePanelLayout(event, { browserId, visible, bounds: nextBounds });
  const state = (id) => manager.getPanelState(event, id);
  const command = (id, input) => manager.runCommand(event, input, id);
  const call = (name, ...args) => handlers.get(`netcatty:host-browser:${name}`)(event, ...args);
  const rootFor = (url) => owner.contentView.children.find((view) => view.children.some((child) => child instanceof WebContentsView && child.webContents.getURL() === url));
  const open = async (id, host) => {
    manager.openPanelUrl(event, { browserId: id, url: host.url });
    layout(id, true);
    await manager.open(event, { browserId: id, embedded: true, hostId: host.options.hostId,
      label: host.options.hostId, theme: "light", connectionOptions: host.options });
    await waitFor(() => state(id).tabs[0].title, host.options.hostId);
    return rootFor(host.url);
  };
  const idA = "workspace:session-a";
  const rootA = await open(idA, a);
  assert.equal(rootA.children.length, 1, "embedded browser chrome must be part of the main renderer");
  const pageA = rootA.children[0];
  const pageContentsA = pageA.webContents;
  assert.equal(pageA.getBounds().y, 0, "the native view contains only the webpage viewport");
  await pageA.webContents.executeJavaScript("window.overlayProbe = 'keep this page'");
  const captured = await manager.updatePanelLayout(event, { browserId: idA, visible: true, occluded: true, bounds });
  assert.equal(owner.contentView.children.includes(rootA), false);
  assert.equal(captured.layers.length, 1);
  assert.equal(electron.nativeImage.createFromDataURL(captured.layers[0].image).isEmpty(), false);
  layout(idA, true);
  assert.equal(await pageA.webContents.executeJavaScript("window.overlayProbe"), "keep this page");
  let finishCapture;
  const originalCapture = pageA.webContents.capturePage.bind(pageA.webContents);
  pageA.webContents.capturePage = async () => { await new Promise((resolve) => { finishCapture = resolve; }); return originalCapture(); };
  const late = manager.updatePanelLayout(event, { browserId: idA, visible: true, occluded: true, bounds });
  assert.ok(finishCapture);
  layout(idA, true); finishCapture();
  assert.equal(await late, false);
  assert.equal(owner.contentView.children.includes(rootA), true);
  pageA.webContents.capturePage = originalCapture;
  layout(idA, false);
  const rootB = await open("workspace:session-b", b);
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  layout("workspace:session-b", false);
  layout(idA, true, { x: 20, y: 100, width: 350, height: 500 });
  assert.equal(owner.contentView.children.includes(rootB), false);
  assert.equal(state(idA).tabs[0].title, "Host A");
  for (let index = 0; index < 6; index++) await command(idA, { type: "new-tab" });
  assert.equal(state(idA).tabs.length, 7);
  const otherOwner = new BrowserWindow({ show: false });
  assert.throws(() => manager.getPanelState({ sender: otherOwner.webContents }, idA), /Untrusted/);
  assert.throws(() => manager.getPanelState({ sender: pageA.webContents }, idA), /Untrusted/);
  assert.throws(() => manager.updatePanelLayout({ sender: otherOwner.webContents }, { browserId: idA, visible: false }), /another terminal window/);
  assert.throws(() => manager.openPanelUrl(event, { browserId: idA, url: "file:\/\/\/etc/passwd" }), /HTTP and HTTPS/);
  otherOwner.destroy();
  const bookmark = call("bookmarks:upsert", { title: "Remote app", url: a.url, scope: "host" }, idA);
  assert.ok(call("bookmarks:list", idA).some((item) => item.id === bookmark.id));
  assert.equal(call("bookmarks:list", "workspace:session-b").some((item) => item.id === bookmark.id), false);
  await assert.rejects(command(idA, { type: "navigate", url: "file:///etc/passwd" }), /HTTP and HTTPS/);
  manager.closePanel(event, idA);
  await waitFor(() => pageContentsA.isDestroyed(), true);
  assert.equal(owner.webContents.isDestroyed(), false, "closing a browser must never close its main renderer");

  const localSite = http.createServer((request, response) => {
    if (request.url === '/slow.bin') { response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': 1048576 }); response.write(Buffer.alloc(16384)); return; }
    response.end('<title>Local browser</title>');
  });
  await new Promise((resolve) => localSite.listen(0, "127.0.0.1", resolve));
  const localUrl = `http://127.0.0.1:${localSite.address().port}/`;
  manager.openPanelUrl(event, { browserId: 'local:session', url: localUrl });
  layout('local:session', true);
  await manager.open(event, { browserId: 'local:session', embedded: true, local: true, hostId: 'local', label: 'Local', theme: 'light' });
  await waitFor(() => state('local:session').tabs[0].title, 'Local browser');
  assert.equal(state('local:session').tabs.length, 1);
  const localPage = rootFor(localUrl).children[0];
  layout('local:peer', true);
  await manager.open(event, { browserId: 'local:peer', embedded: true, local: true, hostId: 'local', label: 'Peer', theme: 'light' });
  let download;
  const startDownload = async () => {
    download = undefined;
    localPage.webContents.session.once('will-download', (_event, item) => { download = item; });
    localPage.webContents.downloadURL(`${localUrl}slow.bin`);
    await waitFor(() => Boolean(download), true);
  };
  await startDownload();
  const items = call('downloads:list', 'local:peer');
  assert.ok(items.some((item) => item.status === 'progressing' || item.status === 'waiting'));
  let cancelled = false;
  download.once('done', (_event, status) => { cancelled = status === 'cancelled'; });
  await call('downloads:command', { type: 'cancel', id: items[0].id }, 'local:peer');
  await waitFor(() => cancelled, true);
  manager.closePanel(event, 'local:peer');
  await startDownload(); cancelled = false;
  download.once('done', (_event, status) => { cancelled = status === 'cancelled'; });
  manager.closePanel(event, 'local:session');
  await waitFor(() => cancelled, true);
  assert.equal(owner.webContents.isDestroyed(), false);
  manager.closeAll(); localSite.closeAllConnections(); localSite.close();
  assert.deepEqual(ownerEvents.map((name) => owner.listenerCount(name)), beforeListeners);
  owner.destroy(); a.close(); b.close();
  console.log(JSON.stringify({ ok: true, rendererChrome: true, hostSwitching: true, pageRetention: true, scopedControls: true, downloads: true }));
  app.quit();
}
app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1); });
