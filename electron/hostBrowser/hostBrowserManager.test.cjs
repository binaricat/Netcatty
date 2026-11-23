"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const { normalizeBrowserUrl, pdfDownloadHeaders } = require("./hostBrowserManager.cjs");

test("page tabs accept invalid TLS certificates and suppress only accepted navigation errors", async () => {
  const { EventEmitter } = require("node:events");
  const source = readFileSync(require.resolve("./hostBrowserManager.cjs"), "utf8");
  const start = source.indexOf("const addTab =");
  const end = source.indexOf("const stopTunnel =", start);
  assert.ok(start > 0 && end > start);
  const chromeContents = new EventEmitter();
  const record = { tabs: new Map(), navigations: new Map(), pageSession: {}, chromeContents, route: "connected" };
  const loads = [];
  const addTab = vm.runInNewContext(`${source.slice(start, end)};addTab;`, {
    MAX_TABS: 32, randomUUID: require("node:crypto").randomUUID,
    displayTab() {},
    WebContentsView: class {
      constructor({ webPreferences }) {
        assert.equal(webPreferences.session, record.pageSession);
        assert.equal(webPreferences.webSecurity, true);
        const contents = this.webContents = new EventEmitter();
        contents.id = record.tabs.size + 1;
        contents.setWebRTCIPHandlingPolicy = () => {};
        contents.setWindowOpenHandler = () => {};
        contents.loadURL = async (url) => {
          for (const error of ["net::ERR_CERT_AUTHORITY_INVALID", "net::ERR_CERT_DATE_INVALID"]) {
            const calls = [];
            contents.emit("certificate-error", { preventDefault: () => calls.push("preventDefault") },
              url, error, {}, (allowed) => calls.push(allowed));
            assert.deepEqual(calls, ["preventDefault", true]);
          }
        };
        const loadURL = contents.loadURL;
        contents.loadURL = (url) => { const load = loadURL(url); loads.push(load); return load; };
      }
    },
  });
  addTab(record, "https://172.16.0.235/");
  addTab(record, "https://device.test/");
  await Promise.all(loads);
  assert.equal(loads.length, 2);
  assert.equal(chromeContents.listenerCount("certificate-error"), 0);

  const commandStart = source.indexOf("const runCommand =");
  const commandEnd = source.indexOf('ipcMain.handle("netcatty:host-browser:command"', commandStart);
  assert.ok(commandStart > 0 && commandEnd > commandStart);
  const runCommand = vm.runInNewContext(`${source.slice(commandStart, commandEnd)};runCommand;`, {
    getOwned: () => record, snapshot: () => record, displayTab() {}, normalizeBrowserUrl,
  });
  const contents = record.tabs.get(record.activeTabId).view.webContents;
  const certError = Object.assign(new Error("ERR_CERT_AUTHORITY_INVALID"), { code: "ERR_CERT_AUTHORITY_INVALID" });
  contents.loadURL = async (url) => {
    contents.emit("certificate-error", { preventDefault() {} }, url, "net::ERR_CERT_AUTHORITY_INVALID", {}, () => {});
    throw certError;
  };
  const command = { type: "navigate", url: "https://172.16.0.235/" };
  await assert.doesNotReject(runCommand({}, command));
  assert.equal(record.navigations.size, 0);
  // Acceptance belongs to one navigation; it must not hide a later failure.
  contents.loadURL = async () => { throw certError; };
  await assert.rejects(runCommand({}, command), (error) => error === certError);
  const networkError = Object.assign(new Error("ERR_CONNECTION_REFUSED"), { code: "ERR_CONNECTION_REFUSED" });
  contents.loadURL = async (url) => {
    contents.emit("certificate-error", { preventDefault() {} }, url, "net::ERR_CERT_AUTHORITY_INVALID", {}, () => {});
    throw networkError;
  };
  await assert.rejects(runCommand({}, command), (error) => error === networkError);
  assert.equal(record.navigations.size, 0);
});

test("PDF navigations download before the preview can buffer the response", () => {
  const headers = { "Content-Type": ["Application/PDF;charset=UTF-8"], "Content-Length": ["8933895"] };
  for (const resourceType of ["mainFrame", "subFrame"]) {
    assert.deepEqual(pdfDownloadHeaders({ resourceType, statusCode: 200, responseHeaders: headers }), {
      ...headers, "Content-Disposition": ["attachment"],
    });
  }
  assert.equal(headers["Content-Disposition"], undefined, "the original response headers are not mutated");
});

test("PDF downloads preserve the site's localized suggested filename", () => {
  const filename = "; filename=report.pdf; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf";
  const headers = { "content-type": ["application/pdf"], "content-disposition": [`inline${filename}`] };
  assert.deepEqual(pdfDownloadHeaders({ resourceType: "mainFrame", statusCode: 200, responseHeaders: headers }), {
    ...headers, "content-disposition": [`attachment${filename}`],
  });
});

test("PDF policy leaves webpage requests, failed responses and explicit downloads alone", () => {
  const responseHeaders = { "content-type": ["application/pdf"] };
  const details = { resourceType: "mainFrame", statusCode: 200, responseHeaders };
  for (const resourceType of ["xhr", "object", "other", "script", "image"]) assert.equal(pdfDownloadHeaders({ ...details, resourceType }), undefined);
  for (const statusCode of [302, 404, 500]) assert.equal(pdfDownloadHeaders({ ...details, statusCode }), undefined);
  for (const mime of ["text/html", "image/png", "application/octet-stream"]) assert.equal(pdfDownloadHeaders({ ...details, responseHeaders: { "content-type": [mime] } }), undefined);
  assert.equal(pdfDownloadHeaders({ ...details, responseHeaders: { ...responseHeaders, "content-disposition": ["attachment; filename=report.pdf"] } }), undefined);
  assert.equal(pdfDownloadHeaders({ ...details, responseHeaders: undefined }), undefined);
});

test("browser addresses accept bare localhost and domain ports", () => {
  assert.equal(normalizeBrowserUrl("localhost:3000"), "http://localhost:3000/");
  assert.equal(normalizeBrowserUrl("localhost:3000/app"), "http://localhost:3000/app");
  assert.equal(normalizeBrowserUrl("127.0.0.1:8080"), "http://127.0.0.1:8080/");
  assert.equal(normalizeBrowserUrl("example.com:8080"), "https://example.com:8080/");
  assert.equal(normalizeBrowserUrl("https://example.com/app"), "https://example.com/app");
});

test("browser addresses keep rejecting external protocols and credentials", () => {
  for (const url of ["file:///etc/passwd", "javascript:alert(1)", "mailto:test@example.com", "https://user:password@example.com/"]) {
    assert.throws(() => normalizeBrowserUrl(url));
  }
});

test("late download notifications ignore closed browser chrome in a live terminal", () => {
  const source = readFileSync(require.resolve("./hostBrowserManager.cjs"), "utf8");
  const start = source.indexOf("const notifyDownloads =");
  const end = source.indexOf("const snapshot =", start);
  assert.ok(start > 0 && end > start);
  const record = {
    hostId: "host",
    win: { isDestroyed: () => false },
    chromeContents: {
      isDestroyed: () => true,
      send: () => { throw new Error("Object has been destroyed"); },
    },
    downloadsPanelOpen: false,
  };
  const notify = vm.runInNewContext(`${source.slice(start, end)};notifyDownloads;`, {
    downloadStore: { list: () => [] },
    windows: new Map([["closed", record]]),
  });
  assert.doesNotThrow(() => notify(record));
});

test("manager shutdown flushes download history after closing windows", () => {
  const source = readFileSync(require.resolve("./hostBrowserManager.cjs"), "utf8");
  const start = source.indexOf("closeAll: () => {");
  const end = source.indexOf("} };", start);
  assert.ok(start > 0 && end > start);
  const calls = [];
  const closeAll = vm.runInNewContext(`(() => {${source.slice(start + "closeAll: () => {".length, end)}})`, {
    unsubscribeTunnelStatus: () => calls.push("unsubscribe"),
    windows: new Map([[1, { embedded: true }]]),
    closeRecord: () => calls.push("close"),
    downloadStore: { flush: () => calls.push("flush") },
  });
  closeAll();
  assert.deepEqual(calls, ["unsubscribe", "close", "flush"]);
});

test("download handler defers only live progress, not pause or completion", () => {
  const { EventEmitter } = require("node:events");
  const path = require("node:path");
  const source = readFileSync(require.resolve("./hostBrowserManager.cjs"), "utf8");
  const start = source.indexOf("record.downloadHandler =");
  const end = source.indexOf('pageSession.on("will-download"', start);
  const calls = [];
  let previous;
  let now = 1000;
  const record = { route: "connected", embedded: true, downloads: new Map(), tabs: new Map([[1, { view: { webContents: "owned" } }]]) };
  vm.runInNewContext(source.slice(start, end), {
    record, path, randomUUID: () => "id", hostId: "host", app: { getPath: () => "/downloads" },
    reserveDownloadFile: () => ({ savePath: "/downloads/file", cleanupEmpty() {} }),
    downloadStore: { get: () => previous, upsert(row, options) { previous = row; calls.push({ row, options }); } },
    notifyDownloads() {}, Date: { now: () => now },
  });
  const item = Object.assign(new EventEmitter(), {
    paused: false, isPaused() { return this.paused; }, getFilename: () => "file", getURL: () => "https://example.test/file",
    getTotalBytes: () => 100, getReceivedBytes: () => 10, getSavePath: () => "/downloads/file", setSavePath() {},
  });
  record.downloadHandler({ preventDefault() { assert.fail("rejected owned download"); } }, item, "owned");
  assert.equal(calls[0].options, undefined);
  item.emit("updated", {}, "progressing");
  assert.equal(calls[1].options.deferProgress, true);
  now += 1;
  item.paused = true;
  item.emit("updated", {}, "progressing");
  assert.equal(calls[2].options.deferProgress, false, "pause bypasses the byte-progress throttle");
  item.emit("done", {}, "completed");
  assert.equal(calls[3].options, undefined);
  assert.equal(calls[3].row.status, "completed");
});
