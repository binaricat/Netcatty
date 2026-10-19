"use strict";

// Run with: electron electron/hostBrowser/hostBrowser.ssh.live.test.cjs
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { Server } = require("ssh2");
const { app, BrowserWindow, WebContentsView, session, ipcMain } = require("electron");
const portForwardingBridge = require("../bridges/portForwardingBridge.cjs");
const { createHostBrowserManager } = require("./hostBrowserManager.cjs");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  app.setPath("userData", path.join(os.tmpdir(), `netcatty-browser-ssh-live-${process.pid}`));
  const allowedPorts = new Set();
  let forwardedConnections = 0;
  const site = http.createServer((request, response) => {
    if (!allowedPorts.has(request.socket.remotePort)) {
      response.writeHead(403);
      response.end("Direct connection denied");
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<title>SSH route reached</title><h1>SSH route reached</h1>");
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const sitePort = site.address().port;
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const ssh = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on("authentication", (context) => {
      if (context.method === "password" && context.username === "test" && context.password === "secret") context.accept();
      else context.reject();
    });
    client.on("ready", () => {
      client.on("tcpip", (accept, reject, info) => {
        if (Number(info.destPort) !== sitePort || !["localhost", "127.0.0.1"].includes(info.destIP)) return reject();
        forwardedConnections += 1;
        const channel = accept();
        const target = net.connect(sitePort, "127.0.0.1");
        target.once("connect", () => {
          allowedPorts.add(target.localPort);
          channel.pipe(target).pipe(channel);
        });
        target.on("close", () => allowedPorts.delete(target.localPort));
        channel.on("error", () => target.destroy());
        target.on("error", () => channel.destroy());
      });
    });
  });
  await new Promise((resolve) => ssh.listen(0, "127.0.0.1", resolve));
  const source = new BrowserWindow({ show: false });
  const manager = createHostBrowserManager({ electron: { BrowserWindow, WebContentsView, session, ipcMain }, app, portForwardingBridge });
  await manager.open({ sender: source.webContents }, {
    hostId: "ssh-host", label: "SSH Fixture", theme: "dark",
    connectionOptions: {
      hostId: "ssh-host", type: "dynamic", hostname: "127.0.0.1", port: ssh.address().port,
      username: "test", authMethod: "password", password: "secret", verifyHostKeys: false,
      knownHosts: [], sshTcpConnectTimeoutMs: 5000, sshAuthReadyTimeoutMs: 5000,
    },
  });
  const browser = BrowserWindow.getAllWindows().find((win) => win !== source);
  assert.ok(browser);
  const snapshot = () => browser.webContents.executeJavaScript("window.hostBrowser.snapshot()");
  assert.equal((await snapshot()).route, "connected", JSON.stringify(await snapshot()));
  await browser.webContents.executeJavaScript(`window.hostBrowser.command({type:'navigate',url:'http://localhost:${sitePort}/'})`);
  for (let i = 0; i < 60 && (await snapshot()).tabs[0].title !== "SSH route reached"; i += 1) await wait(100);
  assert.equal((await snapshot()).tabs[0].title, "SSH route reached");
  assert.ok(forwardedConnections > 0, "the page must pass through an SSH tcpip channel");
  browser.close();
  await wait(100);
  manager.closeAll();
  source.destroy();
  ssh.close();
  site.close();
  console.log(JSON.stringify({ ok: true, forwardedConnections }));
  app.quit();
}

app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1); });
