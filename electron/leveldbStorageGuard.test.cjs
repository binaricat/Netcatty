const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { guardLocalStorageLevelDb } = require("./leveldbStorageGuard.cjs");

const FIXED_NOW = () => Date.UTC(2026, 10, 23, 8, 30, 0, 0);

function createTempUserData(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-leveldb-guard-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function createLevelDbDir(userDataDir) {
  const leveldbDir = path.join(userDataDir, "Local Storage", "leveldb");
  fs.mkdirSync(leveldbDir, { recursive: true });
  return leveldbDir;
}

test("returns ok when Local Storage leveldb directory does not exist", (t) => {
  const userDataDir = createTempUserData(t);

  const result = guardLocalStorageLevelDb({ userDataDir, now: FIXED_NOW });

  assert.deepEqual(result, { status: "ok" });
  assert.equal(fs.existsSync(path.join(userDataDir, "recovery")), false);
});

test("returns ok when leveldb directory is empty or has neither MANIFEST nor .ldb files", (t) => {
  const userDataDir = createTempUserData(t);
  const leveldbDir = createLevelDbDir(userDataDir);
  fs.writeFileSync(path.join(leveldbDir, "LOCK"), "");
  fs.writeFileSync(path.join(leveldbDir, "LOG"), "info log\n");
  fs.writeFileSync(path.join(leveldbDir, "000003.log"), "wal");

  const result = guardLocalStorageLevelDb({ userDataDir, now: FIXED_NOW });

  assert.deepEqual(result, { status: "ok" });
  assert.equal(fs.existsSync(path.join(leveldbDir, "CURRENT")), false);
  assert.equal(fs.existsSync(path.join(userDataDir, "recovery")), false);
});

test("returns ok without modification when CURRENT exists and is non-empty", (t) => {
  const userDataDir = createTempUserData(t);
  const leveldbDir = createLevelDbDir(userDataDir);
  fs.writeFileSync(path.join(leveldbDir, "CURRENT"), "MANIFEST-000005\n", "utf8");
  fs.writeFileSync(path.join(leveldbDir, "MANIFEST-000005"), "manifest-data");
  fs.writeFileSync(path.join(leveldbDir, "000006.ldb"), "table-data");

  const result = guardLocalStorageLevelDb({ userDataDir, now: FIXED_NOW });

  assert.deepEqual(result, { status: "ok" });
  assert.equal(
    fs.readFileSync(path.join(leveldbDir, "CURRENT"), "utf8"),
    "MANIFEST-000005\n",
  );
  assert.equal(fs.existsSync(path.join(userDataDir, "recovery")), false);
});

test("recovers missing CURRENT from a single valid MANIFEST and preserves a forensic backup", (t) => {
  const userDataDir = createTempUserData(t);
  const leveldbDir = createLevelDbDir(userDataDir);
  fs.writeFileSync(path.join(leveldbDir, "MANIFEST-000007"), "manifest-v7");
  fs.writeFileSync(path.join(leveldbDir, "000008.ldb"), "ldb-bytes");

  const result = guardLocalStorageLevelDb({ userDataDir, now: FIXED_NOW });

  assert.equal(result.status, "recovered");
  assert.equal(result.manifest, "MANIFEST-000007");
  assert.equal(
    result.backupDir,
    path.join(userDataDir, "recovery", "leveldb-missing-current-2026-11-23T08-30-00-000Z"),
  );
  assert.equal(
    fs.readFileSync(path.join(leveldbDir, "CURRENT"), "utf8"),
    "MANIFEST-000007\n",
  );
  // Backup must capture the pre-recovery state (without the newly created CURRENT).
  assert.equal(fs.existsSync(path.join(result.backupDir, "CURRENT")), false);
  assert.equal(
    fs.readFileSync(path.join(result.backupDir, "MANIFEST-000007"), "utf8"),
    "manifest-v7",
  );
  assert.equal(
    fs.readFileSync(path.join(result.backupDir, "000008.ldb"), "utf8"),
    "ldb-bytes",
  );
});

test("picks the highest numeric MANIFEST across multi-digit suffixes and ignores invalid candidates", (t) => {
  const userDataDir = createTempUserData(t);
  const leveldbDir = createLevelDbDir(userDataDir);
  fs.writeFileSync(path.join(leveldbDir, "MANIFEST-000009"), "manifest-9");
  fs.writeFileSync(path.join(leveldbDir, "MANIFEST-000010"), "manifest-10");
  fs.writeFileSync(path.join(leveldbDir, "MANIFEST-000011"), ""); // 0-byte, invalid
  fs.writeFileSync(path.join(leveldbDir, "MANIFEST-999999.bak"), "not-a-manifest");
  fs.mkdirSync(path.join(leveldbDir, "MANIFEST-000099")); // directory, not a file
  fs.writeFileSync(path.join(leveldbDir, "000012.ldb"), "ldb-bytes");

  const result = guardLocalStorageLevelDb({ userDataDir, now: FIXED_NOW });

  assert.equal(result.status, "recovered");
  assert.equal(result.manifest, "MANIFEST-000010");
  assert.equal(
    fs.readFileSync(path.join(leveldbDir, "CURRENT"), "utf8"),
    "MANIFEST-000010\n",
  );
});

test("compares MANIFEST suffixes numerically rather than lexicographically", (t) => {
  const userDataDir = createTempUserData(t);
  const leveldbDir = createLevelDbDir(userDataDir);
  fs.writeFileSync(path.join(leveldbDir, "MANIFEST-9"), "manifest-9");
  fs.writeFileSync(path.join(leveldbDir, "MANIFEST-10"), "manifest-10");

  const result = guardLocalStorageLevelDb({ userDataDir, now: FIXED_NOW });

  assert.equal(result.status, "recovered");
  assert.equal(result.manifest, "MANIFEST-10");
  assert.equal(
    fs.readFileSync(path.join(leveldbDir, "CURRENT"), "utf8"),
    "MANIFEST-10\n",
  );
});

test("recovers 0-byte CURRENT file and backs up the original empty CURRENT", (t) => {
  const userDataDir = createTempUserData(t);
  const leveldbDir = createLevelDbDir(userDataDir);
  fs.writeFileSync(path.join(leveldbDir, "CURRENT"), "");
  fs.writeFileSync(path.join(leveldbDir, "MANIFEST-000004"), "manifest-4");
  fs.writeFileSync(path.join(leveldbDir, "000005.ldb"), "ldb-bytes");

  const result = guardLocalStorageLevelDb({ userDataDir, now: FIXED_NOW });

  assert.equal(result.status, "recovered");
  assert.equal(result.manifest, "MANIFEST-000004");
  assert.equal(
    fs.readFileSync(path.join(leveldbDir, "CURRENT"), "utf8"),
    "MANIFEST-000004\n",
  );
  assert.equal(fs.statSync(path.join(result.backupDir, "CURRENT")).size, 0);
});

test("backs up and returns blocked when orphaned .ldb files exist without any valid MANIFEST", (t) => {
  const userDataDir = createTempUserData(t);
  const leveldbDir = createLevelDbDir(userDataDir);
  fs.writeFileSync(path.join(leveldbDir, "000005.ldb"), "table-5");
  fs.writeFileSync(path.join(leveldbDir, "MANIFEST-000001"), ""); // 0-byte only

  const result = guardLocalStorageLevelDb({ userDataDir, now: FIXED_NOW });

  assert.equal(result.status, "blocked");
  assert.ok(result.backupDir);
  assert.equal(
    fs.readFileSync(path.join(result.backupDir, "000005.ldb"), "utf8"),
    "table-5",
  );
  assert.equal(fs.existsSync(path.join(leveldbDir, "CURRENT")), false);
  assert.equal(
    fs.readFileSync(path.join(leveldbDir, "000005.ldb"), "utf8"),
    "table-5",
  );
});

test("returns backup_failed without touching leveldb when forensic backup fails", (t) => {
  const userDataDir = createTempUserData(t);
  const leveldbDir = createLevelDbDir(userDataDir);
  fs.writeFileSync(path.join(leveldbDir, "MANIFEST-000003"), "manifest-3");
  fs.writeFileSync(path.join(leveldbDir, "000004.ldb"), "table-4");

  const diskFullError = Object.assign(new Error("ENOSPC: no space left on device"), {
    code: "ENOSPC",
  });
  let writeCalled = false;
  let renameCalled = false;
  const failingFs = {
    ...fs,
    cpSync() {
      throw diskFullError;
    },
    writeFileSync(...args) {
      writeCalled = true;
      return fs.writeFileSync(...args);
    },
    renameSync(...args) {
      renameCalled = true;
      return fs.renameSync(...args);
    },
  };

  const result = guardLocalStorageLevelDb({
    userDataDir,
    now: FIXED_NOW,
    fsModule: failingFs,
  });

  assert.equal(result.status, "backup_failed");
  assert.equal(result.error, diskFullError);
  assert.equal(writeCalled, false);
  assert.equal(renameCalled, false);
  assert.equal(fs.existsSync(path.join(leveldbDir, "CURRENT")), false);
});

test("returns blocked and cleans up temp file if writing CURRENT fails after backup", (t) => {
  const userDataDir = createTempUserData(t);
  const leveldbDir = createLevelDbDir(userDataDir);
  fs.writeFileSync(path.join(leveldbDir, "MANIFEST-000003"), "manifest-3");
  fs.writeFileSync(path.join(leveldbDir, "000004.ldb"), "table-4");

  const renameError = Object.assign(new Error("EPERM: operation not permitted"), {
    code: "EPERM",
  });
  const failingRenameFs = {
    ...fs,
    renameSync() {
      throw renameError;
    },
  };

  const result = guardLocalStorageLevelDb({
    userDataDir,
    now: FIXED_NOW,
    fsModule: failingRenameFs,
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.error, renameError);
  assert.ok(fs.existsSync(path.join(result.backupDir, "000004.ldb")));
  assert.equal(fs.existsSync(path.join(leveldbDir, "CURRENT")), false);
  const leftoverTemps = fs.readdirSync(leveldbDir).filter((name) => name.includes(".tmp"));
  assert.deepEqual(leftoverTemps, []);
});

test("main.cjs runs guardLocalStorageLevelDb after applyPortableDataDirectory and before app.whenReady", () => {
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const portableIdx = source.indexOf("applyPortableDataDirectory({ app })");
  const guardIdx = source.indexOf("guardLocalStorageLevelDb({");
  const whenReadyIdx = source.indexOf("app.whenReady()");
  const exitIdx = source.indexOf("app.exit(1)", guardIdx);

  assert.ok(portableIdx >= 0, "applyPortableDataDirectory must exist in main.cjs");
  assert.ok(guardIdx > portableIdx, "guardLocalStorageLevelDb must run after applyPortableDataDirectory");
  assert.ok(whenReadyIdx > guardIdx, "guardLocalStorageLevelDb must run before app.whenReady");
  assert.ok(exitIdx > guardIdx && exitIdx < whenReadyIdx, "blocked guard must call app.exit(1) before app.whenReady");
});
