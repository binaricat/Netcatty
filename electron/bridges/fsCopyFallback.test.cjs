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
  assert.equal(
    fs.statSync(target).mode & 0o777,
    0o600,
    "a chmod-refusing destination keeps its restrictive permissions after replacement",
  );
  assert.equal(fs.existsSync(staged), false);
  assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith(".backup")).length, 0);
});

test("local promotion keeps restrictive mode when EXDEV staging copy succeeds but chmod is refused", async (t) => {
  const dir = makeTempDir("promote-refused-mode-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const staged = path.join(dir, "staged");
  const target = path.join(dir, "target");
  const payload = Buffer.alloc(1024 * 1024 + 3, 11);
  fs.writeFileSync(staged, payload, { mode: 0o644 });
  fs.writeFileSync(target, "original");
  fs.chmodSync(target, 0o600);
  // Force the EXDEV staging rename like a FUSE staging volume, but let the
  // accelerated copyFile succeed (Node falls back internally), so the ready
  // file inherits the broader staged mode.
  const renameOriginal = fs.promises.rename;
  const renameRestore = stubPromises("rename", async (...args) => {
    if (String(args[1]).endsWith(".ready")) {
      throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
    }
    return renameOriginal.apply(fs.promises, args);
  });
  const chmodRestore = stubPromises("chmod", async () => {
    throw Object.assign(new Error("EOPNOTSUPP: Operation not supported"), { code: "EOPNOTSUPP" });
  });
  t.after(renameRestore);
  t.after(chmodRestore);
  await transferBridge._promoteLocalTransferForTests(staged, target, { existingMode: 0o600 });
  // Restore owner access so the payload can be verified and cleaned up.
  fs.chmodSync(target, 0o600);
  assert.ok(fs.readFileSync(target).equals(payload));
  assert.equal(
    fs.statSync(target).mode & 0o777,
    0o600,
    "the broader staged 0644 mode never replaces the 0600 destination",
  );
  assert.equal(fs.readdirSync(dir).filter((name) => name !== "target").length, 0);
});

test("promotion fails closed when a same-device rename stage matches neither the destination mode nor chmod is refused", async (t) => {
  const dir = makeTempDir("promote-same-device-refused-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const staged = path.join(dir, "staged");
  const target = path.join(dir, "target");
  fs.writeFileSync(staged, Buffer.alloc(64 * 1024, 21), { mode: 0o644 });
  fs.writeFileSync(target, "original");
  fs.chmodSync(target, 0o600);
  // Same-device staging: the rename actually succeeds, so the ready file
  // keeps the staged 0644 mode. A chmod-refusing destination mount must not
  // publish that broader mode in place of the 0600 destination: promotion
  // fails closed instead.
  const chmodRestore = stubPromises("chmod", async () => {
    throw Object.assign(new Error("ENOTSUP: operation not supported"), { code: "ENOTSUP" });
  });
  t.after(chmodRestore);
  await assert.rejects(
    () => transferBridge._promoteLocalTransferForTests(staged, target, { existingMode: 0o600 }),
    /mount refused chmod/,
  );
  assert.equal(fs.readFileSync(target, "utf8"), "original");
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(dir).filter((name) => name !== "staged" && name !== "target").length, 0);
});

test("promotion publishes without chmod when a same-device rename stage already carries the destination mode", async (t) => {
  const dir = makeTempDir("promote-same-device-matching-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const staged = path.join(dir, "staged");
  const target = path.join(dir, "target");
  const payload = Buffer.alloc(64 * 1024, 15);
  fs.writeFileSync(staged, payload, { mode: 0o600 });
  fs.writeFileSync(target, "original");
  fs.chmodSync(target, 0o600);
  // Same-device staging where the stage was already written with the
  // destination's mode: the chmod refusal is acceptable because verification
  // confirms the ready file already carries the intended 0600 mode.
  const chmodRestore = stubPromises("chmod", async () => {
    throw Object.assign(new Error("ENOTSUP: operation not supported"), { code: "ENOTSUP" });
  });
  t.after(chmodRestore);
  await transferBridge._promoteLocalTransferForTests(staged, target, { existingMode: 0o600 });
  assert.ok(fs.readFileSync(target).equals(payload));
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(dir).filter((name) => name !== "target").length, 0);
});

for (const restrictiveMode of [0o200, 0o000]) {
  test(`local promotion replaces a mode-${restrictiveMode.toString(8)} destination through the EXDEV fallback`, async (t) => {
    const dir = makeTempDir(`promote-mode-${restrictiveMode.toString(8)}-`);
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const staged = path.join(dir, "staged");
    const target = path.join(dir, "target");
    const payload = Buffer.alloc(2 * 1024 * 1024 + 11, 5);
    fs.writeFileSync(staged, payload);
    fs.writeFileSync(target, "original");
    fs.chmodSync(target, restrictiveMode);
    // Force the EXDEV stream fallback like a FUSE staging volume would, and
    // make the accelerated copy syscall refuse so the streamed path runs.
    const renameOriginal = fs.promises.rename;
    const renameRestore = stubPromises("rename", async (...args) => {
      if (String(args[1]).endsWith(".ready")) {
        throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
      }
      return renameOriginal.apply(fs.promises, args);
    });
    const copyFileRestore = stubPromises("copyFile", enotsupCopyFile());
    t.after(renameRestore);
    t.after(copyFileRestore);
    await transferBridge._promoteLocalTransferForTests(staged, target, { existingMode: restrictiveMode });
    // Promotion must publish the exact restrictive destination mode: it may
    // grant owner read only while acquiring its own read handle, never as
    // part of the published file. statSync needs no read permission.
    assert.equal(
      fs.statSync(target).mode & 0o777,
      restrictiveMode,
      `the mode-${restrictiveMode.toString(8)} destination is published without added owner read`,
    );
    // Restore owner access so the payload can be verified and cleaned up.
    fs.chmodSync(target, 0o600);
    assert.ok(fs.readFileSync(target).equals(payload));
    assert.deepEqual(fs.readdirSync(dir), ["target"], "promotion leaves no recovery files behind");
  });
}

test("local promotion never publishes owner read for a mode-0000 destination on a chmod-refusing mount", async (t) => {
  const dir = makeTempDir("promote-refusing-mode-0000-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const staged = path.join(dir, "staged");
  const target = path.join(dir, "target");
  const payload = Buffer.alloc(1024 * 1024 + 17, 13);
  fs.writeFileSync(staged, payload);
  fs.writeFileSync(target, "original");
  fs.chmodSync(target, 0o000);
  // Force the EXDEV stream fallback and refuse chmod like gvfsd-fuse would;
  // the published destination must keep the restrictive 0000 mode instead of
  // leaking the temporary owner-read grant used to hold the ready handle.
  const renameOriginal = fs.promises.rename;
  const renameRestore = stubPromises("rename", async (...args) => {
    if (String(args[1]).endsWith(".ready")) {
      throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
    }
    return renameOriginal.apply(fs.promises, args);
  });
  const copyFileRestore = stubPromises("copyFile", enotsupCopyFile());
  const chmodRestore = stubPromises("chmod", async () => {
    throw Object.assign(new Error("ENOTSUP: operation not supported"), { code: "ENOTSUP" });
  });
  t.after(renameRestore);
  t.after(copyFileRestore);
  t.after(chmodRestore);
  await transferBridge._promoteLocalTransferForTests(staged, target, { existingMode: 0o000 });
  assert.equal(
    fs.statSync(target).mode & 0o777,
    0o000,
    "the chmod-refusing destination keeps its mode without an added owner-read bit",
  );
  // Restore owner access so the payload can be verified and cleaned up.
  fs.chmodSync(target, 0o600);
  assert.ok(fs.readFileSync(target).equals(payload));
  assert.equal(fs.existsSync(staged), false);
  assert.equal(fs.readdirSync(dir).filter((name) => name !== "target").length, 0);
});

test("promotion fails closed for a restrictive destination on a chmod- and hardlink-refusing mount", async (t) => {
  const dir = makeTempDir("promote-fail-closed-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const staged = path.join(dir, "staged");
  const target = path.join(dir, "target");
  fs.writeFileSync(staged, Buffer.alloc(1024 * 1024 + 7, 3));
  fs.writeFileSync(target, "original");
  fs.chmodSync(target, 0o000);
  // gvfs-style mount: no chmod, no hardlinks, and the pre-replacement rename
  // across devices forces the streamed fallback. The restrictive destination
  // cannot be read to republish, so promotion must fail instead of silently
  // publishing a broadened owner-readable mode.
  const renameOriginal = fs.promises.rename;
  const renameRestore = stubPromises("rename", async (...args) => {
    if (String(args[1]).endsWith(".ready")) {
      throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
    }
    return renameOriginal.apply(fs.promises, args);
  });
  const copyFileRestore = stubPromises("copyFile", enotsupCopyFile());
  const chmodRestore = stubPromises("chmod", async () => {
    throw Object.assign(new Error("ENOTSUP: operation not supported"), { code: "ENOTSUP" });
  });
  const linkRestore = stubPromises("link", async () => {
    throw Object.assign(new Error("ENOTSUP: operation not supported, link"), { code: "ENOTSUP" });
  });
  t.after(renameRestore);
  t.after(copyFileRestore);
  t.after(chmodRestore);
  t.after(linkRestore);
  await assert.rejects(
    () => transferBridge._promoteLocalTransferForTests(staged, target, { existingMode: 0o000 }),
    /unreadable local destination/,
  );
  // The original destination is restored untouched and nothing was broadened.
  fs.chmodSync(target, 0o600);
  assert.equal(fs.readFileSync(target, "utf8"), "original");
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(staged), true);
});

test("copyFileExclusiveWithFallback applies restrictive creation mode to the streamed fallback", async (t) => {
  const dir = makeTempDir("copy-fallback-mode-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "staged");
  const target = path.join(dir, "target");
  const payload = Buffer.alloc(64 * 1024, 9);
  fs.writeFileSync(source, payload);
  const restore = stubPromises("copyFile", enotsupCopyFile());
  t.after(restore);
  await copyFileExclusiveWithFallback(source, target, 0o600);
  assert.ok(fs.readFileSync(target).equals(payload));
  assert.equal(
    fs.statSync(target).mode & 0o777,
    0o600,
    "fallback creation mode is honored instead of the 0666 default",
  );
});

test("copyFileExclusiveWithFallback restores creation-mode bits masked by the umask", async (t) => {
  const dir = makeTempDir("copy-fallback-umask-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "staged");
  const target = path.join(dir, "target");
  const payload = Buffer.alloc(64 * 1024, 9);
  fs.writeFileSync(source, payload);
  const restore = stubPromises("copyFile", enotsupCopyFile());
  t.after(restore);
  const previousUmask = process.umask(0o077);
  t.after(() => process.umask(previousUmask));
  await copyFileExclusiveWithFallback(source, target, 0o664);
  assert.ok(fs.readFileSync(target).equals(payload));
  assert.equal(
    fs.statSync(target).mode & 0o777,
    0o664,
    "umask-masked creation bits are restored after the streamed copy",
  );
});

test("copyFileExclusiveWithFallback fails closed when the umask narrows the created mode and chmod is refused", async (t) => {
  const dir = makeTempDir("copy-fallback-umask-refused-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "staged");
  const target = path.join(dir, "target");
  const payload = Buffer.alloc(64 * 1024, 9);
  fs.writeFileSync(source, payload);
  const copyRestore = stubPromises("copyFile", enotsupCopyFile());
  t.after(copyRestore);
  const chmodRestore = stubPromises("chmod", async () => {
    throw Object.assign(new Error("ENOTSUP: operation not supported"), { code: "ENOTSUP" });
  });
  t.after(chmodRestore);
  const previousUmask = process.umask(0o077);
  t.after(() => process.umask(previousUmask));
  await assert.rejects(
    () => copyFileExclusiveWithFallback(source, target, 0o664),
    (error) => error?.code === "EPERM",
    "a chmod-refusing mount never promises the umask-narrowed mode",
  );
});

test("copyFileExclusiveWithFallback does not unlink a concurrent replacement at the same path", async (t) => {
  const dir = makeTempDir("copy-fallback-race-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "staged");
  const target = path.join(dir, "target");
  fs.writeFileSync(source, "our copy bytes");
  // Simulate another process writing the same pathname while our (stalled)
  // chmod is still in flight: the stub replaces the copy and then refuses.
  const chmodRestore = stubPromises("chmod", async (pathName) => {
    fs.writeFileSync(pathName, "written by another process");
    throw Object.assign(new Error("ENOTSUP: operation not supported"), { code: "ENOTSUP" });
  });
  t.after(chmodRestore);
  await assert.rejects(
    () => copyFileExclusiveWithFallback(source, target, 0o600),
    (error) => error?.code === "EEXIST",
  );
  assert.equal(
    fs.readFileSync(target, "utf8"),
    "written by another process",
    "the concurrent replacement is never removed by the cleanup",
  );
});

test("local promotion without existingMode keeps the staged mode for cross-device resumable copies", async (t) => {
  const dir = makeTempDir("promote-staged-mode-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const staged = path.join(dir, "staged");
  const target = path.join(dir, "target");
  const payload = Buffer.alloc(64 * 1024, 3);
  fs.writeFileSync(staged, payload, { mode: 0o644 });
  fs.writeFileSync(target, "original");
  // Force the EXDEV staging rename like a FUSE staging volume, but leave the
  // real copyFile/chmod in place (working filesystem, missing destination
  // metadata). This is the local-to-local resumable caller's situation.
  const renameOriginal = fs.promises.rename;
  const renameRestore = stubPromises("rename", async (...args) => {
    if (String(args[1]).endsWith(".ready")) {
      throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
    }
    return renameOriginal.apply(fs.promises, args);
  });
  t.after(renameRestore);
  await transferBridge._promoteLocalTransferForTests(staged, target, {});
  assert.ok(fs.readFileSync(target).equals(payload));
  assert.equal(
    fs.statSync(target).mode & 0o777,
    0o644,
    "cross-device promotion preserves the staged permissions instead of forcing 0600",
  );
  assert.equal(fs.readdirSync(dir).filter((name) => name !== "target").length, 0);
});

test("copyFileExclusiveWithFallback applies the intended mode when the accelerated copy succeeds but chmod is refused", async (t) => {
  const dir = makeTempDir("copy-fallback-accel-mode-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "staged");
  const target = path.join(dir, "target");
  fs.writeFileSync(source, "accelerated bytes");
  const chmodRestore = stubPromises("chmod", async () => {
    throw Object.assign(new Error("ENOTSUP: operation not supported"), { code: "ENOTSUP" });
  });
  t.after(chmodRestore);
  await copyFileExclusiveWithFallback(source, target, 0o600);
  assert.equal(fs.readFileSync(target, "utf8"), "accelerated bytes");
  assert.equal(
    fs.statSync(target).mode & 0o777,
    0o600,
    "a metadata-refusing mount never publishes the broader staged source mode",
  );
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

test("copyFileExclusiveWithFallback stops streaming when the caller cancels mid-copy", async (t) => {
  const dir = makeTempDir("copy-fallback-cancel-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "staged");
  const target = path.join(dir, "target");
  const payload = Buffer.alloc(4 * 1024 * 1024, 7);
  fs.writeFileSync(source, payload);
  const restore = stubPromises("copyFile", enotsupCopyFile());
  t.after(restore);
  // Cancel after a few streamed chunks: the gate must abort the pipeline
  // instead of copying the whole staged file to completion.
  let chunksSeen = 0;
  await assert.rejects(
    () => copyFileExclusiveWithFallback(source, target, null, {
      assertNotCancelled() {
        chunksSeen += 1;
        if (chunksSeen > 8) throw new Error("Transfer cancelled");
      },
    }),
    (error) => error?.message === "Transfer cancelled",
  );
  assert.ok(chunksSeen > 8, "the cancellation check ran per streamed chunk");
  const copied = fs.existsSync(target) ? fs.statSync(target).size : 0;
  assert.ok(
    copied < payload.length,
    `the cancelled copy must not stream the full payload (copied ${copied} of ${payload.length} bytes)`,
  );
});

test("copyFileExclusiveWithFallback rejects an already-aborted signal before creating the target", async (t) => {
  const dir = makeTempDir("copy-fallback-aborted-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "staged");
  const target = path.join(dir, "target");
  fs.writeFileSync(source, "never copied");
  const restore = stubPromises("copyFile", enotsupCopyFile());
  t.after(restore);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => copyFileExclusiveWithFallback(source, target, null, { signal: controller.signal }),
    (error) => error?.code === "ABORT_ERR",
  );
  assert.equal(fs.existsSync(target), false, "a cancelled copy never leaves a created target");
});

test("promoteLocalTransfer observes cancellation during the cross-device fallback copy", async (t) => {
  const dir = makeTempDir("promote-cancel-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const staged = path.join(dir, "staged");
  const target = path.join(dir, "target");
  const payload = Buffer.alloc(4 * 1024 * 1024, 5);
  fs.writeFileSync(staged, payload);
  // Force the EXDEV staging rename so promotion takes the streamed fallback.
  const renameOriginal = fs.promises.rename;
  const renameRestore = stubPromises("rename", async (...args) => {
    if (String(args[1]).endsWith(".ready")) {
      throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
    }
    return renameOriginal.apply(fs.promises, args);
  });
  t.after(renameRestore);
  await assert.rejects(
    () => transferBridge._promoteLocalTransferForTests(staged, target, {
      assertNotCancelled() {
        throw new Error("Transfer cancelled");
      },
    }),
    (error) => error?.message === "Transfer cancelled",
  );
  assert.equal(fs.existsSync(target), false, "a cancelled promotion never publishes the target");
  const leftovers = fs.readdirSync(dir).filter((name) => name.startsWith(".target."));
  assert.equal(leftovers.length, 0, "cancelled promotion cleans up its private ready file");
});
