"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const { normalizeBrowserUrl, pdfDownloadHeaders } = require("./hostBrowserManager.cjs");

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
