"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const bridge = require("./transferBridge.cjs");
const temp = require("./tempDirBridge.cjs");

function rememberedExpectation(parent, target) {
  const parentStat = fs.statSync(parent, { bigint: true });
  const targetStat = fs.lstatSync(target, { bigint: true });
  return {
    parentRealPath: fs.realpathSync(parent),
    parentIdentity: `${parentStat.dev}:${parentStat.ino}`,
    parentBirthtimeNs: String(parentStat.birthtimeNs),
    targetIdentity: `${targetStat.dev}:${targetStat.ino}`,
    targetBirthtimeNs: String(targetStat.birthtimeNs),
    targetCtimeNs: String(targetStat.ctimeNs),
    targetMtimeNs: String(targetStat.mtimeNs),
    targetSha256: require("node:crypto").createHash("sha256").update(fs.readFileSync(target)).digest("hex"),
  };
}

test("remembered download replaces the same verified local file", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("remembered-publish")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  fs.writeFileSync(staged, "download");
  fs.writeFileSync(target, "original");
  let publishedIdentity;
  await bridge._promoteLocalTransferForTests(staged, target, {
    requestedTargetPath: target,
    expectedLocalTarget: rememberedExpectation(root, target),
    capturePublishedContentHash: true,
    onCommit(identity) { publishedIdentity = identity; },
  });
  assert.equal(fs.readFileSync(target, "utf8"), "download");
  const publishedStat = fs.lstatSync(target, { bigint: true });
  assert.deepEqual(publishedIdentity, {
    dev: String(publishedStat.dev), ino: String(publishedStat.ino),
    size: Number(publishedStat.size), birthtimeNs: String(publishedStat.birthtimeNs),
    ctimeNs: String(publishedStat.ctimeNs), mtimeNs: String(publishedStat.mtimeNs),
    sha256: require("node:crypto").createHash("sha256").update("download").digest("hex"),
  });
});

test("published file edited with restored mtime is never remembered", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("published-restored-mtime")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  fs.writeFileSync(staged, "download");
  const unlink = fs.promises.unlink;
  t.after(() => { fs.promises.unlink = unlink; });
  let edited = false;
  fs.promises.unlink = async (file) => {
    const result = await unlink(file);
    if (!edited && String(file).endsWith(".ready")) {
      edited = true;
      const originalMtime = fs.statSync(target).mtime;
      fs.writeFileSync(target, "modified");
      fs.utimesSync(target, originalMtime, originalMtime);
    }
    return result;
  };
  let publishedIdentity = "unset";
  await bridge._promoteLocalTransferForTests(staged, target, {
    capturePublishedContentHash: true,
    onCommit(identity) { publishedIdentity = identity; },
  });
  assert.equal(edited, true);
  assert.equal(fs.readFileSync(target, "utf8"), "modified");
  assert.equal(publishedIdentity, null);
});

test("remembered download preserves an in-place edit just before moving the original", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("remembered-inplace-race")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  fs.writeFileSync(staged, "download");
  fs.writeFileSync(target, "original");
  const expectedLocalTarget = rememberedExpectation(root, target);
  const rename = fs.promises.rename;
  t.after(() => { fs.promises.rename = rename; });
  let edited = false;
  fs.promises.rename = async (from, to) => {
    if (!edited && from === target && String(to).endsWith(".backup")) {
      edited = true;
      fs.writeFileSync(target, "modified"); // same inode and byte length
      // Some filesystems coalesce immediate timestamp updates. Ensure this
      // simulated external write has an observable change in file metadata.
      fs.utimesSync(target, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
    }
    return rename(from, to);
  };
  await assert.rejects(() => bridge._promoteLocalTransferForTests(staged, target, {
    requestedTargetPath: target, expectedLocalTarget,
  }), /Local download target changed during replacement/);
  assert.equal(edited, true);
  assert.equal(fs.readFileSync(target, "utf8"), "modified");
});

test("remembered download checks backup bytes even when its mtime appears unchanged", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("remembered-backup-hash")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  fs.writeFileSync(staged, "download");
  fs.writeFileSync(target, "original");
  const expectedLocalTarget = rememberedExpectation(root, target);
  const rename = fs.promises.rename;
  const lstat = fs.promises.lstat;
  t.after(() => { fs.promises.rename = rename; fs.promises.lstat = lstat; });
  fs.promises.rename = async (from, to) => {
    if (from === target && String(to).endsWith(".backup")) {
      fs.writeFileSync(target, "modified"); // same file number and byte length
    }
    return rename(from, to);
  };
  // Model an external editor that restores mtime after its write. The backup
  // metadata alone must not authorize replacing these different bytes.
  fs.promises.lstat = async (file, options) => {
    const stat = await lstat(file, options);
    if (!String(file).endsWith(".backup")) return stat;
    return new Proxy(stat, { get(value, key) {
      if (key === "mtimeNs") return BigInt(expectedLocalTarget.targetMtimeNs);
      return Reflect.get(value, key);
    } });
  };
  await assert.rejects(() => bridge._promoteLocalTransferForTests(staged, target, {
    requestedTargetPath: target, expectedLocalTarget,
  }), /Local download target content changed during replacement/);
  assert.equal(fs.readFileSync(target, "utf8"), "modified");
});

test("remembered download stops if the selected file disappears at replacement", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("remembered-disappeared")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  fs.writeFileSync(staged, "download");
  fs.writeFileSync(target, "original");
  const expectedLocalTarget = rememberedExpectation(root, target);
  const rename = fs.promises.rename;
  t.after(() => { fs.promises.rename = rename; });
  fs.promises.rename = async (from, to) => {
    if (from === target && String(to).endsWith(".backup")) fs.unlinkSync(target);
    return rename(from, to);
  };
  await assert.rejects(() => bridge._promoteLocalTransferForTests(staged, target, {
    requestedTargetPath: target, expectedLocalTarget,
  }), /Remembered local download target disappeared/);
  assert.equal(fs.existsSync(target), false);
});

test("replacement keeps large file numbers exact when checking its backup", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("large-backup-identity")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  fs.writeFileSync(staged, "download");
  fs.writeFileSync(target, "original");
  const dev = 9007199254740993n;
  const ino = 9007199254740995n;
  const originalLstat = fs.promises.lstat;
  t.after(() => { fs.promises.lstat = originalLstat; });
  fs.promises.lstat = async (candidate, options) => {
    const stat = await originalLstat(candidate, options);
    if (!String(candidate).endsWith(".backup")) return stat;
    return new Proxy(stat, {
      get(value, key) {
        if (key === "dev") return options?.bigint ? dev : Number(dev);
        if (key === "ino") return options?.bigint ? ino : Number(ino);
        return Reflect.get(value, key);
      },
    });
  };
  await bridge._promoteLocalTransferForTests(staged, target, {
    validateTarget: async () => ({
      stableIdentity: `${dev}:${ino}:${fs.statSync(target).size}`,
      existingMode: 0o644,
      targetIdentity: `${dev}:${ino}:original`,
    }),
  });
  assert.equal(fs.readFileSync(target, "utf8"), "download");
});

test("remembered download does not replace a different file created during transfer", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("remembered-race")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  fs.writeFileSync(staged, "download");
  fs.writeFileSync(target, "original");
  const expectedLocalTarget = rememberedExpectation(root, target);

  fs.renameSync(target, path.join(root, "moved-original"));
  fs.writeFileSync(target, "unrelated");
  await assert.rejects(
    () => bridge._promoteLocalTransferForTests(staged, target, {
      requestedTargetPath: target,
      expectedLocalTarget,
    }),
    /Remembered local download target changed/,
  );
  assert.equal(fs.readFileSync(target, "utf8"), "unrelated");
  assert.equal(fs.readFileSync(path.join(root, "moved-original"), "utf8"), "original");
});

test("remembered download rejects a reused file number with a different creation time", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("remembered-inode")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  fs.writeFileSync(staged, "download");
  fs.writeFileSync(target, "unrelated");
  const expectedLocalTarget = rememberedExpectation(root, target);
  expectedLocalTarget.targetBirthtimeNs = String(BigInt(expectedLocalTarget.targetBirthtimeNs) - 1n);
  await assert.rejects(() => bridge._promoteLocalTransferForTests(staged, target, {
    requestedTargetPath: target,
    expectedLocalTarget,
  }), /Remembered local download target changed/);
  assert.equal(fs.readFileSync(target, "utf8"), "unrelated");
});

test("remembered download rejects a replaced parent even when the file is the same", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("remembered-parent")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parent = path.join(root, "selected");
  const movedParent = path.join(root, "moved");
  const target = path.join(parent, "target");
  const staged = path.join(root, "staged");
  fs.mkdirSync(parent);
  fs.writeFileSync(target, "original");
  fs.writeFileSync(staged, "download");
  const expectedLocalTarget = rememberedExpectation(parent, target);

  fs.renameSync(parent, movedParent);
  fs.mkdirSync(parent);
  fs.linkSync(path.join(movedParent, "target"), target);
  await assert.rejects(
    () => bridge._promoteLocalTransferForTests(staged, target, {
      requestedTargetPath: target,
      expectedLocalTarget,
    }),
    /Remembered local download target changed/,
  );
  assert.equal(fs.readFileSync(target, "utf8"), "original");
});

for (const restore of [false, true]) {
  test(`local ${restore ? "restore" : "publish"} never overwrites a last-moment concurrent file`, async (t) => {
    const root = fs.mkdtempSync(`${temp.getTempFilePath("publish-race")}-`);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const staged = path.join(root, "staged");
    const target = path.join(root, "target");
    fs.writeFileSync(staged, "download");
    fs.writeFileSync(target, "original");
    let injected = false;
    for (const method of ["rename", "link"]) {
      const original = fs.promises[method];
      t.after(() => { fs.promises[method] = original; });
      fs.promises[method] = async (...args) => {
        if (!injected && args[1] === target && String(args[0]).endsWith(restore ? ".backup" : ".ready")) {
          injected = true;
          fs.writeFileSync(target, "concurrent");
        }
        return original.apply(fs.promises, args);
      };
    }
    await assert.rejects(() => bridge._promoteLocalTransferForTests(staged, target,
      restore ? { validateTarget: async () => ({ stableIdentity: "wrong" }) } : {}));
    assert.equal(injected, true);
    assert.equal(fs.readFileSync(target, "utf8"), "concurrent");
    const backup = fs.readdirSync(root).find(name => name.endsWith(".backup"));
    assert.ok(backup, "retain original for recovery");
    assert.equal(fs.readFileSync(path.join(root, backup), "utf8"), "original");
  });
}

test("an explicitly absent destination is never moved aside if another writer creates it", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("publish-absent")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  fs.writeFileSync(staged, "download");
  await assert.rejects(() => bridge._promoteLocalTransferForTests(staged, target, {
    validateTarget: async () => {
      fs.writeFileSync(target, "concurrent");
      return { targetIdentity: "missing", existingMode: null };
    },
  }));
  assert.equal(fs.readFileSync(target, "utf8"), "concurrent");
});

for (const failCopy of [false, true]) {
  test(`exclusive copy fallback ${failCopy ? "retains recovery files after a write failure" : "publishes complete bytes without hardlinks"}`, async (t) => {
    const root = fs.mkdtempSync(`${temp.getTempFilePath("publish-fallback")}-`);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const staged = path.join(root, "staged");
    const target = path.join(root, "target");
    const payload = Buffer.alloc(2 * 1024 * 1024 + 7, 173);
    fs.writeFileSync(staged, payload);
    fs.writeFileSync(target, "original");
    const link = fs.promises.link;
    fs.promises.link = async () => { throw Object.assign(new Error("hardlinks unavailable"), { code: "ENOTSUP" }); };
    t.after(() => { fs.promises.link = link; });
    if (failCopy) {
      const open = fs.promises.open;
      fs.promises.open = async (...args) => {
        const handle = await open.apply(fs.promises, args);
        if (args[0] === target && args[1] === "wx") {
          handle.write = async () => {
            // A replacement entry must survive even when the owned old handle fails.
            fs.unlinkSync(target);
            fs.writeFileSync(target, "concurrent");
            throw new Error("disk write failed");
          };
        }
        return handle;
      };
      t.after(() => { fs.promises.open = open; });
      await assert.rejects(() => bridge._promoteLocalTransferForTests(staged, target), /Recovery files preserved/);
      assert.equal(fs.readFileSync(target, "utf8"), "concurrent");
      const names = fs.readdirSync(root);
      assert.deepEqual(fs.readFileSync(path.join(root, names.find(name => name.endsWith(".ready")))), payload);
      assert.equal(fs.readFileSync(path.join(root, names.find(name => name.endsWith(".backup"))), "utf8"), "original");
    } else {
      let publishedIdentity;
      await bridge._promoteLocalTransferForTests(staged, target, {
        capturePublishedContentHash: true,
        onCommit(identity) { publishedIdentity = identity; },
      });
      assert.deepEqual(fs.readFileSync(target), payload);
      assert.equal(publishedIdentity?.sha256,
        require("node:crypto").createHash("sha256").update(payload).digest("hex"));
      assert.deepEqual(fs.readdirSync(root), ["target"]);
    }
  });
}

test("cancellation before publication restores the original destination", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("publish-cancel")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  fs.writeFileSync(staged, "download");
  fs.writeFileSync(target, "original");
  await assert.rejects(() => bridge._promoteLocalTransferForTests(staged, target, {
    assertNotCancelled: () => { if (!fs.existsSync(target)) throw new Error("Transfer cancelled"); },
  }), /cancelled/);
  assert.equal(fs.readFileSync(target, "utf8"), "original");
});

for (const interruption of ["cancel", "replace", "restore-replace"]) {
  test(`fallback ${interruption} during copying preserves complete recovery files`, async (t) => {
    const root = fs.mkdtempSync(`${temp.getTempFilePath("publish-mid-copy")}-`);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const staged = path.join(root, "staged");
    const target = path.join(root, "target");
    const payload = Buffer.alloc(3 * 1024 * 1024, 42);
    fs.writeFileSync(staged, payload);
    fs.writeFileSync(target, "original");
    const link = fs.promises.link;
    const open = fs.promises.open;
    let cancelled = false;
    let writes = 0;
    fs.promises.link = async () => { throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" }); };
    fs.promises.open = async (...args) => {
      const handle = await open.apply(fs.promises, args);
      if (args[0] === target && args[1] === "wx") {
        const write = handle.write.bind(handle);
        handle.write = async (...writeArgs) => {
          const result = await write(...writeArgs);
          if (++writes === 1) {
            if (interruption === "cancel") cancelled = true;
            else { fs.unlinkSync(target); fs.writeFileSync(target, "concurrent"); }
          }
          return result;
        };
      }
      return handle;
    };
    t.after(() => { fs.promises.link = link; fs.promises.open = open; });
    let committed = false;
    await assert.rejects(() => bridge._promoteLocalTransferForTests(staged, target, {
      ...(interruption === "restore-replace" ? { validateTarget: async () => ({ stableIdentity: "wrong" }) } : {}),
      assertNotCancelled() { if (cancelled) throw new Error("Transfer cancelled"); },
      onCommit() { committed = true; },
    }), /Recovery files preserved/);
    assert.equal(committed, false);
    if (interruption === "cancel") assert.equal(writes, 1);
    else assert.equal(fs.readFileSync(target, "utf8"), "concurrent");
    const names = fs.readdirSync(root);
    assert.deepEqual(fs.readFileSync(path.join(root, names.find(name => name.endsWith(".ready")))), payload);
    assert.equal(fs.readFileSync(path.join(root, names.find(name => name.endsWith(".backup"))), "utf8"), "original");
  });
}

test("cancelled replacement restores original timestamps through the copy fallback", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("publish-restore-times")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  fs.writeFileSync(staged, "download");
  fs.writeFileSync(target, "original", { mode: 0o640 });
  const atime = new Date("2019-01-02T00:00:00Z");
  const mtime = new Date("2020-02-03T00:00:00Z");
  fs.utimesSync(target, atime, mtime);
  const link = fs.promises.link;
  fs.promises.link = async () => { throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" }); };
  t.after(() => { fs.promises.link = link; });
  await assert.rejects(() => bridge._promoteLocalTransferForTests(staged, target, {
    assertNotCancelled() { if (!fs.existsSync(target)) throw new Error("Transfer cancelled"); },
  }), /cancelled/);
  const stat = fs.statSync(target);
  assert.equal(stat.mtimeMs, mtime.getTime());
  assert.equal(stat.atimeMs, atime.getTime());
  assert.equal(fs.readFileSync(target, "utf8"), "original");
});

for (const replaceAfterCommit of [false, true]) {
  test(`local publication prepares timestamps before restrictive permissions${replaceAfterCommit ? " and leaves post-commit replacement alone" : ""}`, async (t) => {
    const root = fs.mkdtempSync(`${temp.getTempFilePath("publish-mtime")}-`);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const staged = path.join(root, "staged");
    const target = path.join(root, "target");
    fs.writeFileSync(staged, "download");
    const transfer = {
      targetType: "local", targetPath: target,
      sourceSoftIdentity: { mtimeMs: 1_700_000_000_000 },
    };
    await bridge._promoteLocalTransferForTests(staged, target, {
      existingMode: 0,
      sourceSoftIdentity: transfer.sourceSoftIdentity,
      onCommit(identity) {
        transfer.publishedLocalIdentity = identity;
        transfer.localMtimePrepared = true;
        if (replaceAfterCommit) {
          fs.renameSync(target, path.join(root, "published"));
          fs.writeFileSync(target, "concurrent");
          fs.utimesSync(target, 1_600_000_000, 1_600_000_000);
        }
      },
    });
    await bridge._preserveTransferredDestinationMtimeForTests(transfer);
    const stat = fs.statSync(target);
    assert.equal(Math.floor(stat.mtimeMs / 1000), replaceAfterCommit ? 1_600_000_000 : 1_700_000_000);
    if (!replaceAfterCommit) assert.equal(stat.mode & 0o777, 0);
  });
}

test("fallback close failure retains the original backup and prepared replacement", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("publish-close")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  fs.writeFileSync(staged, "download");
  fs.writeFileSync(target, "original");
  t.mock.method(fs.promises, "link", async () => { throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" }); });
  const open = fs.promises.open;
  t.mock.method(fs.promises, "open", async (...args) => {
    const handle = await open(...args);
    if (args[0] === target && args[1] === "wx") {
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); throw new Error("close failed"); };
    }
    return handle;
  });
  await assert.rejects(bridge._promoteLocalTransferForTests(staged, target), (error) => {
    assert.equal(error.recoveryFailed, true);
    assert.equal(fs.readFileSync(error.remoteBackupPath, "utf8"), "original");
    return true;
  });
  const ready = fs.readdirSync(root).find((name) => name.endsWith(".ready"));
  assert.equal(fs.readFileSync(path.join(root, ready), "utf8"), "download");
});

for (const mode of [0o200, 0]) {
  test(`copy fallback publishes prepared bytes with destination mode ${mode.toString(8)}`, async (t) => {
    const root = fs.mkdtempSync(`${temp.getTempFilePath("publish-mode")}-`);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const staged = path.join(root, "staged");
    const target = path.join(root, "target");
    fs.writeFileSync(staged, "download");
    t.mock.method(fs.promises, "link", async () => { throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" }); });
    await bridge._promoteLocalTransferForTests(staged, target, {
      existingMode: mode, sourceSoftIdentity: { mtimeMs: 1_700_000_000_000 },
    });
    const stat = fs.statSync(target);
    assert.equal(stat.mode & 0o777, mode);
    assert.equal(Math.floor(stat.mtimeMs / 1000), 1_700_000_000);
    fs.chmodSync(target, 0o600);
    assert.equal(fs.readFileSync(target, "utf8"), "download");
  });
}

test("direct local timestamp preservation supports a write-only target", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("stamp-writeonly")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "target");
  fs.writeFileSync(target, "download");
  fs.chmodSync(target, 0o200);
  await bridge._preserveTransferredDestinationMtimeForTests({
    targetType: "local", targetPath: target,
    sourceSoftIdentity: { mtimeMs: 1_700_000_000_000 },
  });
  const stat = fs.statSync(target);
  assert.equal(stat.mode & 0o777, 0o200);
  assert.equal(Math.floor(stat.mtimeMs / 1000), 1_700_000_000);
});

test("write-only timestamp fallback leaves a later pathname replacement unchanged", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("stamp-writeonly-race")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "target");
  const published = path.join(root, "published");
  fs.writeFileSync(target, "download");
  fs.chmodSync(target, 0o200);
  let replaced = false;
  const open = fs.promises.open;
  t.mock.method(fs.promises, "open", async (...args) => {
    if (args[0] === target && args[1] === "r") {
      throw Object.assign(new Error("read access denied"), { code: "EACCES" });
    }
    const handle = await open(...args);
    if (args[0] === target && args[1] === fs.constants.O_WRONLY) {
      const utimes = handle.utimes.bind(handle);
      handle.utimes = async (...times) => {
        fs.renameSync(target, published);
        fs.writeFileSync(target, "concurrent");
        fs.utimesSync(target, 1_600_000_000, 1_600_000_000);
        replaced = true;
        return utimes(...times);
      };
    }
    return handle;
  });
  await bridge._preserveTransferredDestinationMtimeForTests({
    targetType: "local", targetPath: target,
    sourceSoftIdentity: { mtimeMs: 1_700_000_000_000 },
  });
  assert.equal(replaced, true);
  assert.equal(Math.floor(fs.statSync(target).mtimeMs / 1000), 1_600_000_000);
  assert.equal(Math.floor(fs.statSync(published).mtimeMs / 1000), 1_700_000_000);
});

test("copy fallback refuses to move an unreadable existing destination", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("publish-restrictive")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  const payload = Buffer.alloc(1024 * 1024 + 3, 7);
  fs.writeFileSync(staged, payload);
  fs.writeFileSync(target, "original", { mode: 0o200 });
  const link = fs.promises.link;
  fs.promises.link = async () => { throw Object.assign(new Error("hardlinks unavailable"), { code: "ENOTSUP" }); };
  t.after(() => { fs.promises.link = link; });
  const open = fs.promises.open;
  t.mock.method(fs.promises, "open", async (...args) => {
    if (args[0] === target && args[1] === "r") throw Object.assign(new Error("read access denied"), { code: "EACCES" });
    return open(...args);
  });
  await assert.rejects(bridge._promoteLocalTransferForTests(staged, target, { existingMode: 0o200 }), /hardlink recovery unavailable/);
  const stat = fs.statSync(target);
  assert.equal(stat.mode & 0o777, 0o200);
  assert.equal(stat.size, "original".length);
  fs.chmodSync(target, 0o600); // grant readback for verification
  assert.equal(fs.readFileSync(target, "utf8"), "original");
  assert.deepEqual(fs.readdirSync(root), ["target"]);
});

for (const mode of [0o200, 0]) {
  test(`unreadable original remains at destination when safe restoration is unavailable: ${mode.toString(8)}`, async (t) => {
    const root = fs.mkdtempSync(`${temp.getTempFilePath("restore-unreadable")}-`);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const staged = path.join(root, "staged");
    const target = path.join(root, "target");
    fs.writeFileSync(staged, "download");
    fs.writeFileSync(target, "original");
    fs.chmodSync(target, mode);
    const open = fs.promises.open;
    t.mock.method(fs.promises, "open", async (...args) => {
      if (args[1] === "r" && (args[0] === target || String(args[0]).endsWith(".backup"))) {
        throw Object.assign(new Error("read access denied"), { code: "EACCES" });
      }
      return open(...args);
    });
    let cancelled = false;
    const rename = fs.promises.rename;
    t.mock.method(fs.promises, "rename", async (...args) => {
      const result = await rename(...args);
      if (args[0] === target) cancelled = true;
      return result;
    });
    t.mock.method(fs.promises, "link", async () => { throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" }); });
    await assert.rejects(bridge._promoteLocalTransferForTests(staged, target, {
      existingMode: mode,
      assertNotCancelled() { if (cancelled) throw new Error("Transfer cancelled"); },
    }));
    assert.equal(fs.existsSync(target), true, "unrestorable original must not be moved away");
    assert.equal(fs.statSync(target).mode & 0o777, mode);
    fs.chmodSync(target, 0o600);
    assert.equal(fs.readFileSync(target, "utf8"), "original");
  });
}

test("copy recovery retains original read access after its permissions become restrictive", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("restore-held-handle")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  fs.writeFileSync(staged, "download");
  fs.writeFileSync(target, "original");
  let cancelled = false;
  const rename = fs.promises.rename;
  t.mock.method(fs.promises, "rename", async (...args) => {
    const result = await rename(...args);
    if (args[0] === target) {
      fs.chmodSync(args[1], 0);
      cancelled = true;
    }
    return result;
  });
  t.mock.method(fs.promises, "link", async () => { throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" }); });
  await assert.rejects(bridge._promoteLocalTransferForTests(staged, target, {
    assertNotCancelled() { if (cancelled) throw new Error("Transfer cancelled"); },
  }), /Transfer cancelled/);
  assert.equal(fs.statSync(target).mode & 0o777, 0);
  fs.chmodSync(target, 0o600);
  assert.equal(fs.readFileSync(target, "utf8"), "original");
  assert.deepEqual(fs.readdirSync(root), ["target"]);
});
