"use strict";

// Run: electron electron/hostBrowser/hostBrowser.pdf.live.test.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const electron = require("electron");
const { app, BrowserWindow, WebContentsView } = electron;
const tempDirBridge = require("../bridges/tempDirBridge.cjs");
const { createHostBrowserManager } = require("./hostBrowserManager.cjs");
const portForwardingBridge = require("../bridges/portForwardingBridge.cjs");

// A real, valid PDF whose body can be held open independently of its headers.
function pdf() {
  let source = "%PDF-1.4\n";
  const offsets = [0];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] >>",
  ];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(source));
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  source += `%${"padding ".repeat(1024 * 128)}\n`;
  const start = Buffer.byteLength(source);
  source += `xref\n0 4\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(source);
}

const profile = fs.mkdtempSync(tempDirBridge.getTempFilePath("browser-pdf-"));
app.setPath("userData", profile);
fs.mkdirSync(path.join(profile, "downloads"));
app.setPath("downloads", path.join(profile, "downloads"));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, label) {
  for (let index = 0; index < 120; index++) { if (await read()) return; await wait(25); }
  assert.ok(await read(), label);
}
let owner, manager, site;
const watchdog = setTimeout(() => app.exit(1), 20000);
async function main() {
  const body = process.env.NETCATTY_PDF_FIXTURE ? fs.readFileSync(process.env.NETCATTY_PDF_FIXTURE) : pdf();
  let pending, sent = 0;
  site = http.createServer((request, response) => {
    if (request.url === "/failed") { request.socket.destroy(); return; }
    if (request.url === "/redirect") { response.writeHead(302, { location: "/slow.pdf" }); response.end(); return; }
    if (request.url === "/slow.pdf") {
      response.writeHead(200, { "content-type": "application/pdf;charset=UTF-8", "content-length": body.length });
      response.write(body.subarray(0, 65536)); sent = 65536; pending = response;
      return;
    }
    response.end('<title>PDF download fixture</title><a href="/slow.pdf">PDF</a>');
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${site.address().port}/`;
  owner = new BrowserWindow({ width: 900, height: 700, show: true });
  await owner.loadURL("data:text/html,<h1>PDF download acceptance</h1>");
  const handlers = new Map();
  manager = createHostBrowserManager({ electron: { ...electron, ipcMain: { handle(name, handler) { handlers.set(name, handler); } } }, app, portForwardingBridge });
  const event = { sender: owner.webContents }, browserId = "local:pdf";
  manager.openPanelUrl(event, { browserId, url });
  manager.updatePanelLayout(event, { browserId, visible: true, bounds: { x: 0, y: 80, width: 900, height: 600 } });
  await manager.open(event, { browserId, embedded: true, local: true, hostId: "local", label: "Local", theme: "light" });
  await until(() => manager.getPanelState(event, browserId).tabs[0].title === "PDF download fixture", "fixture loaded");
  const root = owner.contentView.children.find((view) => view.children.some((child) => child instanceof WebContentsView));
  const page = root.children[0].webContents;
  const downloads = () => handlers.get("netcatty:host-browser:downloads:list")(event, browserId);
  for (const scenario of ["link", "redirect", "iframe", "address"]) {
    pending = undefined;
    const previous = new Set(downloads().map((item) => item.id));
    const current = () => downloads().find((item) => !previous.has(item.id));
    let navigation;
    if (scenario === "address") {
      navigation = manager.runCommand(event, { type: "navigate", url: `${url}slow.pdf` }, browserId)
        .then(() => null, (error) => error);
    } else await page.executeJavaScript(`(() => {
      const element=document.createElement(${JSON.stringify(scenario === "iframe" ? "iframe" : "a")});
      const url=${JSON.stringify(scenario === "redirect" ? "/redirect" : "/slow.pdf")};
      if(element.tagName==='IFRAME') element.src=url; else element.href=url;
      document.body.append(element); if(element.tagName==='A') element.click();
    })()`);
    await until(() => pending, "PDF headers and first bytes were sent");
    await wait(1000);
    console.log(JSON.stringify({ scenario, beforeBodyFinished: true, sent, total: body.length, download: current() }));
    assert.ok(current()?.status === "progressing" && current().received < body.length, "inline PDF must appear in downloads before its response finishes");
    assert.ok(current().received > 0, "PDF bytes arrive before the response finishes");
    if (navigation) assert.equal(await navigation, null, "a PDF download is a successful address action, not a page error");
    pending.end(body.subarray(sent));
    await until(() => current()?.status === "completed", "PDF completes");
    assert.deepEqual(fs.readFileSync(current().savePath), body, "saved PDF matches original bytes");
  }
  await assert.rejects(manager.runCommand(event, { type: "navigate", url: `${url}failed` }, browserId), /ERR_/, "real navigation failures still surface");
  assert.equal(page.session.listenerCount("will-download"), 1, "download handling keeps a single session listener");
  console.log(JSON.stringify({ ok: true, earlyPdfProgress: true, redirect: true, iframe: true, addressDownload: true, realErrorsPreserved: true, profile }));
}
app.whenReady().then(main).catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  clearTimeout(watchdog); manager?.closeAll(); owner?.destroy(); site?.closeAllConnections(); site?.close(); app.exit(process.exitCode || 0);
});
