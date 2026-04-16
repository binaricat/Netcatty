const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  BACKUP_DIR_NAME,
  MAX_PAYLOAD_BYTES,
  VaultBackupEncryptionUnavailableError,
  VaultBackupTooLargeError,
  createVaultBackupService,
} = require("./vaultBackupBridge.cjs");

function createTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-vault-backup-"));
}

// All tests default to encrypted=true because the bridge now refuses to
// write plaintext backups (I1). Individual tests opt out to verify the
// refusal path.
function createService(rootDir, { encrypted = true } = {}) {
  const app = {
    getPath(key) {
      if (key !== "userData") throw new Error(`Unexpected path key: ${key}`);
      return rootDir;
    },
  };

  const safeStorage = encrypted
    ? {
        isEncryptionAvailable() {
          return true;
        },
        encryptString(value) {
          return Buffer.from(`enc:${value}`, "utf8");
        },
        decryptString(buffer) {
          const decoded = Buffer.from(buffer).toString("utf8");
          if (!decoded.startsWith("enc:")) throw new Error("Bad payload");
          return decoded.slice(4);
        },
      }
    : {
        isEncryptionAvailable() {
          return false;
        },
      };

  return createVaultBackupService({
    app,
    safeStorage,
    shell: {
      openPath: async () => "",
    },
  });
}

function samplePayload(overrides = {}) {
  return {
    hosts: [
      {
        id: "h1",
        label: "prod",
        hostname: "prod",
        username: "root",
        port: 22,
        os: "linux",
        group: "",
        tags: [],
        protocol: "ssh",
      },
    ],
    keys: [],
    identities: [],
    snippets: [],
    customGroups: [],
    syncedAt: Date.now(),
    ...overrides,
  };
}

test("vault backups round-trip and dedupe identical payloads", async () => {
  const rootDir = createTempRoot();
  const service = createService(rootDir);
  const payload = samplePayload();

  try {
    const first = await service.createBackup({
      payload,
      reason: "app_version_change",
      sourceAppVersion: "1.0.89",
      targetAppVersion: "1.0.90",
      maxCount: 5,
    });
    assert.equal(first.created, true);
    assert.equal(first.backup.reason, "app_version_change");

    const duplicate = await service.createBackup({
      payload: { ...payload, syncedAt: Date.now() + 1000 },
      reason: "before_restore",
      maxCount: 5,
    });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.backup.id, first.backup.id);

    const listed = await service.listBackups();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].preview.hostCount, 1);

    const restored = await service.readBackup({ id: first.backup.id });
    assert.equal(restored.backup.id, first.backup.id);
    assert.equal(restored.payload.hosts[0].label, "prod");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("vault backups honor retention trimming and can use encrypted payload storage", async () => {
  const rootDir = createTempRoot();
  const service = createService(rootDir, { encrypted: true });

  try {
    for (let index = 0; index < 3; index += 1) {
      await service.createBackup({
        payload: {
          hosts: [{ id: `h${index}`, label: `host-${index}`, hostname: `host-${index}`, username: "root", port: 22, os: "linux", group: "", tags: [], protocol: "ssh" }],
          keys: [],
          identities: [],
          snippets: [],
          customGroups: [],
          syncedAt: Date.now() + index,
        },
        reason: "before_restore",
        maxCount: 2,
      });
    }

    const listed = await service.listBackups();
    assert.equal(listed.length, 2);

    const backupDir = path.join(rootDir, BACKUP_DIR_NAME);
    const fileNames = fs.readdirSync(backupDir).filter((name) => name.endsWith(".json"));
    assert.equal(fileNames.length, 2);

    const newest = listed[0];
    const restored = await service.readBackup({ id: newest.id });
    assert.equal(restored.payload.hosts[0].id, "h2");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

// ============================================================================
// I1 — plaintext refusal when safeStorage is unavailable
// ============================================================================

test("createBackup refuses when safeStorage is unavailable (I1)", async () => {
  const rootDir = createTempRoot();
  const service = createService(rootDir, { encrypted: false });

  try {
    await assert.rejects(
      () => service.createBackup({ payload: samplePayload() }),
      (err) => {
        assert.ok(err instanceof VaultBackupEncryptionUnavailableError);
        assert.equal(err.code, "VAULT_BACKUP_ENCRYPTION_UNAVAILABLE");
        return true;
      },
    );

    // Critical: nothing should have been written to disk. Earlier versions
    // silently wrote a plain-json-v1 record here, leaking plaintext
    // credentials (see review I1).
    const backupDir = path.join(rootDir, BACKUP_DIR_NAME);
    const files = fs.existsSync(backupDir)
      ? fs.readdirSync(backupDir).filter((name) => name.endsWith(".json"))
      : [];
    assert.equal(files.length, 0);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("isEncryptionAvailable reports safeStorage state accurately", () => {
  const rootDir = createTempRoot();
  try {
    assert.equal(createService(rootDir, { encrypted: true }).isEncryptionAvailable(), true);
    assert.equal(createService(rootDir, { encrypted: false }).isEncryptionAvailable(), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Atomic writes and listBackups resilience
// ============================================================================

test("listBackups ignores .tmp files left by an interrupted write", async () => {
  const rootDir = createTempRoot();
  const service = createService(rootDir);

  try {
    await service.createBackup({ payload: samplePayload() });

    // Simulate a crash mid-write: drop a dangling .tmp file matching the
    // backup naming convention but with the atomic-write suffix.
    const backupDir = path.join(rootDir, BACKUP_DIR_NAME);
    const tmpPath = path.join(
      backupDir,
      `vault-backup-${Date.now()}-abc.json.tmp-deadbeef`,
    );
    fs.writeFileSync(tmpPath, "{ half written", { mode: 0o600 });

    const listed = await service.listBackups();
    // The legitimate backup is still there; the .tmp file is ignored
    // because it does not end in ".json".
    assert.equal(listed.length, 1);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("listBackups tolerates a corrupted backup file by skipping it", async () => {
  const rootDir = createTempRoot();
  const service = createService(rootDir);

  try {
    const ok = await service.createBackup({ payload: samplePayload() });
    assert.ok(ok.created);

    // Drop a syntactically-invalid backup alongside the real one.
    const backupDir = path.join(rootDir, BACKUP_DIR_NAME);
    const bogusPath = path.join(backupDir, `vault-backup-${Date.now() + 1}-bad.json`);
    fs.writeFileSync(bogusPath, "{ this is not json", { mode: 0o600 });

    // Must not throw — the bad file is logged-and-skipped.
    const listed = await service.listBackups();
    assert.equal(listed.length, 1, "corrupted file should be skipped, valid remains");
    assert.equal(listed[0].id, ok.backup.id);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Legacy plain-json-v1 migration path
// ============================================================================

test("readBackup can still read legacy plain-json-v1 records for migration", async () => {
  const rootDir = createTempRoot();
  const service = createService(rootDir);
  const backupDir = path.join(rootDir, BACKUP_DIR_NAME);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  try {
    // Hand-craft a legacy record that would have been produced by the
    // pre-I1 code path. Users on that build must still be able to read
    // and migrate off of these files.
    const createdAt = Date.now();
    const id = "legacy-record-id";
    const payload = samplePayload();
    const record = {
      formatVersion: 1,
      id,
      createdAt,
      reason: "before_restore",
      fingerprint: "legacy",
      preview: {
        hostCount: 1,
        keyCount: 0,
        snippetCount: 0,
        identityCount: 0,
        portForwardingRuleCount: 0,
      },
      payloadEncoding: "plain-json-v1",
      payloadData: JSON.stringify(payload),
    };
    fs.writeFileSync(
      path.join(backupDir, `vault-backup-${createdAt}-${id}.json`),
      JSON.stringify(record, null, 2),
      { mode: 0o600 },
    );

    const restored = await service.readBackup({ id });
    assert.equal(restored.payload.hosts[0].id, "h1");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("readBackup throws a clear error for unknown payloadEncoding", async () => {
  const rootDir = createTempRoot();
  const service = createService(rootDir);
  const backupDir = path.join(rootDir, BACKUP_DIR_NAME);
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  try {
    const record = {
      formatVersion: 1,
      id: "future-record",
      createdAt: Date.now(),
      reason: "before_restore",
      fingerprint: "future",
      preview: { hostCount: 0, keyCount: 0, snippetCount: 0, identityCount: 0, portForwardingRuleCount: 0 },
      payloadEncoding: "future-algo-v9",
      payloadData: "unreadable",
    };
    fs.writeFileSync(
      path.join(backupDir, `vault-backup-${record.createdAt}-future.json`),
      JSON.stringify(record),
      { mode: 0o600 },
    );

    await assert.rejects(
      () => service.readBackup({ id: "future-record" }),
      /Unsupported vault backup encoding/,
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Hash normalization (I8)
// ============================================================================

// ============================================================================
// Input validation (review Important #4)
// ============================================================================

test("createBackup rejects a payload larger than MAX_PAYLOAD_BYTES", async () => {
  const rootDir = createTempRoot();
  const service = createService(rootDir);

  try {
    // Build a payload whose JSON serialization exceeds the cap. A single
    // large string field is the cheapest way to push past the limit without
    // an actual 25MB in-memory blob per field.
    const giant = "x".repeat(MAX_PAYLOAD_BYTES + 1);
    const oversized = samplePayload({ __bloat: giant });

    await assert.rejects(
      () => service.createBackup({ payload: oversized }),
      (err) => {
        assert.ok(err instanceof VaultBackupTooLargeError);
        assert.equal(err.code, "VAULT_BACKUP_TOO_LARGE");
        return true;
      },
    );

    const backupDir = path.join(rootDir, BACKUP_DIR_NAME);
    const files = fs.existsSync(backupDir)
      ? fs.readdirSync(backupDir).filter((name) => name.endsWith(".json"))
      : [];
    assert.equal(files.length, 0, "oversized payload must not land on disk");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("createBackup normalizes an out-of-range reason to 'before_restore'", async () => {
  const rootDir = createTempRoot();
  const service = createService(rootDir);

  try {
    const first = await service.createBackup({
      payload: samplePayload(),
      reason: "__INJECTED__\r\nlog-spoofed",
    });
    assert.equal(first.created, true);
    assert.equal(
      first.backup.reason,
      "before_restore",
      "unknown reason must fall back to the safe enum default",
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("createBackup strips version strings with control chars or weird punctuation", async () => {
  const rootDir = createTempRoot();
  const service = createService(rootDir);

  try {
    const result = await service.createBackup({
      payload: samplePayload(),
      reason: "app_version_change",
      sourceAppVersion: "1.0.0\nrm -rf /",
      targetAppVersion: "   ",
    });
    assert.equal(result.created, true);
    assert.equal(result.backup.sourceAppVersion, undefined);
    assert.equal(result.backup.targetAppVersion, undefined);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("createBackup accepts a legitimate SemVer-ish version string", async () => {
  const rootDir = createTempRoot();
  const service = createService(rootDir);

  try {
    const result = await service.createBackup({
      payload: samplePayload(),
      reason: "app_version_change",
      sourceAppVersion: "1.0.89",
      targetAppVersion: "2.0.0-rc.1",
    });
    assert.equal(result.created, true);
    assert.equal(result.backup.sourceAppVersion, "1.0.89");
    assert.equal(result.backup.targetAppVersion, "2.0.0-rc.1");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("createBackup persists syncDataVersion when given a positive integer", async () => {
  const rootDir = createTempRoot();
  const service = createService(rootDir);

  try {
    const result = await service.createBackup({
      payload: samplePayload(),
      reason: "before_restore",
      syncDataVersion: 5,
    });
    assert.equal(result.created, true);
    assert.equal(result.backup.syncDataVersion, 5);

    // Round-trip via list
    const listed = await service.listBackups();
    assert.equal(listed[0].syncDataVersion, 5);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("createBackup drops invalid syncDataVersion values (zero, negative, non-finite, non-numeric)", async () => {
  const rootDir = createTempRoot();
  const service = createService(rootDir);

  try {
    const cases = [0, -1, NaN, Infinity, "5", null, undefined];
    let idx = 0;
    for (const syncDataVersion of cases) {
      // Vary an actual content-bearing field to avoid fingerprint dedupe
      // (top-level syncedAt is normalized away in the fingerprint).
      const payload = samplePayload({
        hosts: [{ ...samplePayload().hosts[0], id: `h-case-${idx}` }],
      });
      const result = await service.createBackup({
        payload,
        reason: "before_restore",
        syncDataVersion,
      });
      assert.equal(result.created, true, `iteration ${idx}: created should be true`);
      assert.equal(result.backup.syncDataVersion, undefined, `value ${String(syncDataVersion)} should be dropped`);
      idx += 1;
    }
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("createBackup floors a fractional syncDataVersion", async () => {
  const rootDir = createTempRoot();
  const service = createService(rootDir);

  try {
    const result = await service.createBackup({
      payload: samplePayload(),
      reason: "before_restore",
      syncDataVersion: 7.9,
    });
    assert.equal(result.backup.syncDataVersion, 7);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("createBackup rejects an array payload (not an object)", async () => {
  const rootDir = createTempRoot();
  const service = createService(rootDir);

  try {
    await assert.rejects(
      () => service.createBackup({ payload: [] }),
      /Missing vault backup payload/,
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("trimBackups clamps out-of-range maxCount instead of silently defaulting", async () => {
  const rootDir = createTempRoot();
  const service = createService(rootDir);

  try {
    // Seed several backups.
    for (let i = 0; i < 3; i += 1) {
      await service.createBackup({
        payload: samplePayload({ hosts: [{ id: `h${i}`, label: `h${i}`, hostname: `h${i}`, username: "u", port: 22, os: "linux", group: "", tags: [], protocol: "ssh" }] }),
      });
    }

    // maxCount = 0 is out of range → clamped to DEFAULT (20), nothing deleted.
    const zeroResult = await service.trimBackups({ maxCount: 0 });
    assert.equal(zeroResult.deletedCount, 0);
    assert.equal((await service.listBackups()).length, 3);

    // maxCount = 200 clamps to 100, no-op on a 3-entry set.
    const hugeResult = await service.trimBackups({ maxCount: 200 });
    assert.equal(hugeResult.deletedCount, 0);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Concurrency (review Important #5)
// ============================================================================

test("concurrent createBackup calls with identical payloads dedupe via the mutex", async () => {
  const rootDir = createTempRoot();
  const service = createService(rootDir);
  const payload = samplePayload();

  try {
    // Fire N parallel requests with the same payload. Without the mutex,
    // each call would observe an empty directory in its own tick, skip
    // dedupe, and write a distinct file. With the mutex, the first call
    // writes and each subsequent call observes the previous write and
    // dedupes.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.createBackup({ payload, reason: "before_restore" }),
      ),
    );

    const created = results.filter((r) => r.created);
    const deduped = results.filter((r) => !r.created);
    assert.equal(created.length, 1, "exactly one concurrent call should create a new backup");
    assert.equal(deduped.length, 4);
    // All results point at the same id — the first one's.
    const canonicalId = created[0].backup.id;
    for (const r of deduped) {
      assert.equal(r.backup.id, canonicalId);
    }

    // Disk state confirms only one file landed.
    const listed = await service.listBackups();
    assert.equal(listed.length, 1);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a failing createBackup does not poison the mutex for subsequent calls", async () => {
  const rootDir = createTempRoot();
  const service = createService(rootDir);

  try {
    // First call rejects (invalid payload).
    await assert.rejects(
      () => service.createBackup({ payload: null }),
      /Missing vault backup payload/,
    );

    // Next call must still succeed — the mutex chain kept moving.
    const ok = await service.createBackup({ payload: samplePayload() });
    assert.equal(ok.created, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("fingerprint is stable when top-level syncedAt drifts", async () => {
  // The bridge zeros top-level syncedAt inside normalizePayloadForHash
  // so semantically-equal payloads dedupe. This guards the dedupe path
  // the createBackup test already covers, from the reverse direction.
  const rootDir = createTempRoot();
  const service = createService(rootDir);

  try {
    const base = samplePayload({ syncedAt: 0 });
    const first = await service.createBackup({ payload: { ...base, syncedAt: 1 } });
    const second = await service.createBackup({ payload: { ...base, syncedAt: 9_999_999 } });
    assert.equal(first.created, true);
    assert.equal(second.created, false, "differs only by top-level syncedAt → dedupe");
    assert.equal(second.backup.id, first.backup.id);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("fingerprint treats nested syncedAt as load-bearing (C1)", async () => {
  // The top-level `syncedAt` is zeroed so two payloads that differ only in
  // when-they-were-packaged still dedupe. But that zeroing must NOT cascade
  // into nested objects — a future schema where any child record carries
  // its own `syncedAt` could otherwise collide into a false dedupe, and
  // the version-change / protective backup would be silently skipped.
  const rootDir = createTempRoot();
  const service = createService(rootDir);

  try {
    const makeNested = (nestedSyncedAt) =>
      samplePayload({
        syncedAt: 0,
        hosts: [
          {
            id: "h1",
            label: "prod",
            hostname: "prod",
            username: "root",
            port: 22,
            os: "linux",
            group: "",
            tags: [],
            protocol: "ssh",
            syncedAt: nestedSyncedAt,
          },
        ],
      });

    const first = await service.createBackup({ payload: makeNested(111) });
    const second = await service.createBackup({ payload: makeNested(222) });
    assert.equal(first.created, true);
    assert.equal(
      second.created,
      true,
      "nested syncedAt must NOT be zeroed — payloads are semantically different",
    );
    assert.notEqual(second.backup.id, first.backup.id);
    assert.notEqual(second.backup.fingerprint, first.backup.fingerprint);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("readBackupRecord rejects oversized files before buffering them", async () => {
  // Write-path already caps at MAX_PAYLOAD_BYTES; this guards the READ
  // path against a pre-existing or externally-placed file larger than
  // the bound, which would otherwise be slurped into memory by
  // fs.readFile inside listBackups/readBackup and risk OOMing the
  // renderer. The cap is 2x the write cap to allow for the base64 +
  // JSON-envelope inflation of legitimate records.
  const rootDir = createTempRoot();
  const service = createService(rootDir);

  try {
    // Seed a legitimate backup so the directory exists and listBackups
    // has something to iterate past.
    const ok = await service.createBackup({ payload: samplePayload() });
    assert.ok(ok.created);

    const backupDir = path.join(rootDir, BACKUP_DIR_NAME);
    const hugePath = path.join(
      backupDir,
      `vault-backup-${Date.now() + 1}-huge.json`,
    );
    // MAX_PAYLOAD_BYTES * 2 = 50 MiB; we write one byte past that.
    const hugeSize = MAX_PAYLOAD_BYTES * 2 + 1;
    // Pre-allocate the file without actually writing 50 MiB of content:
    // `ftruncate` produces a sparse file of the requested size on every
    // supported filesystem, so the test stays fast and uses minimal disk.
    const fd = fs.openSync(hugePath, "w", 0o600);
    try {
      fs.ftruncateSync(fd, hugeSize);
    } finally {
      fs.closeSync(fd);
    }

    // listBackups now enumerates both files; the huge one should be
    // skipped with a warning (matching the corrupted-file behavior) and
    // the valid one must still come back.
    const listed = await service.listBackups();
    assert.equal(
      listed.length,
      1,
      "oversized file should be skipped during enumeration",
    );
    assert.equal(listed[0].id, ok.backup.id);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
