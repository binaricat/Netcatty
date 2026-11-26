"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  resolveDialogDirectory,
  resolveSaveDialogDefaultPath,
  resolveDirectoryDialogDefaultPath,
} = require("./dialogDefaultPath.cjs");

function withDirs(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-dialog-default-"));
  const preferred = path.join(root, "preferred");
  const downloads = path.join(root, "downloads");
  fs.mkdirSync(preferred);
  fs.mkdirSync(downloads);
  const app = { getPath: (name) => (name === "downloads" ? downloads : path.join(root, "unused")) };
  try {
    return fn({ root, preferred, downloads, deps: { app, fs, path } });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("callers without directory options keep the legacy defaultPath", () => {
  withDirs(({ deps }) => {
    assert.equal(resolveSaveDialogDefaultPath("report.txt", undefined, deps), "report.txt");
    assert.equal(resolveSaveDialogDefaultPath("report.txt", {}, deps), "report.txt");
    assert.equal(resolveSaveDialogDefaultPath(undefined, null, deps), undefined);
    assert.equal(resolveDirectoryDialogDefaultPath(undefined, undefined, deps), undefined);
    assert.equal(resolveDirectoryDialogDefaultPath("/explicit", undefined, deps), "/explicit");
  });
});

test("preferred directory is used when it exists", () => {
  withDirs(({ preferred, deps }) => {
    const options = { preferredDirectory: preferred, fallbackDirectory: "downloads" };
    assert.equal(resolveDialogDirectory(options, deps), preferred);
    assert.equal(resolveSaveDialogDefaultPath("report.txt", options, deps), path.join(preferred, "report.txt"));
    assert.equal(resolveDirectoryDialogDefaultPath(undefined, options, deps), preferred);
  });
});

test("missing, relative or file preferred directories fall back to system Downloads", () => {
  withDirs(({ root, downloads, deps }) => {
    const file = path.join(root, "not-a-dir.txt");
    fs.writeFileSync(file, "x");
    for (const preferredDirectory of [path.join(root, "gone"), "relative/dir", file, "", "   ", 7]) {
      const options = { preferredDirectory, fallbackDirectory: "downloads" };
      assert.equal(resolveDialogDirectory(options, deps), downloads, String(preferredDirectory));
      assert.equal(
        resolveSaveDialogDefaultPath("a.bin", options, deps),
        path.join(downloads, "a.bin"),
      );
    }
  });
});

test("unknown fallback names are ignored and missing fallbacks keep the legacy path", () => {
  withDirs(({ root, deps }) => {
    assert.equal(resolveDialogDirectory({ fallbackDirectory: "home" }, deps), null);
    assert.equal(resolveSaveDialogDefaultPath("a.bin", { fallbackDirectory: "home" }, deps), "a.bin");

    const brokenApp = { getPath: () => { throw new Error("unavailable"); } };
    const brokenDeps = { ...deps, app: brokenApp };
    assert.equal(resolveSaveDialogDefaultPath("a.bin", { fallbackDirectory: "downloads" }, brokenDeps), "a.bin");

    const missingApp = { getPath: () => path.join(root, "missing-downloads") };
    assert.equal(
      resolveDirectoryDialogDefaultPath(undefined, { fallbackDirectory: "downloads" }, { ...deps, app: missingApp }),
      undefined,
    );
  });
});

test("explicit paths are never rewritten and empty names open the directory", () => {
  withDirs(({ preferred, deps }) => {
    const options = { preferredDirectory: preferred, fallbackDirectory: "downloads" };
    const explicit = path.join(os.tmpdir(), "elsewhere", "file.txt");
    assert.equal(resolveSaveDialogDefaultPath(explicit, options, deps), explicit);
    assert.equal(resolveSaveDialogDefaultPath("nested/file.txt", options, deps), "nested/file.txt");
    assert.equal(resolveSaveDialogDefaultPath("", options, deps), preferred);
    assert.equal(resolveSaveDialogDefaultPath("..", options, deps), "..");
    assert.equal(resolveDirectoryDialogDefaultPath("/explicit", options, deps), "/explicit");
  });
});
