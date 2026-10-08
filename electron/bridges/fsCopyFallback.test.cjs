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
  // Metadata refusal is simulated at the owned-handle level too (and at the
  // pathname level above), like gvfsd-fuse-style mounts that reject chmod
  // entirely.
  const handleChmodRestore = makeHandleStub(
    "chmod",
    Object.assign(new Error("EOPNOTSUPP: Operation not supported"), { code: "EOPNOTSUPP" }),
  );
  t.after(renameRestore);
  t.after(chmodRestore);
  t.after(handleChmodRestore);
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
  // Mode 0000 does not make the destination unreadable when the tests run as
  // root (or on platforms where permission bits are advisory), so assert the
  // rejection's precondition deterministically: opening the restrictive
  // destination fails with EACCES regardless of the effective uid.
  const openOriginal = fs.promises.open;
  const openRestore = stubPromises("open", async (...args) => {
    if (String(args[0]) === target) {
      throw Object.assign(new Error(`EACCES: permission denied, open ${target}`), { code: "EACCES" });
    }
    return openOriginal.apply(fs.promises, args);
  });
  t.after(openRestore);
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
  // Metadata refusal is simulated at both the pathname and the owned-handle
  // level, like gvfsd-fuse-style mounts that reject chmod entirely.
  const chmodRestore = stubPromises("chmod", async () => {
    throw Object.assign(new Error("ENOTSUP: operation not supported"), { code: "ENOTSUP" });
  });
  t.after(chmodRestore);
  const handleChmodRestore = makeHandleStub(
    "chmod",
    Object.assign(new Error("ENOTSUP: operation not supported"), { code: "ENOTSUP" }),
  );
  t.after(handleChmodRestore);
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
  // Simulate another process winning the pathname while the produced copy's
  // identity is pinned but before the metadata-changing open: the stub
  // replaces the file with a new inode, so the opened handle must no longer
  // match the copied identity.
  const openOriginal = fs.promises.open;
  const openRestore = stubPromises("open", async (...args) => {
    if (args[0] === target) {
      fs.unlinkSync(target);
      fs.writeFileSync(target, "written by another process");
    }
    return openOriginal.apply(fs.promises, args);
  });
  t.after(openRestore);
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

test("copyFileExclusiveWithFallback fails closed when the pathname changes while the handle-based chmod runs", async (t) => {
  const dir = makeTempDir("copy-fallback-race-handle-chmod-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "staged");
  const target = path.join(dir, "target");
  fs.writeFileSync(source, "our copy bytes");
  // Let the first lstat (which pins the copied identity) pass through, then
  // replace the pathname before the post-chmod revalidation lstat: the chmod
  // itself landed on our pinned inode, but the name no longer holds it, so a
  // successful return would bless a replacement for the caller's publication.
  const lstatOriginal = fs.promises.lstat;
  let lstatCalls = 0;
  const lstatRestore = stubPromises("lstat", async (...args) => {
    if (args[0] === target) {
      lstatCalls += 1;
      if (lstatCalls > 1) {
        fs.unlinkSync(target);
        fs.writeFileSync(target, "written by another process");
      }
    }
    return lstatOriginal.apply(fs.promises, args);
  });
  t.after(lstatRestore);
  await assert.rejects(
    () => copyFileExclusiveWithFallback(source, target, 0o600),
    (error) => error?.code === "EEXIST",
  );
  assert.equal(lstatCalls >= 2, true, "the post-chmod pathname revalidation ran");
  assert.equal(
    fs.readFileSync(target, "utf8"),
    "written by another process",
    "the concurrent replacement is never removed by the cleanup",
  );
});

test("copyFileExclusiveWithFallback does not chmod a concurrent replacement on the unreadable-copy path", async (t) => {
  const dir = makeTempDir("copy-fallback-race-unreadable-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "staged");
  const target = path.join(dir, "target");
  fs.writeFileSync(source, "our copy bytes");
  // The accelerated copy produced the copy, but by the time the
  // metadata-changing open runs, another process has already replaced the
  // pathname with its own unreadable file: the pathname-level chmod fallback
  // must fail closed before mutating that replacement's permissions.
  const openOriginal = fs.promises.open;
  const openRestore = stubPromises("open", async (...args) => {
    if (args[0] === target) {
      fs.unlinkSync(target);
      fs.writeFileSync(target, "written by another process");
      fs.chmodSync(target, 0o000);
      throw Object.assign(new Error(`EACCES: permission denied, open ${target}`), { code: "EACCES" });
    }
    return openOriginal.apply(fs.promises, args);
  });
  t.after(openRestore);
  const chmodRestore = stubPromises("chmod", async () => {
    throw new Error("the pathname chmod must not run on a replaced target");
  });
  t.after(chmodRestore);
  await assert.rejects(
    () => copyFileExclusiveWithFallback(source, target, 0o664),
    (error) => error?.code === "EEXIST" && error.targetOwnershipRelinquished === true,
  );
  // The replacement was created mode-0000; it must still carry that mode
  // (and its own bytes) because the fallback never touched the pathname.
  const replacementStat = fs.statSync(target);
  assert.equal(replacementStat.mode & 0o7777, 0o000,
    "the concurrent replacement's permissions were never mutated");
  assert.equal(replacementStat.size, Buffer.byteLength("written by another process"),
    "the concurrent replacement's bytes were never touched");
});

test("copyFileExclusiveWithFallback does not chmod a concurrent replacement on the streamed path", async (t) => {
  const dir = makeTempDir("copy-fallback-race-stream-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "staged");
  const target = path.join(dir, "target");
  fs.writeFileSync(source, "our copy bytes");
  // Force the streamed path and a umask-narrowed mode so the post-stream
  // chmod runs, then let another process win the pathname between the
  // created inode being pinned and the chmod's owned open.
  const copyRestore = stubPromises("copyFile", enotsupCopyFile());
  t.after(copyRestore);
  const openOriginal = fs.promises.open;
  const openRestore = stubPromises("open", async (...args) => {
    if (args[0] === target && args[1] !== "wx") {
      fs.unlinkSync(target);
      fs.writeFileSync(target, "written by another process");
    }
    return openOriginal.apply(fs.promises, args);
  });
  t.after(openRestore);
  await assert.rejects(
    () => copyFileExclusiveWithFallback(source, target, 0o664),
    (error) => error?.code === "EEXIST",
  );
  assert.equal(
    fs.readFileSync(target, "utf8"),
    "written by another process",
    "the concurrent replacement is neither chmoded nor removed",
  );
});

test("copyFileExclusiveWithFallback flags a relabelled target so callers skip its cleanup", async (t) => {
  const dir = makeTempDir("copy-fallback-relabel-flag-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "staged");
  const target = path.join(dir, "target");
  fs.writeFileSync(source, "our copy bytes");
  // The accelerated copy must succeed so the relabel-then-verify replacement
  // branch runs; the mount then refuses chmod at both the pathname and the
  // owned-handle level, like gvfsd-fuse-style destinations.
  const chmodRestore = stubPromises("chmod", async () => {
    throw Object.assign(new Error("ENOTSUP: operation not supported"), { code: "ENOTSUP" });
  });
  t.after(chmodRestore);
  const handleChmodRestore = makeHandleStub(
    "chmod",
    Object.assign(new Error("ENOTSUP: operation not supported"), { code: "ENOTSUP" }),
  );
  t.after(handleChmodRestore);
  // Simulate another writer swapping the pathname after the produced copy's
  // identity was pinned but before the relabel: whatever moves to the side
  // name must not verify as the copy this module produced. The fallback then
  // relabels it back onto the pathname (link) and reports the handover.
  const lstatOriginal = fs.promises.lstat;
  const lstatRestore = stubPromises("lstat", async (...args) => {
    if (!String(args[0]).includes(".stale-")) {
      return lstatOriginal.apply(fs.promises, args);
    }
    return { dev: 999999, ino: 999999, size: 123456 };
  });
  t.after(lstatRestore);
  let error = null;
  try {
    await copyFileExclusiveWithFallback(source, target, 0o600);
  } catch (thrown) {
    error = thrown;
  }
  assert.equal(error?.code, "EEXIST", "the relabelled target fails closed like COPYFILE_EXCL");
  assert.equal(error.targetOwnershipRelinquished, true);
  assert.equal(typeof error.stalePath, "string");
  assert.ok(error.stalePath.startsWith(`${target}.stale-`));
  assert.equal(
    fs.readFileSync(target, "utf8"),
    "our copy bytes",
    "the restored pathname is never removed by this module",
  );
});

test("copyFileExclusiveWithFallback flags a stream-open EEXIST so callers skip its cleanup", async (t) => {
  const dir = makeTempDir("copy-fallback-stream-race-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "staged");
  const target = path.join(dir, "target");
  fs.writeFileSync(source, "our copy bytes");
  // Another writer creates `target` after the accelerated-copy path decides to
  // stream (copyFile fails with a fallback errno) but before the exclusive
  // ("wx") stream open, so the open rejects with a bare EEXIST. The fallback
  // must mark the handover so the caller's pre-commit cleanup leaves that
  // writer's file in place instead of unlinking it.
  const copyRestore = stubPromises("copyFile", async () => {
    fs.writeFileSync(target, "written by another process");
    throw Object.assign(new Error("ENOTSUP: operation not supported on socket, copyfile"), { code: "ENOTSUP" });
  });
  t.after(copyRestore);
  let error = null;
  try {
    await copyFileExclusiveWithFallback(source, target, 0o664);
  } catch (thrown) {
    error = thrown;
  }
  assert.equal(error?.code, "EEXIST", "the won-by-another-writer pathname fails closed like COPYFILE_EXCL");
  assert.equal(error.targetOwnershipRelinquished, true);
  assert.equal(
    fs.readFileSync(target, "utf8"),
    "written by another process",
    "the concurrent writer's file is never removed by this module",
  );
});

test("promoteLocalTransfer preserves a ready pathname whose ownership the fallback relinquished", async (t) => {
  const dir = makeTempDir("promote-relinquished-ready-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const staged = path.join(dir, "staged");
  const target = path.join(dir, "target");
  fs.writeFileSync(staged, "our copy bytes");
  fs.writeFileSync(target, "original");
  // Force the EXDEV staging rename so the fallback copy creates the private
  // ready pathname, then refuse chmod so the relabel-then-verify branch runs.
  const renameOriginal = fs.promises.rename;
  const renameRestore = stubPromises("rename", async (...args) => {
    if (args[0] === staged) {
      throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
    }
    return renameOriginal.apply(fs.promises, args);
  });
  t.after(renameRestore);
  const chmodRestore = stubPromises("chmod", async () => {
    throw Object.assign(new Error("ENOTSUP: operation not supported"), { code: "ENOTSUP" });
  });
  t.after(chmodRestore);
  const handleChmodRestore = makeHandleStub(
    "chmod",
    Object.assign(new Error("ENOTSUP: operation not supported"), { code: "ENOTSUP" }),
  );
  t.after(handleChmodRestore);
  // The relabel moves a pathname that no longer holds the produced copy: the
  // fallback reports the handover instead of blessing a replacement, and the
  // promotion's pre-commit cleanup must then leave the ready pathname in
  // place rather than unlinking whoever now owns it.
  const lstatOriginal = fs.promises.lstat;
  const lstatRestore = stubPromises("lstat", async (...args) => {
    if (!String(args[0]).includes(".stale-")) {
      return lstatOriginal.apply(fs.promises, args);
    }
    return { dev: 999999, ino: 999999, size: 123456 };
  });
  t.after(lstatRestore);
  let error = null;
  try {
    await transferBridge._promoteLocalTransferForTests(staged, target, {});
  } catch (thrown) {
    error = thrown;
  }
  assert.equal(error?.code, "EEXIST", "the relabelled ready pathname fails closed");
  assert.equal(error.targetOwnershipRelinquished, true);
  assert.equal(
    fs.readdirSync(dir).filter((name) => name.endsWith(".ready")).length,
    1,
    "the ready pathname changed hands, so the caller must not unlink it",
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
  // Metadata refusal is simulated at both the pathname and the owned-handle
  // level, like gvfsd-fuse-style mounts that reject chmod entirely.
  const chmodRestore = stubPromises("chmod", async () => {
    throw Object.assign(new Error("ENOTSUP: operation not supported"), { code: "ENOTSUP" });
  });
  t.after(chmodRestore);
  const handleChmodRestore = makeHandleStub(
    "chmod",
    Object.assign(new Error("ENOTSUP: operation not supported"), { code: "ENOTSUP" }),
  );
  t.after(handleChmodRestore);
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
  // A pathname-based retry must never run: a lstat-verified name can be
  // replaced before the stamp lands on the replacement's inode.
  let pathnameUtimesCalls = 0;
  const pathnameUtimesRestore = stubPromises("utimes", async () => {
    pathnameUtimesCalls += 1;
  });
  t.after(linkRestore);
  t.after(chmodRestore);
  t.after(utimesRestore);
  t.after(pathnameUtimesRestore);
  const identity = await localFilePublish.publishLocalFileExclusive(source, target);
  assert.equal(fs.readFileSync(target, "utf8"), "gvfs bytes");
  assert.equal(identity.size, fs.lstatSync(target).size);
  assert.equal(fs.lstatSync(target).isFile(), true);
  // The owned-handle futimens was refused, so the publication must fail
  // closed: the pathname is never stamped, and the caller gets
  // `timestampsPreserved: false` to run its own descriptor-pinned stamp.
  assert.equal(pathnameUtimesCalls, 0);
  assert.notEqual(fs.statSync(target).mtimeMs, 1_700_000_000_000);
  assert.equal(identity.timestampsPreserved, false);
});

test("local promotion reports the prepared stamp as unapplied when publication cannot carry the timestamps", async (t) => {
  const dir = makeTempDir("promote-mtime-unstamped-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const staged = path.join(dir, "staged");
  const target = path.join(dir, "target");
  fs.writeFileSync(staged, "timestamped bytes");
  fs.utimesSync(staged, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  const linkRestore = stubPromises("link", async () => {
    throw Object.assign(new Error("ENOTSUP: operation not supported, link"), { code: "ENOTSUP" });
  });
  const handleRestore = makeHandleStub(
    "utimes",
    Object.assign(new Error("ENOTSUP: operation not supported"), { code: "ENOTSUP" }),
  );
  // The pathname stamp on the prepared file succeeds, but the published copy
  // cannot be stamped: both the owned-handle futimens and the pathname-based
  // utimensat on the target are refused. The caller must not be told the
  // timestamps are prepared, or its final best-effort stamp never runs.
  const utimesOriginal = fs.promises.utimes;
  const utimesRestore = stubPromises("utimes", async (...args) => {
    if (args[0] === target) {
      throw Object.assign(new Error("ENOTSUP: operation not supported, utimensat"), { code: "ENOTSUP" });
    }
    return utimesOriginal.apply(fs.promises, args);
  });
  t.after(linkRestore);
  t.after(handleRestore);
  t.after(utimesRestore);
  const committed = [];
  await transferBridge._promoteLocalTransferForTests(staged, target, {
    sourceSoftIdentity: { mtimeMs: 1_700_000_000_000 },
    onCommit(publishedIdentity, localMtimePrepared) {
      committed.push({ publishedIdentity, localMtimePrepared });
    },
  });
  assert.equal(fs.readFileSync(target, "utf8"), "timestamped bytes");
  assert.equal(committed.length, 1);
  assert.equal(committed[0].publishedIdentity.timestampsPreserved, false);
  assert.equal(
    committed[0].localMtimePrepared, false,
    "the unapplied prepared stamp is not reported as prepared",
  );
  assert.notEqual(
    Math.floor(fs.statSync(target).mtimeMs / 1000), 1_700_000_000,
    "the published file is unstamped, so the final stamp must still be attempted",
  );
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
