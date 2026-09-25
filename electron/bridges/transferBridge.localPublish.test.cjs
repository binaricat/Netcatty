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

test("verified remembered download retains its backup after publication", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("remembered-retain-backup")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  fs.writeFileSync(staged, "download");
  fs.writeFileSync(target, "original");
  await bridge._promoteLocalTransferForTests(staged, target, {
    requestedTargetPath: target,
    expectedLocalTarget: rememberedExpectation(root, target),
  });
  assert.equal(fs.readFileSync(target, "utf8"), "download");
  // The verification snapshot cannot guard the backup deletion: a late write
  // from a process holding the original inode open would otherwise lose its
  // only remaining name. The verified backup must therefore be retained.
  const backupName = fs.readdirSync(root).find((name) => name.endsWith(".backup"));
  assert.ok(backupName, "retain the verified backup for late writers");
  assert.equal(fs.readFileSync(path.join(root, backupName), "utf8"), "original");
});

test("repeated remembered downloads supersede the previous backup", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("remembered-rolling-backup")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  fs.writeFileSync(staged, "second");
  fs.writeFileSync(target, "first");
  await bridge._promoteLocalTransferForTests(staged, target, {
    requestedTargetPath: target,
    expectedLocalTarget: rememberedExpectation(root, target),
  });
  // The renderer re-remembers the published target before the next repeat.
  fs.writeFileSync(staged, "third");
  await bridge._promoteLocalTransferForTests(staged, target, {
    requestedTargetPath: target,
    expectedLocalTarget: rememberedExpectation(root, target),
  });
  assert.equal(fs.readFileSync(target, "utf8"), "third");
  const backups = fs.readdirSync(root).filter((name) => name.includes("netcatty.backup"));
  const fixed = backups.find((name) => name === ".target.netcatty.backup");
  const versioned = backups.find((name) => name.startsWith(".target.netcatty.backup.")
    && name !== ".target.netcatty.backup.owner");
  assert.ok(fixed, "keep the verified backup of the latest replacement");
  assert.equal(fs.readFileSync(path.join(root, fixed), "utf8"), "second");
  // Once the replacement is committed, the superseded copy is dropped so
  // repeated downloads keep a bounded recovery set instead of leaving one
  // permanent full-size file per version beside the destination. The verified
  // backup at the fixed name is retained for late writers.
  assert.ok(!versioned, "remove the superseded recovery copy after commit");
  assert.equal(backups.length, 2, "keep only the bounded backup and its owner marker");
});

test("failed remembered replacement restores the superseded backup", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("remembered-rollback-backup")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  fs.writeFileSync(staged, "second");
  fs.writeFileSync(target, "first");
  await bridge._promoteLocalTransferForTests(staged, target, {
    requestedTargetPath: target,
    expectedLocalTarget: rememberedExpectation(root, target),
  });
  // The renderer re-remembers the published target before the next repeat,
  // but the remembered digest no longer matches the bytes on disk.
  fs.writeFileSync(staged, "third");
  fs.writeFileSync(target, "tampered");
  const expectation = rememberedExpectation(root, target);
  expectation.targetSha256 = require("node:crypto").createHash("sha256").update("stale").digest("hex");
  await assert.rejects(
    bridge._promoteLocalTransferForTests(staged, target, {
      requestedTargetPath: target,
      expectedLocalTarget: expectation,
    }),
    (error) => error?.message?.includes("changed during replacement"),
  );
  assert.equal(fs.readFileSync(target, "utf8"), "tampered", "restore the pre-transfer target bytes");
  assert.equal(
    fs.readFileSync(path.join(root, ".target.netcatty.backup"), "utf8"), "first",
    "put the superseded backup back at the fixed name",
  );
  const remainingBackups = fs.readdirSync(root)
    .filter((name) => name.includes("netcatty.backup") && name !== ".target.netcatty.backup.owner");
  assert.equal(remainingBackups.length, 1, "leave no orphaned versioned recovery copy");
});

test("remembered download refuses to move a foreign file at the backup pathname", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("remembered-foreign-backup")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  const backupPath = path.join(root, ".target.netcatty.backup");
  fs.writeFileSync(staged, "second");
  fs.writeFileSync(target, "first");
  await bridge._promoteLocalTransferForTests(staged, target, {
    requestedTargetPath: target,
    expectedLocalTarget: rememberedExpectation(root, target),
  });
  assert.equal(fs.readFileSync(backupPath, "utf8"), "first");
  // A user or another application takes over the hidden pathname. Without a
  // matching owner marker Netcatty must neither move it aside nor replace it.
  fs.writeFileSync(backupPath, "mine");
  fs.rmSync(`${backupPath}.owner`);
  fs.writeFileSync(staged, "third");
  await assert.rejects(
    () => bridge._promoteLocalTransferForTests(staged, target, {
      requestedTargetPath: target,
      expectedLocalTarget: rememberedExpectation(root, target),
    }),
    /refusing to move or replace/,
  );
  assert.equal(fs.readFileSync(backupPath, "utf8"), "mine", "leave the foreign file untouched");
  assert.equal(fs.readFileSync(target, "utf8"), "second", "leave the target untouched");
  assert.equal(
    fs.readdirSync(root).filter((name) => name.startsWith(".target.netcatty.backup.")).length, 0,
    "scatter no versioned copies of the foreign file",
  );
});

test("remembered download refuses a backup whose inode no longer matches its owner marker", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("remembered-stale-marker")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  const backupPath = path.join(root, ".target.netcatty.backup");
  fs.writeFileSync(staged, "second");
  fs.writeFileSync(target, "first");
  await bridge._promoteLocalTransferForTests(staged, target, {
    requestedTargetPath: target,
    expectedLocalTarget: rememberedExpectation(root, target),
  });
  // Swap in a different inode while keeping the previous owner marker.
  fs.renameSync(backupPath, `${backupPath}.held`);
  fs.writeFileSync(backupPath, "unrelated");
  fs.writeFileSync(staged, "third");
  await assert.rejects(
    () => bridge._promoteLocalTransferForTests(staged, target, {
      requestedTargetPath: target,
      expectedLocalTarget: rememberedExpectation(root, target),
    }),
    /refusing to move or replace/,
  );
  assert.equal(fs.readFileSync(backupPath, "utf8"), "unrelated", "leave the swapped-in file untouched");
  assert.equal(fs.readFileSync(`${backupPath}.held`, "utf8"), "first", "keep the real backup reachable");
  assert.equal(fs.readFileSync(target, "utf8"), "second", "leave the target untouched");
});

test("remembered download re-homes the superseded backup when the target disappears", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("remembered-vanish-target")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  const backupPath = path.join(root, ".target.netcatty.backup");
  fs.writeFileSync(staged, "second");
  fs.writeFileSync(target, "first");
  await bridge._promoteLocalTransferForTests(staged, target, {
    requestedTargetPath: target,
    expectedLocalTarget: rememberedExpectation(root, target),
  });
  fs.writeFileSync(staged, "third");
  const rename = fs.promises.rename;
  t.after(() => { fs.promises.rename = rename; });
  fs.promises.rename = async (from, to) => {
    if (from === target && String(to).endsWith(".backup")) fs.unlinkSync(target);
    return rename(from, to);
  };
  await assert.rejects(
    () => bridge._promoteLocalTransferForTests(staged, target, {
      requestedTargetPath: target,
      expectedLocalTarget: rememberedExpectation(root, target),
    }),
    /Remembered local download target disappeared/,
  );
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.readFileSync(backupPath, "utf8"), "first",
    "put the superseded backup back at the fixed name");
  assert.equal(
    fs.readdirSync(root)
      .filter((name) => name.startsWith(".target.netcatty.backup.")
        && name !== ".target.netcatty.backup.owner").length,
    0,
    "leave no versioned recovery copy stranded",
  );
});

test("remembered download refuses to overwrite a foreign owner-marker entry", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("remembered-foreign-marker")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  const markerPath = path.join(root, ".target.netcatty.backup.owner");
  fs.writeFileSync(staged, "download");
  fs.writeFileSync(target, "original");
  // A foreign symlink occupies the predictable marker pathname before the
  // first remembered replacement. The marker write must neither truncate the
  // victim through the link nor replace the entry.
  const victim = path.join(root, "victim");
  fs.writeFileSync(victim, "mine");
  fs.symlinkSync(victim, markerPath);
  await assert.rejects(
    () => bridge._promoteLocalTransferForTests(staged, target, {
      requestedTargetPath: target,
      expectedLocalTarget: rememberedExpectation(root, target),
    }),
    /refusing to overwrite/,
  );
  assert.equal(fs.readFileSync(victim, "utf8"), "mine", "symlink victim untouched");
  assert.ok(fs.lstatSync(markerPath).isSymbolicLink(), "marker entry untouched");
  assert.equal(fs.readFileSync(target, "utf8"), "original", "target rolled back");
});

test("remembered download refuses to truncate a foreign owner-marker file", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("remembered-foreign-marker-file")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  const markerPath = path.join(root, ".target.netcatty.backup.owner");
  fs.writeFileSync(staged, "download");
  fs.writeFileSync(target, "original");
  fs.writeFileSync(markerPath, "mine");
  await assert.rejects(
    () => bridge._promoteLocalTransferForTests(staged, target, {
      requestedTargetPath: target,
      expectedLocalTarget: rememberedExpectation(root, target),
    }),
    /refusing to overwrite/,
  );
  assert.equal(fs.readFileSync(markerPath, "utf8"), "mine", "foreign marker file untouched");
  assert.equal(fs.readFileSync(target, "utf8"), "original", "target rolled back");
});

test("superseded recovery copy is retired into Netcatty temp storage, not destroyed", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("remembered-superseded-retire")}-`);
  const tempDir = temp.getTempDir();
  const tempBefore = new Set(fs.readdirSync(tempDir));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    for (const name of fs.readdirSync(tempDir)) {
      if (!tempBefore.has(name)) fs.rmSync(path.join(tempDir, name), { force: true });
    }
  });
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  fs.writeFileSync(staged, "second");
  fs.writeFileSync(target, "first");
  await bridge._promoteLocalTransferForTests(staged, target, {
    requestedTargetPath: target,
    expectedLocalTarget: rememberedExpectation(root, target),
  });
  fs.writeFileSync(staged, "third");
  await bridge._promoteLocalTransferForTests(staged, target, {
    requestedTargetPath: target,
    expectedLocalTarget: rememberedExpectation(root, target),
  });
  assert.equal(fs.readFileSync(target, "utf8"), "third");
  assert.equal(
    fs.readdirSync(root).filter((name) => name.startsWith(".target.netcatty.backup.")
      && name !== ".target.netcatty.backup" && name !== ".target.netcatty.backup.owner").length,
    0,
    "leave no versioned copy beside the destination",
  );
  // An editor may still hold the superseded inode open, so its content must
  // stay reachable through the managed temporary store after retirement.
  const retired = fs.readdirSync(tempDir)
    .filter((name) => !tempBefore.has(name) && name.includes("superseded-.target.netcatty.backup."))
    .map((name) => path.join(tempDir, name))
    .find((candidate) => {
      try { return fs.readFileSync(candidate, "utf8") === "first"; } catch { return false; }
    });
  assert.ok(retired, "superseded copy remains reachable in Netcatty temp storage");
});

test("superseded copy is copied into temp storage when the destination is on another filesystem", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("remembered-superseded-exdev")}-`);
  const tempDir = temp.getTempDir();
  const tempBefore = new Set(fs.readdirSync(tempDir));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    for (const name of fs.readdirSync(tempDir)) {
      if (!tempBefore.has(name)) fs.rmSync(path.join(tempDir, name), { force: true });
    }
  });
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  fs.writeFileSync(staged, "second");
  fs.writeFileSync(target, "first");
  await bridge._promoteLocalTransferForTests(staged, target, {
    requestedTargetPath: target,
    expectedLocalTarget: rememberedExpectation(root, target),
  });
  fs.writeFileSync(staged, "third");
  // A destination on a different filesystem (external or network mount)
  // cannot be hardlinked into the managed temp store (EXDEV). The
  // retirement must still copy the bytes there instead of leaving one
  // versioned full-size copy per repeat beside the destination
  // (Codex P1 on PR #3516).
  const link = fs.promises.link;
  t.mock.method(fs.promises, "link", async (from, to, ...rest) => {
    if (path.basename(from).startsWith(".target.netcatty.backup.")) {
      throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
    }
    return link(from, to, ...rest);
  });
  await bridge._promoteLocalTransferForTests(staged, target, {
    requestedTargetPath: target,
    expectedLocalTarget: rememberedExpectation(root, target),
  });
  assert.equal(fs.readFileSync(target, "utf8"), "third");
  assert.equal(
    fs.readdirSync(root).filter((name) => name.startsWith(".target.netcatty.backup.")
      && name !== ".target.netcatty.backup" && name !== ".target.netcatty.backup.owner").length,
    0,
    "leave no versioned copy beside the cross-device destination",
  );
  const retired = fs.readdirSync(tempDir)
    .filter((name) => !tempBefore.has(name) && name.includes("superseded-.target.netcatty.backup."))
    .map((name) => path.join(tempDir, name))
    .find((candidate) => {
      try { return fs.readFileSync(candidate, "utf8") === "first"; } catch { return false; }
    });
  assert.ok(retired, "superseded copy remains reachable in Netcatty temp storage");
});

test("actively written superseded copy is kept beside the destination", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("remembered-superseded-active")}-`);
  const tempDir = temp.getTempDir();
  const tempBefore = new Set(fs.readdirSync(tempDir));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    for (const name of fs.readdirSync(tempDir)) {
      if (!tempBefore.has(name)) fs.rmSync(path.join(tempDir, name), { force: true });
    }
  });
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  fs.writeFileSync(staged, "second");
  fs.writeFileSync(target, "first");
  await bridge._promoteLocalTransferForTests(staged, target, {
    requestedTargetPath: target,
    expectedLocalTarget: rememberedExpectation(root, target),
  });
  fs.writeFileSync(staged, "third");
  // An editor keeps writing through a held descriptor while the copy runs,
  // so the source never settles and its only remaining name must stay
  // reachable instead of being dropped mid-edit. The destination is on a
  // different filesystem, so the hardlink into the temp store fails too.
  const link = fs.promises.link;
  t.mock.method(fs.promises, "link", async (from, to, ...rest) => {
    if (path.basename(from).startsWith(".target.netcatty.backup.")) {
      throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
    }
    return link(from, to, ...rest);
  });
  const copyFile = fs.promises.copyFile;
  t.mock.method(fs.promises, "copyFile", async (from, to, ...rest) => {
    fs.appendFileSync(from, "!");
    return copyFile(from, to, ...rest);
  });
  await bridge._promoteLocalTransferForTests(staged, target, {
    requestedTargetPath: target,
    expectedLocalTarget: rememberedExpectation(root, target),
  });
  assert.equal(fs.readFileSync(target, "utf8"), "third");
  const retained = fs.readdirSync(root)
    .filter((name) => name.startsWith(".target.netcatty.backup.")
      && name !== ".target.netcatty.backup" && name !== ".target.netcatty.backup.owner")
    .map((name) => path.join(root, name));
  assert.equal(retained.length, 1, "keep the still-changing copy beside the destination");
  assert.equal(fs.readFileSync(retained[0], "utf8"), "first!!!");
  assert.equal(
    fs.readdirSync(tempDir)
      .filter((name) => !tempBefore.has(name) && name.includes("superseded-.target.netcatty.backup."))
      .length,
    0,
    "remove the abandoned partial temp copy",
  );
});

test("failed repeat restores the superseded backup and its owner marker", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("remembered-rollback-marker")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  const backupPath = path.join(root, ".target.netcatty.backup");
  const markerPath = `${backupPath}.owner`;
  fs.writeFileSync(staged, "second");
  fs.writeFileSync(target, "first");
  await bridge._promoteLocalTransferForTests(staged, target, {
    requestedTargetPath: target,
    expectedLocalTarget: rememberedExpectation(root, target),
  });
  const savedMarker = fs.readFileSync(markerPath, "utf8");
  fs.writeFileSync(staged, "third");
  // A concurrent writer recreates the destination pathname before
  // publication, so the exclusive publish fails with EEXIST after this
  // replacement already wrote its own owner marker for the backup it just
  // rolled back. Rollback must remove that new marker before recreating
  // the saved one, or the restored backup is paired with the wrong
  // identity and every later repeat is refused (Codex P2 on PR #3516).
  let publicationAttempts = 0;
  const link = fs.promises.link;
  t.mock.method(fs.promises, "link", async (from, to, ...rest) => {
    if (to === target && publicationAttempts++ === 0) {
      throw Object.assign(new Error("occupied"), { code: "EEXIST" });
    }
    return link(from, to, ...rest);
  });
  await assert.rejects(
    bridge._promoteLocalTransferForTests(staged, target, {
      requestedTargetPath: target,
      expectedLocalTarget: rememberedExpectation(root, target),
    }),
    /changed during replacement/,
  );
  assert.equal(fs.readFileSync(target, "utf8"), "second", "restore the pre-transfer target bytes");
  assert.equal(fs.readFileSync(backupPath, "utf8"), "first", "put the superseded backup back");
  assert.equal(
    fs.readFileSync(markerPath, "utf8"),
    savedMarker,
    "restore the superseded backup's owner marker",
  );
  // With the marker pairing restored, a later repeat must succeed again.
  fs.writeFileSync(staged, "fourth");
  await bridge._promoteLocalTransferForTests(staged, target, {
    requestedTargetPath: target,
    expectedLocalTarget: rememberedExpectation(root, target),
  });
  assert.equal(fs.readFileSync(target, "utf8"), "fourth");
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

test("remembered download keeps a backup edited after publication", async (t) => {
  const root = fs.mkdtempSync(`${temp.getTempFilePath("remembered-late-edit")}-`);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, "staged");
  const target = path.join(root, "target");
  fs.writeFileSync(staged, "download");
  fs.writeFileSync(target, "original");
  const expectedLocalTarget = rememberedExpectation(root, target);
  const link = fs.promises.link;
  t.after(() => { fs.promises.link = link; });
  let edited = false;
  fs.promises.link = async (from, to) => {
    const result = await link(from, to);
    if (!edited && to === target && String(from).endsWith(".ready")) {
      edited = true;
      const backupName = fs.readdirSync(root).find((name) => name.endsWith(".backup"));
      assert.ok(backupName);
      fs.writeFileSync(path.join(root, backupName), "modified");
    }
    return result;
  };
  await assert.rejects(() => bridge._promoteLocalTransferForTests(staged, target, {
    requestedTargetPath: target, expectedLocalTarget,
  }), /Recovery backup preserved/);
  assert.equal(edited, true);
  assert.equal(fs.readFileSync(target, "utf8"), "download");
  const backupName = fs.readdirSync(root).find((name) => name.endsWith(".backup"));
  assert.ok(backupName);
  assert.equal(fs.readFileSync(path.join(root, backupName), "utf8"), "modified");
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
