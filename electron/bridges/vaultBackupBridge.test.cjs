const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  BACKUP_DIR_NAME,
  createVaultBackupService,
} = require("./vaultBackupBridge.cjs");

function createTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-vault-backup-"));
}

function createService(rootDir, { encrypted = false } = {}) {
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

test("vault backups round-trip and dedupe identical payloads", async () => {
  const rootDir = createTempRoot();
  const service = createService(rootDir);
  const payload = {
    hosts: [{ id: "h1", label: "prod", hostname: "prod", username: "root", port: 22, os: "linux", group: "", tags: [], protocol: "ssh" }],
    keys: [],
    identities: [],
    snippets: [],
    customGroups: [],
    syncedAt: Date.now(),
  };

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
