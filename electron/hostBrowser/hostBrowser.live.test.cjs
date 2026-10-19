"use strict";

// Run with: electron electron/hostBrowser/hostBrowser.live.test.cjs
const assert = require("node:assert/strict");
const net = require("node:net");
const tempDirBridge = require("../bridges/tempDirBridge.cjs");
const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, WebContentsView, session, ipcMain } = require("electron");
const { createHostBrowserManager } = require("./hostBrowserManager.cjs");
const { createSiteIconStore } = require("./siteIconStore.cjs");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const received = [];
const listeners = new Set();
const favicon = require("node:fs").readFileSync(path.join(__dirname, "../../public/icon.png"));

async function captureView(view, file) {
  try {
    fs.writeFileSync(file, (await view.webContents.capturePage()).toPNG());
    return file;
  } catch (error) {
    if (error?.message === "UnknownVizError") return null;
    throw error;
  }
}

function reply(socket, request) {
  if (request.toString().startsWith("GET /slow.bin ")) {
    socket.write(Buffer.from("HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=\"slow.bin\"\r\nContent-Length: 1048576\r\nConnection: close\r\n\r\n"));
    socket.write(Buffer.alloc(16384, 42));
    return;
  }
  if (request.toString().startsWith("GET /download.bin ")) {
    const body = Buffer.from("Netcatty host browser download through SOCKS5\n");
    socket.write(Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="host-browser-test.bin"\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`));
    socket.end(body);
    return;
  }
  const icon = request.toString().startsWith("GET /favicon.ico ");
  const body = icon ? favicon : Buffer.from('<link rel="icon" href="/favicon.ico"><title>Host route verified</title><h1>Via host</h1>');
  socket.write(Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: ${icon ? "image/png" : "text/html"}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`));
  socket.end(body);
}

function makeSocksServer() {
  return net.createServer((socket) => {
    let stage = "greeting";
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      if (stage === "done") {
        reply(socket, chunk);
        stage = "replied";
        return;
      }
      if (stage === "replied") return;
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === "greeting" && buffer.length >= 2 + buffer[1]) {
        buffer = buffer.subarray(2 + buffer[1]);
        socket.write(Buffer.from([5, 0]));
        stage = "request";
      }
      if (stage === "request" && buffer.length >= 5) {
        const len = buffer[3] === 3 ? 1 + buffer[4] : buffer[3] === 4 ? 16 : 4;
        if (buffer.length < 4 + len + 2) return;
        received.push(buffer[3] === 3 ? buffer.subarray(5, 4 + len).toString() : "ip");
        buffer = buffer.subarray(4 + len + 2);
        socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
        stage = "done";
        if (buffer.length) {
          reply(socket, buffer);
          stage = "replied";
        }
      }
    });
  });
}

async function main() {
  const profile = fs.mkdtempSync(tempDirBridge.getTempFilePath("browser-standalone-"));
  app.setPath("userData", profile);
  fs.mkdirSync(path.join(profile, "downloads"));
  app.setPath("downloads", path.join(profile, "downloads"));
  const socks = makeSocksServer();
  await new Promise((resolve) => socks.listen(0, "127.0.0.1", resolve));
  const port = socks.address().port;
  const source = new BrowserWindow({ show: false });
  const bridge = {
    failNext: false,
    stopped: 0,
    async startPortForward(_event, options) {
      assert.equal(options.reuseTransport, false);
      assert.equal(options.localPort, 0);
      bridge.lastTunnelId = options.tunnelId;
      if (bridge.failNext) { bridge.failNext = false; return { success: false, error: "SSH unavailable" }; }
      return { success: true, localPort: port };
    },
    async stopPortForward() { bridge.stopped += 1; return { success: true }; },
    onTunnelStatus(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const shellActions = [];
  const shell = {
    async openPath(file) { shellActions.push(["open", file]); return ""; },
    showItemInFolder(file) { shellActions.push(["reveal", file]); },
  };
  const manager = createHostBrowserManager({ electron: { BrowserWindow, WebContentsView, session, ipcMain, shell }, app, portForwardingBridge: bridge });
  await manager.open({ sender: source.webContents }, {
    hostId: "live-host", label: "Live Test Host", theme: "dark",
    themeTokens: { primary: "170 80% 40%", background: "220 28% 8%" },
    connectionOptions: { hostId: "live-host", type: "dynamic", hostname: "fixture", username: "test" },
  });
  const browser = BrowserWindow.getAllWindows().find((win) => win !== source);
  assert.ok(browser);
  const page = browser.webContents;
  const snapshot = () => page.executeJavaScript("window.hostBrowser.snapshot()");
  assert.equal((await snapshot()).route, "connected");
  assert.equal(await page.executeJavaScript("getComputedStyle(document.body).getPropertyValue('--primary').trim()"), "170 80% 40%");
  assert.equal((await snapshot()).tabs.length, 1);
  await page.executeJavaScript("document.getElementById('add-app').click()");
  await page.executeJavaScript("document.querySelector('[data-icon-mode=text]').click();document.getElementById('bookmark-title').value='My app';document.getElementById('bookmark-url').value='http://example.invalid:3000';document.getElementById('bookmark-icon').value='\u2726';document.getElementById('bookmark-form').requestSubmit()");
  await wait(300);
  assert.equal(await page.executeJavaScript("document.querySelectorAll('.app-tile').length"), 1);
  await page.executeJavaScript("document.querySelector('.bookmark-row button[title=Edit]').click()");
  assert.equal(await page.executeJavaScript("document.getElementById('bookmark-form-heading').textContent"), "Edit app");
  assert.equal(await page.executeJavaScript("document.querySelector('[data-icon-mode=text]').getAttribute('aria-pressed')"), "true");
  await page.executeJavaScript("document.querySelector('[data-icon-mode=website]').click()");
  assert.equal(await page.executeJavaScript("document.getElementById('bookmark-text-options').hidden"), true);
  await page.executeJavaScript("document.querySelector('[data-icon-mode=image]').click()");
  assert.equal(await page.executeJavaScript("document.getElementById('bookmark-image-options').hidden"), false);
  await page.executeJavaScript(`{
    const bytes = Uint8Array.from(atob("${favicon.toString("base64")}"), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "icon.png", { type: "image/png" }));
    const input = document.getElementById('bookmark-image');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }`);
  for (let i = 0; i < 20 && !(await page.executeJavaScript("document.querySelector('#bookmark-icon-preview img')?.src.startsWith('data:image/png;base64,')")); i += 1) await wait(100);
  assert.equal(await page.executeJavaScript("document.querySelector('#bookmark-icon-preview img')?.src.startsWith('data:image/png;base64,')"), true);
  await page.executeJavaScript("document.querySelector('[data-icon-mode=text]').click();document.querySelector('[data-scope=all-hosts]').click()");
  assert.equal(await page.executeJavaScript("document.getElementById('bookmark-scope').value"), "all-hosts");
  await page.executeJavaScript("document.querySelector('[data-scope=host]').click()");
  const formScreenshot = path.join(profile, "netcatty-host-browser-app-form.png");
  fs.writeFileSync(formScreenshot, (await page.capturePage()).toPNG());
  await page.executeJavaScript("document.getElementById('bookmark-back').click()");
  await page.executeJavaScript("document.querySelector('.app-tile').click()");
  for (let i = 0; i < 50 && !(await snapshot()).tabs[0].title.includes("Host route verified"); i += 1) await wait(100);
  assert.ok(received.includes("example.invalid"), `SOCKS requests: ${received.join(",")}`);
  assert.equal((await snapshot()).tabs[0].title, "Host route verified");
  for (let i = 0; i < 50 && !(await snapshot()).tabs[0].iconDataUrl; i += 1) await wait(100);
  assert.match((await snapshot()).tabs[0].iconDataUrl || "", /^data:image\/png;base64,/);
  assert.equal(await page.executeJavaScript("document.querySelector('.app-tile .app-icon').textContent"), "\u2726");
  assert.match(createSiteIconStore(app).get("live-host", "http://example.invalid:3000/")?.dataUrl || "", /^data:image\/png;base64,/);
  await page.executeJavaScript("document.getElementById('downloads-menu').click()");
  for (let i = 0; i < 30 && !(await snapshot()).downloadsPanelOpen; i += 1) await wait(100);
  assert.equal((await snapshot()).downloadsPanelOpen, true);
  assert.equal(browser.contentView.children.length, 2);
  const downloadsView = browser.contentView.children[1];
  assert.equal(await downloadsView.webContents.executeJavaScript("document.getElementById('empty').hidden"), false);
  assert.ok(downloadsView.getBounds().height < 300);
  const downloadsScreenshot = await captureView(downloadsView, path.join(profile, "netcatty-host-browser-downloads.png"));
  const downloadPath = path.join(app.getPath("downloads"), "host-browser-test.bin");
  const websiteView = browser.contentView.children[0];
  browser.contentView.children[0].webContents.downloadURL("http://example.invalid:3000/download.bin");
  for (let i = 0; i < 50 && !(await page.executeJavaScript("window.hostBrowser.listDownloads()")).some((item) => item.status === "completed"); i += 1) await wait(100);
  const downloaded = (await page.executeJavaScript("window.hostBrowser.listDownloads()"))[0];
  assert.equal(downloaded.status, "completed");
  assert.equal(downloaded.filename, "host-browser-test.bin");
  assert.equal(fs.readFileSync(downloadPath, "utf8"), "Netcatty host browser download through SOCKS5\n");
  assert.equal(await downloadsView.webContents.executeJavaScript("document.querySelectorAll('.download-row').length"), 1);
  await downloadsView.webContents.executeJavaScript("document.querySelector('.row-actions button[title=\"Show in folder\"]').click()");
  for (let i = 0; i < 20 && shellActions.length < 1; i += 1) await wait(50);
  assert.deepEqual(shellActions[0], ["reveal", downloadPath]);
  await downloadsView.webContents.executeJavaScript("document.querySelector('.row-actions button[title=\"More actions\"]').click();document.querySelector('.row-menu button').click()");
  for (let i = 0; i < 20 && shellActions.length < 2; i += 1) await wait(50);
  assert.deepEqual(shellActions[1], ["open", downloadPath]);
  await downloadsView.webContents.executeJavaScript("document.getElementById('open-folder').click()");
  for (let i = 0; i < 20 && shellActions.length < 3; i += 1) await wait(50);
  assert.deepEqual(shellActions[2], ["open", app.getPath("downloads")]);
  websiteView.webContents.downloadURL("http://example.invalid:3000/slow.bin");
  for (let i = 0; i < 40 && !(await page.executeJavaScript("window.hostBrowser.listDownloads()")).some((item) => item.filename === "slow.bin" && item.status === "progressing"); i += 1) await wait(100);
  assert.equal((await page.executeJavaScript("window.hostBrowser.listDownloads()")).some((item) => item.filename === "slow.bin" && item.status === "progressing"), true);
  await downloadsView.webContents.executeJavaScript("document.querySelector('button[title=\"Cancel download\"]').click()");
  for (let i = 0; i < 40 && !(await page.executeJavaScript("window.hostBrowser.listDownloads()")).some((item) => item.filename === "slow.bin" && item.status === "cancelled"); i += 1) await wait(100);
  assert.equal((await page.executeJavaScript("window.hostBrowser.listDownloads()")).some((item) => item.filename === "slow.bin" && item.status === "cancelled"), true);
  const downloadedScreenshot = await captureView(downloadsView, path.join(profile, "netcatty-host-browser-downloaded.png"));
  assert.equal(downloaded.missing, false);
  await downloadsView.webContents.executeJavaScript("document.getElementById('clear').click()");
  for (let i = 0; i < 20 && (await page.executeJavaScript("window.hostBrowser.listDownloads()")).length; i += 1) await wait(100);
  assert.equal((await page.executeJavaScript("window.hostBrowser.listDownloads()")).length, 0);
  assert.equal(fs.existsSync(downloadPath), true);
  fs.unlinkSync(downloadPath);
  await downloadsView.webContents.executeJavaScript("document.getElementById('close').click()");
  for (let i = 0; i < 20 && (await snapshot()).downloadsPanelOpen; i += 1) await wait(100);
  assert.equal((await snapshot()).downloadsPanelOpen, false);
  await page.executeJavaScript("document.querySelector('.tab').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:80,clientY:25}))");
  await page.executeJavaScript("document.getElementById('tab-icon-change').click();document.getElementById('tab-icon-text').value='\u2726';document.getElementById('tab-icon-save').click()");
  for (let i = 0; i < 30 && (await snapshot()).tabs[0].iconGlyph !== "\u2726"; i += 1) await wait(100);
  assert.equal((await snapshot()).tabs[0].iconGlyph, "\u2726");
  assert.equal(createSiteIconStore(app).get("live-host", "http://example.invalid:3000/")?.mode, "custom");
  await page.executeJavaScript("document.querySelector('.tab').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:80,clientY:25}));document.getElementById('tab-icon-reset').click()");
  for (let i = 0; i < 50 && !(await snapshot()).tabs[0].iconDataUrl; i += 1) await wait(100);
  assert.equal(createSiteIconStore(app).get("live-host", "http://example.invalid:3000/")?.mode, "auto");
  assert.equal(await page.executeJavaScript("Boolean(document.querySelector('.tab .tab-favicon'))"), true);
  websiteView.webContents.focus();
  websiteView.webContents.sendInputEvent({ type: "keyDown", keyCode: "L", modifiers: ["meta"] });
  for (let i = 0; i < 20 && !(await page.executeJavaScript("document.activeElement === document.getElementById('address')")); i += 1) await wait(100);
  assert.equal(await page.executeJavaScript("document.activeElement === document.getElementById('address')"), true);
  await page.executeJavaScript("document.getElementById('new-tab').click()");
  await wait(100);
  assert.equal((await snapshot()).tabs.length, 2);
  assert.equal(await page.executeJavaScript("document.getElementById('address').value"), "");
  const [websiteTab, newTab] = (await snapshot()).tabs;
  await page.executeJavaScript(`window.hostBrowser.command({type:'reorder',tabId:'${newTab.id}',beforeTabId:'${websiteTab.id}'})`);
  assert.equal((await snapshot()).tabs[0].id, newTab.id);
  await page.executeJavaScript(`window.hostBrowser.command({type:'reorder',tabId:'${websiteTab.id}',beforeTabId:'${newTab.id}'})`);
  assert.equal(await page.executeJavaScript("!document.getElementById('home').hidden"), true);
  await page.executeJavaScript("document.getElementById('bookmarks-menu').click()");
  assert.equal(await page.executeJavaScript("!document.getElementById('bookmark-panel').hidden"), true);
  await page.executeJavaScript("document.getElementById('bookmarks-menu').click()");
  await wait(100);
  assert.equal(await page.executeJavaScript("document.getElementById('bookmark-panel').hidden"), true);
  await page.executeJavaScript("document.getElementById('bookmarks-menu').click()");
  await wait(100);
  assert.equal(await page.executeJavaScript("document.getElementById('add-app').getBoundingClientRect().right <= document.getElementById('bookmark-panel').getBoundingClientRect().left"), true);
  const screenshot = path.join(profile, "netcatty-host-browser-live.png");
  require("node:fs").writeFileSync(screenshot, (await page.capturePage()).toPNG());
  browser.setSize(720, 500);
  await wait(100);
  assert.equal(await page.executeJavaScript("document.getElementById('add-app').getBoundingClientRect().right <= document.getElementById('bookmark-panel').getBoundingClientRect().left"), true);
  assert.equal(await page.executeJavaScript("document.getElementById('address').getBoundingClientRect().width > 80"), true);
  browser.setSize(1100, 760);
  await manager.open({ sender: source.webContents }, {
    hostId: "live-host", label: "Live Test Host", theme: "light",
    connectionOptions: { hostId: "live-host", type: "dynamic", hostname: "fixture", username: "test" },
  });
  assert.equal((await snapshot()).theme, "light");
  const lightScreenshot = path.join(profile, "netcatty-host-browser-live-light.png");
  require("node:fs").writeFileSync(lightScreenshot, (await page.capturePage()).toPNG());
  await page.executeJavaScript("document.getElementById('downloads-menu').click()");
  for (let i = 0; i < 20 && !(await snapshot()).downloadsPanelOpen; i += 1) await wait(100);
  assert.equal(await downloadsView.webContents.executeJavaScript("document.body.classList.contains('dark')"), false);
  const lightDownloadsScreenshot = await captureView(downloadsView, path.join(profile, "netcatty-host-browser-downloads-light.png"));
  await downloadsView.webContents.executeJavaScript("document.getElementById('close').click()");
  assert.equal(browser.isMinimizable(), true);
  assert.equal(browser.isMaximizable(), true);
  await page.executeJavaScript("window.hostBrowser.command({type:'window-maximize'})");
  for (let i = 0; i < 20 && !browser.isMaximized(); i += 1) await wait(100);
  assert.equal(browser.isMaximized(), true);
  await page.executeJavaScript("window.hostBrowser.command({type:'window-maximize'})");
  for (let i = 0; i < 20 && browser.isMaximized(); i += 1) await wait(100);
  assert.equal(browser.isMaximized(), false);
  await page.executeJavaScript("window.hostBrowser.command({type:'window-minimize'})");
  for (let i = 0; i < 20 && !browser.isMinimized(); i += 1) await wait(100);
  assert.equal(browser.isMinimized(), true);
  browser.restore();
  await page.executeJavaScript("document.querySelector('.tab').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:80,clientY:25}));document.getElementById('tab-icon-change').click()");
  await page.executeJavaScript(`{
    const bytes = Uint8Array.from(atob("${favicon.toString("base64")}"), (char) => char.charCodeAt(0));
    const file = new File([bytes], "icon.png", { type: "image/png" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    document.getElementById('tab-icon-image').files = transfer.files;
    document.getElementById('tab-icon-text').value = '';
    document.getElementById('tab-icon-save').click();
  }`);
  for (let i = 0; i < 30 && (await snapshot()).tabs[0].iconGlyph; i += 1) await wait(100);
  assert.match((await snapshot()).tabs[0].iconDataUrl || "", /^data:image\/png;base64,/);
  assert.equal(createSiteIconStore(app).get("live-host", "http://example.invalid:3000/")?.mode, "custom");
  const route = await snapshot();
  for (const listener of listeners) listener({ tunnelId: bridge.lastTunnelId, status: "inactive" });
  for (let i = 0; i < 30 && (await snapshot()).route !== "disconnected"; i += 1) await wait(100);
  assert.equal((await snapshot()).route, "disconnected");
  assert.equal(await page.executeJavaScript("!document.getElementById('retry').hidden"), true);
  await page.executeJavaScript("document.getElementById('retry').click()");
  for (let i = 0; i < 30 && (await snapshot()).route !== "connected"; i += 1) await wait(100);
  assert.equal((await snapshot()).route, "connected");
  bridge.failNext = true;
  await manager.open({ sender: source.webContents }, {
    hostId: "failure-host", label: "Failure Host", theme: "dark",
    connectionOptions: { hostId: "failure-host", type: "dynamic", hostname: "fixture", username: "test" },
  });
  const failedWindow = BrowserWindow.getAllWindows().find((win) => win !== source && win !== browser);
  assert.ok(failedWindow);
  const failedSnapshot = () => failedWindow.webContents.executeJavaScript("window.hostBrowser.snapshot()");
  assert.equal((await failedSnapshot()).route, "disconnected");
  await failedWindow.webContents.executeJavaScript("document.getElementById('retry').click()");
  for (let i = 0; i < 30 && (await failedSnapshot()).route !== "connected"; i += 1) await wait(100);
  assert.equal((await failedSnapshot()).route, "connected");
  const stoppedBeforeClose = bridge.stopped;
  failedWindow.close();
  for (let i = 0; i < 20 && bridge.stopped === stoppedBeforeClose; i += 1) await wait(100);
  assert.equal(failedWindow.isDestroyed(), true);
  assert.ok(bridge.stopped > stoppedBeforeClose);
  console.log(JSON.stringify({ ok: true, screenshot, lightScreenshot, formScreenshot, downloadsScreenshot, lightDownloadsScreenshot, downloadedScreenshot, received, tabs: route.tabs.length }));
  manager.closeAll();
  source.destroy();
  socks.close();
  app.quit();
}

app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1); });
