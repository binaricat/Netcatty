"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { copyFileExclusiveWithFallback, isCopyFallbackError, isMetadataUnsupportedError } = require("./fsCopyFallback.cjs");
const transferBridge = require("./transferBridge.cjs");
const localFilePublish = require("./localFilePublish.cjs");
const temp = require("./tempDirBridge.cjs");

function makeTempDir(prefix) {
  return fs.mkdtempSync(`${temp.getTempFilePath(prefix)}-`);
}

function stubPromises(method, impl) {
  const original = fs.promises[method];
  fs.promises[method] = impl;
  return () => { fs.promises[method] = original; };
}

// publishLocalFileExclusive stamps metadata through the owned
// fs.promises FileHandle, not the fs.promises namespace.
function makeHandleStub(method, error) {
  const original = fs.promises.open;
  fs.promises.open = async (...args) => {
    const handle = await original.apply(fs.promises, args);
    if (typeof handle[method] === "function") {
      handle[method] = async () => { throw error; };
    }
    return handle;
  };
  return () => { fs.promises.open = original; };
}

function enotsupCopyFile() {
  return async () => {
    throw Object.assign(new Error("ENOTSUP: operation not supported on socket, copyfile"), { code: "ENOTSUP" });
  };
}

for (const code of ["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EINVAL"]) {
  test(`copyFileExclusiveWithFallback streams complete bytes when fs.copyFile is refused with ${code}`, async (t) => {
    const dir = makeTempDir("copy-fallback-");
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const source = path.join(dir, "staged");
    const target = path.join(dir, "target");
    const payload = Buffer.alloc(1024 * 1024 + 13, 42);
    fs.writeFileSync(source, payload);
    const restore = stubPromises("copyFile", async () => {
      throw Object.assign(new Error(`${code}: refused by filesystem`), { code });
    });
    t.after(restore);
    await copyFileExclusiveWithFallback(source, target);
    assert.ok(fs.readFileSync(target).equals(payload));
  });
}

test("copyFileExclusiveWithFallback preserves COPYFILE_EXCL semantics", async (t) => {
  const dir = makeTempDir("copy-fallback-excl-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "staged");
  const target = path.join(dir, "target");
  fs.writeFileSync(source, "new bytes");
  fs.writeFileSync(target, "existing");
  await assert.rejects(
    () => copyFileExclusiveWithFallback(source, target),
    (error) => error?.code === "EEXIST",
  );
  assert.equal(fs.readFileSync(target, "utf8"), "existing");
  const restore = stubPromises("copyFile", enotsupCopyFile());
  t.after(restore);
  await assert.rejects(
    () => copyFileExclusiveWithFallback(source, target),
    (error) => error?.code === "EEXIST",
  );
  assert.equal(fs.readFileSync(target, "utf8"), "existing");
});

test("copyFileExclusiveWithFallback rethrows unrelated copyFile errors", async (t) => {
  const dir = makeTempDir("copy-fallback-missing-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "staged");
  const target = path.join(dir, "no-such-dir", "target");
  fs.writeFileSync(source, "bytes");
  await assert.rejects(
    () => copyFileExclusiveWithFallback(source, target),
    (error) => error?.code === "ENOENT",
  );
});

test("errno predicates separate copyable and metadata failures", () => {
  for (const code of ["ENOTSUP", "EOPNOTSUPP"]) {
    assert.equal(isCopyFallbackError({ code }), true);
    assert.equal(isMetadataUnsupportedError({ code }), true);
  }
  assert.equal(isMetadataUnsupportedError({ code: "ENOSYS" }), true);
  assert.equal(isMetadataUnsupportedError({ code: "EXDEV" }), false);
  assert.equal(isCopyFallbackError({ code: "EACCES" }), false);
  assert.equal(isMetadataUnsupportedError({ code: "EACCES" }), false);
  assert.equal(isCopyFallbackError({}), false);
  assert.equal(isMetadataUnsupportedError({}), false);
});

test("local promotion completes when the destination refuses copyFile and chmod", async (t) => {
  const dir = makeTempDir("promote-refused-copy-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const staged = path.join(dir, "staged");
  const target = path.join(dir, "target");
  const payload = Buffer.alloc(3 * 1024 * 1024 + 5, 7);
  fs.writeFileSync(staged, payload);
  fs.writeFileSync(target, "original");
  const copyFileRestore = stubPromises("copyFile", async (source, dest, flags) => {
    copyFileCalls.push(flags);
    assert.equal(flags & fs.constants.COPYFILE_EXCL, fs.constants.COPYFILE_EXCL);
    throw Object.assign(new Error("ENOTSUP: operation not supported on socket, copyfile"), { code: "ENOTSUP" });
  });
  const chmodRestore = stubPromises("chmod", async () => {
    chmodCalls.push(1);
    throw Object.assign(new Error("EOPNOTSUPP: Operation not supported"), { code: "EOPNOTSUPP" });
  });
  // The temp dir and the "GVFS" destination are forced onto different devices
  // (as with ~/.netcatty/tmp vs a FUSE mount) so the EXDEV fallback runs.
  const renameOriginal = fs.promises.rename;
  const renameRestore = stubPromises("rename", async (...args) => {
    if (String(args[1]).endsWith(".ready")) {
      throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
    }
    return renameOriginal.apply(fs.promises, args);
  });
  t.after(copyFileRestore);
  t.after(chmodRestore);
  t.after(renameRestore);
  const copyFileCalls = [];
  const chmodCalls = [];
  await transferBridge._promoteLocalTransferForTests(staged, target, { existingMode: 0o600 });
  assert.equal(copyFileCalls.length, 1, "accelerated copy is attempted exactly once before falling back");
  assert.equal(chmodCalls.length, 1, "unsupported chmod is attempted instead of skipped");
  assert.ok(fs.readFileSync(target).equals(payload));
  assert.equal(fs.existsSync(staged), false);
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith(".backup")).length, 0);
});

test("publishLocalFileExclusive tolerates chmod/utimes rejection without hardlinks", async (t) => {
  const dir = makeTempDir("publish-refused-metadata-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "staged");
  const target = path.join(dir, "target");
  fs.writeFileSync(source, "gvfs bytes");
  fs.utimesSync(source, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  const linkRestore = stubPromises("link", async () => {
    throw Object.assign(new Error("ENOTSUP: operation not supported, link 'src' -> 'dest'"), { code: "ENOTSUP" });
  });
  const chmodRestore = makeHandleStub(
    "chmod",
    Object.assign(new Error("EOPNOTSUPP: Operation not supported"), { code: "EOPNOTSUPP" }),
  );
  const utimesRestore = makeHandleStub(
    "utimes",
    Object.assign(new Error("ENOTSUP: operation not supported"), { code: "ENOTSUP" }),
  );
  t.after(linkRestore);
  t.after(chmodRestore);
  t.after(utimesRestore);
  const identity = await localFilePublish.publishLocalFileExclusive(source, target);
  assert.equal(fs.readFileSync(target, "utf8"), "gvfs bytes");
  assert.equal(identity.size, fs.lstatSync(target).size);
  assert.equal(fs.lstatSync(target).isFile(), true);
});
