const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const BACKUP_DIR_NAME = "vault-backups";
const BACKUP_FILE_PREFIX = "vault-backup-";
const BACKUP_FILE_EXT = ".json";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePayloadForHash(value, key = "") {
  if (Array.isArray(value)) {
    return value.map((item) => normalizePayloadForHash(item));
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return entries.reduce((acc, [entryKey, entryValue]) => {
      acc[entryKey] = normalizePayloadForHash(
        entryKey === "syncedAt" ? 0 : entryValue,
        entryKey,
      );
      return acc;
    }, {});
  }
  return key === "syncedAt" ? 0 : value;
}

function stableStringify(value) {
  return JSON.stringify(normalizePayloadForHash(value));
}

function computePayloadFingerprint(payload) {
  return crypto
    .createHash("sha256")
    .update(stableStringify(payload))
    .digest("hex");
}

function buildPreview(payload) {
  return {
    hostCount: Array.isArray(payload?.hosts) ? payload.hosts.length : 0,
    keyCount: Array.isArray(payload?.keys) ? payload.keys.length : 0,
    snippetCount: Array.isArray(payload?.snippets) ? payload.snippets.length : 0,
    identityCount: Array.isArray(payload?.identities) ? payload.identities.length : 0,
    portForwardingRuleCount: Array.isArray(payload?.portForwardingRules) ? payload.portForwardingRules.length : 0,
  };
}

function toBackupSummary(record) {
  return {
    id: record.id,
    createdAt: record.createdAt,
    reason: record.reason,
    sourceAppVersion: record.sourceAppVersion,
    targetAppVersion: record.targetAppVersion,
    preview: record.preview,
    fingerprint: record.fingerprint,
  };
}

function encodePayload(payload, safeStorage) {
  const raw = JSON.stringify(payload);
  if (safeStorage?.isEncryptionAvailable?.()) {
    return {
      encoding: "safeStorage-v1",
      data: safeStorage.encryptString(raw).toString("base64"),
    };
  }
  return {
    encoding: "plain-json-v1",
    data: raw,
  };
}

function decodePayload(record, safeStorage) {
  if (record.payloadEncoding === "safeStorage-v1") {
    if (!safeStorage?.decryptString) {
      throw new Error("Encrypted backup cannot be read because secure storage is unavailable.");
    }
    const decrypted = safeStorage.decryptString(Buffer.from(record.payloadData, "base64"));
    return JSON.parse(decrypted);
  }

  if (record.payloadEncoding === "plain-json-v1") {
    return JSON.parse(record.payloadData);
  }

  throw new Error(`Unsupported vault backup encoding: ${record.payloadEncoding}`);
}

async function readBackupRecord(filePath) {
  const raw = await fs.promises.readFile(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || typeof parsed.id !== "string") {
    throw new Error(`Invalid vault backup record: ${filePath}`);
  }
  return parsed;
}

async function listBackupRecords(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true, mode: 0o700 });
  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  const records = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith(BACKUP_FILE_PREFIX) || !entry.name.endsWith(BACKUP_FILE_EXT)) continue;
    const fullPath = path.join(dirPath, entry.name);
    try {
      const record = await readBackupRecord(fullPath);
      records.push({ record, filePath: fullPath });
    } catch (error) {
      console.warn("[vaultBackupBridge] Failed to parse backup:", fullPath, error);
    }
  }

  records.sort((a, b) => {
    const aTime = Number(a.record.createdAt || 0);
    const bTime = Number(b.record.createdAt || 0);
    return bTime - aTime;
  });

  return records;
}

async function pruneBackupRecords(dirPath, maxCount) {
  const sanitizedMaxCount = Math.max(1, Math.min(100, Number(maxCount) || 20));
  const records = await listBackupRecords(dirPath);
  const toDelete = records.slice(sanitizedMaxCount);
  let deletedCount = 0;

  for (const entry of toDelete) {
    try {
      await fs.promises.unlink(entry.filePath);
      deletedCount += 1;
    } catch (error) {
      console.warn("[vaultBackupBridge] Failed to delete old backup:", entry.filePath, error);
    }
  }

  return {
    deletedCount,
    keptCount: Math.min(records.length, sanitizedMaxCount),
  };
}

function createVaultBackupService({ app, safeStorage, shell }) {
  if (!app?.getPath) {
    throw new Error("Electron app is unavailable.");
  }

  const getBackupDir = () => path.join(app.getPath("userData"), BACKUP_DIR_NAME);

  return {
    async createBackup(options = {}) {
      const payload = options.payload;
      if (!payload || typeof payload !== "object") {
        throw new Error("Missing vault backup payload.");
      }

      const dirPath = getBackupDir();
      const records = await listBackupRecords(dirPath);
      const fingerprint = computePayloadFingerprint(payload);
      const latest = records[0]?.record ?? null;
      if (latest?.fingerprint === fingerprint) {
        return {
          created: false,
          backup: toBackupSummary(latest),
        };
      }

      const createdAt = Date.now();
      const id = crypto.randomUUID();
      const preview = buildPreview(payload);
      const encoded = encodePayload(payload, safeStorage);
      const record = {
        formatVersion: 1,
        id,
        createdAt,
        reason: typeof options.reason === "string" ? options.reason : "before_restore",
        sourceAppVersion:
          typeof options.sourceAppVersion === "string" ? options.sourceAppVersion : undefined,
        targetAppVersion:
          typeof options.targetAppVersion === "string" ? options.targetAppVersion : undefined,
        fingerprint,
        preview,
        payloadEncoding: encoded.encoding,
        payloadData: encoded.data,
      };

      const filePath = path.join(
        dirPath,
        `${BACKUP_FILE_PREFIX}${createdAt}-${id}${BACKUP_FILE_EXT}`,
      );
      await fs.promises.writeFile(
        filePath,
        `${JSON.stringify(record, null, 2)}\n`,
        { mode: 0o600 },
      );

      await pruneBackupRecords(dirPath, options.maxCount);

      return {
        created: true,
        backup: toBackupSummary(record),
      };
    },

    async listBackups() {
      const records = await listBackupRecords(getBackupDir());
      return records.map(({ record }) => toBackupSummary(record));
    },

    async readBackup(options = {}) {
      const backupId = typeof options.id === "string" ? options.id : "";
      if (!backupId) {
        throw new Error("Missing vault backup id.");
      }

      const records = await listBackupRecords(getBackupDir());
      const match = records.find(({ record }) => record.id === backupId);
      if (!match) {
        throw new Error("Vault backup not found.");
      }

      return {
        backup: toBackupSummary(match.record),
        payload: decodePayload(match.record, safeStorage),
      };
    },

    async trimBackups(options = {}) {
      return pruneBackupRecords(getBackupDir(), options.maxCount);
    },

    async openBackupDir() {
      const dirPath = getBackupDir();
      await fs.promises.mkdir(dirPath, { recursive: true, mode: 0o700 });
      if (shell?.openPath) {
        const errorMessage = await shell.openPath(dirPath);
        if (errorMessage) {
          throw new Error(errorMessage);
        }
      }
      return {
        success: true,
        path: dirPath,
      };
    },
  };
}

function registerHandlers(ipcMain, electronModule) {
  const service = createVaultBackupService({
    app: electronModule?.app,
    safeStorage: electronModule?.safeStorage,
    shell: electronModule?.shell,
  });

  ipcMain.handle("netcatty:vaultBackups:create", async (_event, payload) => {
    return service.createBackup(payload || {});
  });
  ipcMain.handle("netcatty:vaultBackups:list", async () => {
    return service.listBackups();
  });
  ipcMain.handle("netcatty:vaultBackups:read", async (_event, payload) => {
    return service.readBackup(payload || {});
  });
  ipcMain.handle("netcatty:vaultBackups:trim", async (_event, payload) => {
    return service.trimBackups(payload || {});
  });
  ipcMain.handle("netcatty:vaultBackups:openDir", async () => {
    return service.openBackupDir();
  });
}

module.exports = {
  BACKUP_DIR_NAME,
  BACKUP_FILE_EXT,
  BACKUP_FILE_PREFIX,
  buildPreview,
  computePayloadFingerprint,
  createVaultBackupService,
  registerHandlers,
};
