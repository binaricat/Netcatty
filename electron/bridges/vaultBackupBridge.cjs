const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const BACKUP_DIR_NAME = "vault-backups";
const BACKUP_FILE_PREFIX = "vault-backup-";
const BACKUP_FILE_EXT = ".json";

// The renderer is the untrusted input boundary for this bridge, so every
// piece of user-controlled data is validated before it reaches disk or
// propagates back into the UI. Keep these limits in sync with the
// renderer's `sanitizeLocalVaultBackupMaxCount` constants.
const MIN_MAX_COUNT = 1;
const MAX_MAX_COUNT = 100;
const DEFAULT_MAX_COUNT = 20;
// 25 MiB — two orders of magnitude above any realistic vault. A payload
// exceeding this is either a runaway test harness or a misbehaving/compromised
// renderer; refusing here prevents disk-fill DoS. The vault proper is capped
// at a much smaller size elsewhere in the app, so legitimate users never hit
// this limit.
const MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;
const ALLOWED_REASONS = new Set(["app_version_change", "before_restore"]);
// Version strings are persisted and surfaced in the Settings UI, so they
// must not carry control chars that would break logs, parsing, or
// display. Keep alphanumerics + a handful of punctuation that covers
// SemVer-ish and prerelease tags.
const VERSION_STRING_PATTERN = /^[A-Za-z0-9._+\-]{1,64}$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Normalize a payload into a form that hashes stably across runs:
// - object keys sorted so JSON.stringify output is deterministic
// - undefined values dropped (they'd stringify as gaps anyway)
// - the TOP-LEVEL `syncedAt` timestamp is zeroed so semantically-equal
//   payloads produced seconds apart still dedupe. Nested `syncedAt`
//   fields (e.g. a future per-record mtime) are preserved — zeroing
//   them would silently collide two semantically-different payloads
//   into the same fingerprint and cause the version-change / protective
//   backup dedupe to drop a backup that should have been written.
//
// INVARIANT: array order is treated as semantically meaningful and is
// NOT canonicalized. Every domain array that flows through SyncPayload
// (hosts, keys, snippets, identities, portForwardingRules, …) is
// produced by a store that iterates its internal `Map`/`Set` in a
// stable, insertion-ordered way, so two semantically-equal payloads
// built in the same renderer session produce identical orderings. If a
// future refactor introduces a non-deterministic iteration source,
// fingerprints will flap and the dedupe will miss — sort at the
// producer, not here. Sorting inside the hash function would require
// choosing a stable key per array type and would silently hide
// intentionally-reordered payloads (user dragged a host in the list)
// as "the same backup," which would be a safety regression.
function normalizePayloadForHash(value, isRoot = true) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizePayloadForHash(item, false));
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return entries.reduce((acc, [entryKey, entryValue]) => {
      acc[entryKey] =
        isRoot && entryKey === "syncedAt"
          ? 0
          : normalizePayloadForHash(entryValue, false);
      return acc;
    }, {});
  }
  return value;
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

// Clamp an unvalidated maxCount to the supported range. Returns
// DEFAULT_MAX_COUNT for anything non-finite or non-numeric so callers
// without a configured retention still get a sane cap.
function sanitizeMaxCount(rawMaxCount) {
  const numeric = Number(rawMaxCount);
  if (!Number.isFinite(numeric) || numeric <= 0) return DEFAULT_MAX_COUNT;
  return Math.max(MIN_MAX_COUNT, Math.min(MAX_MAX_COUNT, Math.floor(numeric)));
}

function sanitizeReason(rawReason) {
  // Fall back to the "before_restore" default rather than throwing — the
  // default is the safer label for an unknown-cause backup, since it
  // implies "this was taken defensively" in the UI.
  if (typeof rawReason === "string" && ALLOWED_REASONS.has(rawReason)) {
    return rawReason;
  }
  return "before_restore";
}

function sanitizeOptionalVersionString(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!VERSION_STRING_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

// UTF-8 byte length of a payload's JSON serialization. Earlier revisions
// returned `JSON.stringify(payload).length` (UTF-16 code units), which
// under-counted by ~3x for non-ASCII vaults — a deck full of CJK snippet
// labels would report ~12.5 MiB against the 25 MiB cap when the on-wire
// size was actually 25+ MiB. `Buffer.byteLength(..., 'utf8')` gives the
// true bytes-on-disk figure.
function estimatePayloadSize(payload) {
  try {
    return Buffer.byteLength(JSON.stringify(payload), "utf8");
  } catch {
    return Infinity;
  }
}

// Error thrown when the platform has no secure storage available. Backups
// would contain plaintext credentials (passwords, private keys, passphrases)
// in fields that SyncPayload carries unencrypted, so falling back to a
// plain-json file on disk would regress the vault's security posture below
// what the normal encrypted localStorage vault provides. We refuse rather
// than silently weaken the user's protection.
class VaultBackupEncryptionUnavailableError extends Error {
  constructor() {
    super(
      "Secure storage is unavailable on this platform; vault backups cannot be created or read safely.",
    );
    this.name = "VaultBackupEncryptionUnavailableError";
    this.code = "VAULT_BACKUP_ENCRYPTION_UNAVAILABLE";
  }
}

class VaultBackupTooLargeError extends Error {
  constructor(size) {
    super(
      `Vault backup payload exceeds maximum allowed size (${size} > ${MAX_PAYLOAD_BYTES}).`,
    );
    this.name = "VaultBackupTooLargeError";
    this.code = "VAULT_BACKUP_TOO_LARGE";
  }
}

function isSafeStorageAvailable(safeStorage) {
  return Boolean(safeStorage?.isEncryptionAvailable?.());
}

function encodePayload(payload, safeStorage) {
  if (!isSafeStorageAvailable(safeStorage)) {
    throw new VaultBackupEncryptionUnavailableError();
  }
  const raw = JSON.stringify(payload);
  return {
    encoding: "safeStorage-v1",
    data: safeStorage.encryptString(raw).toString("base64"),
  };
}

function decodePayload(record, safeStorage) {
  if (record.payloadEncoding === "safeStorage-v1") {
    if (!safeStorage?.decryptString || !isSafeStorageAvailable(safeStorage)) {
      throw new VaultBackupEncryptionUnavailableError();
    }
    const decrypted = safeStorage.decryptString(Buffer.from(record.payloadData, "base64"));
    return JSON.parse(decrypted);
  }

  // Legacy "plain-json-v1" records may exist from an earlier build; read
  // them once so users can migrate their data, but never write new ones.
  if (record.payloadEncoding === "plain-json-v1") {
    return JSON.parse(record.payloadData);
  }

  throw new Error(`Unsupported vault backup encoding: ${record.payloadEncoding}`);
}

// Upper bound for a backup file on disk. The plaintext payload is capped
// at MAX_PAYLOAD_BYTES on write; the encrypted-and-base64-encoded record
// plus JSON envelope inflates that by ~2x worst case (base64 adds ~33%,
// JSON formatting adds some, and the record metadata rounds up). A 2x
// multiplier leaves comfortable headroom for legitimate backups while
// still rejecting a 100+ MiB file that a user (or attacker) dropped
// into the backup directory manually.
const MAX_BACKUP_FILE_BYTES = MAX_PAYLOAD_BYTES * 2;

async function readBackupRecord(filePath) {
  // Refuse oversized files BEFORE readFile. `fs.readFile` buffers the
  // whole file into memory, so an attacker (or a corrupted state) that
  // places a huge file in the backup dir could OOM the renderer during
  // listBackups enumeration. Stat-then-read keeps the failure mode to
  // a cheap rejection.
  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (error) {
    throw new Error(`Unable to stat vault backup ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (stat.size > MAX_BACKUP_FILE_BYTES) {
    throw new VaultBackupTooLargeError(stat.size);
  }
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
    if (aTime !== bTime) return bTime - aTime;
    // Stable, deterministic tiebreak when two backups share a millisecond
    // (rapid successive creates, clock quantization). Without this the
    // retention trimmer's "delete the oldest" pass is order-dependent and
    // can drop a different record across list() → prune() passes.
    const aId = String(a.record.id || '');
    const bId = String(b.record.id || '');
    return bId.localeCompare(aId);
  });

  return records;
}

// Delete old backups, trusting the caller-provided `records` list when
// supplied to avoid a redundant directory scan. `createBackup` has just
// scanned + written, so it passes its freshly-enumerated records through
// here. External callers (retention-change UI, trim IPC) rescan.
async function pruneBackupRecords(dirPath, maxCount, records = null) {
  const sanitizedMaxCount = sanitizeMaxCount(maxCount);
  const sourceRecords = records ?? (await listBackupRecords(dirPath));
  const toDelete = sourceRecords.slice(sanitizedMaxCount);
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
    keptCount: Math.min(sourceRecords.length, sanitizedMaxCount),
  };
}

function createVaultBackupService({ app, safeStorage, shell }) {
  if (!app?.getPath) {
    throw new Error("Electron app is unavailable.");
  }

  const getBackupDir = () => path.join(app.getPath("userData"), BACKUP_DIR_NAME);

  // Serialize createBackup so two concurrent calls (version-change backup
  // running at startup + an explicit protective-before-restore triggered
  // by the user's click, etc.) observe each other's writes. Without this,
  // both observers would see an empty directory, compute the same
  // fingerprint, skip the dedupe, and write two identical files.
  let createBackupLock = Promise.resolve();
  // Monotonically increasing `createdAt` per service instance. `Date.now()`
  // has 1ms resolution and back-to-back async calls (version-change backup
  // followed immediately by a protective backup) can land in the same
  // millisecond, producing ties that `listBackupRecords` cannot resolve
  // (the sort has no tiebreaker). Bumping ensures strict ordering so
  // callers always see the true newest record first.
  let lastCreatedAt = 0;

  return {
    isEncryptionAvailable() {
      return isSafeStorageAvailable(safeStorage);
    },

    async createBackup(options = {}) {
      const next = createBackupLock.then(() => doCreateBackup(options));
      // Swallow the rejection on the lock chain so one caller's error
      // does not poison subsequent calls; each individual await sees its
      // own rejection via the `next` return.
      createBackupLock = next.catch(() => undefined);
      return next;
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

  async function doCreateBackup(options) {
    const payload = options.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Missing vault backup payload.");
    }

    // Refuse early when the payload is too large to prevent a
    // misbehaving or compromised renderer from filling the disk. The
    // check runs before any side effect so callers see a deterministic
    // failure rather than a partial write.
    const estimatedSize = estimatePayloadSize(payload);
    if (estimatedSize > MAX_PAYLOAD_BYTES) {
      throw new VaultBackupTooLargeError(estimatedSize);
    }

    // Refuse before doing anything side-effectful so callers get a clear
    // error rather than a silently-weakened plaintext backup.
    if (!isSafeStorageAvailable(safeStorage)) {
      throw new VaultBackupEncryptionUnavailableError();
    }

    const dirPath = getBackupDir();
    const existingRecords = await listBackupRecords(dirPath);
    const fingerprint = computePayloadFingerprint(payload);
    const latest = existingRecords[0]?.record ?? null;
    if (latest?.fingerprint === fingerprint) {
      return {
        created: false,
        backup: toBackupSummary(latest),
      };
    }

    let createdAt = Date.now();
    if (createdAt <= lastCreatedAt) createdAt = lastCreatedAt + 1;
    lastCreatedAt = createdAt;
    const id = crypto.randomUUID();
    const preview = buildPreview(payload);
    const encoded = encodePayload(payload, safeStorage);
    const record = {
      formatVersion: 1,
      id,
      createdAt,
      reason: sanitizeReason(options.reason),
      sourceAppVersion: sanitizeOptionalVersionString(options.sourceAppVersion),
      targetAppVersion: sanitizeOptionalVersionString(options.targetAppVersion),
      fingerprint,
      preview,
      payloadEncoding: encoded.encoding,
      payloadData: encoded.data,
    };

    const filePath = path.join(
      dirPath,
      `${BACKUP_FILE_PREFIX}${createdAt}-${id}${BACKUP_FILE_EXT}`,
    );
    // Durable atomic write: serialize to a sibling tmp file, fsync the
    // file's data+metadata to stable storage, rename into place, then
    // fsync the directory entry itself. Without the file fsync a system
    // crash between writeFile and rename can leave the OS with a
    // successfully-renamed entry whose data blocks are still only in
    // page cache — the file is visible but reads back as zeros or torn
    // content. Without the directory fsync the rename itself may not be
    // durable: on recovery listBackups sees an empty directory even
    // though the file's blocks made it to disk. Both matter for the
    // protective-before-restore case, where the user is about to
    // overwrite their vault and the safety net MUST survive a crash
    // between backup and restore.
    const tmpPath = `${filePath}.tmp-${crypto.randomUUID()}`;
    let tmpHandle;
    try {
      tmpHandle = await fs.promises.open(tmpPath, 'w', 0o600);
      await tmpHandle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
      await tmpHandle.sync();
    } finally {
      if (tmpHandle) {
        try {
          await tmpHandle.close();
        } catch {
          /* ignore — close failure after successful sync still leaves
             data durable on disk */
        }
      }
    }
    try {
      await fs.promises.rename(tmpPath, filePath);
    } catch (renameError) {
      // Best-effort cleanup; swallow unlink errors so the rename error
      // surfaces to the caller.
      try {
        await fs.promises.unlink(tmpPath);
      } catch {
        /* ignore */
      }
      throw renameError;
    }
    // fsync the directory so the rename itself is durably recorded.
    // On Linux this is required; on macOS it is a no-op at the FS
    // layer but still safe and portable. On Windows fs.open on a
    // directory is not supported — the rename is durable as part of
    // NTFS's journal, so skip the sync there.
    if (process.platform !== 'win32') {
      let dirHandle;
      try {
        dirHandle = await fs.promises.open(dirPath, 'r');
        await dirHandle.sync();
      } catch (dirSyncError) {
        // Directory fsync is a defense-in-depth hardening step — if
        // the filesystem refuses (tmpfs, some network mounts) the
        // rename already happened and the file is reachable, so a
        // failure here should not abort the backup. Log so a
        // systematic issue is diagnosable.
        console.warn('[vaultBackupBridge] Directory fsync failed:', dirSyncError);
      } finally {
        if (dirHandle) {
          try {
            await dirHandle.close();
          } catch {
            /* ignore */
          }
        }
      }
    }

    // Reuse the enumeration we already did for dedupe, prepending the
    // newly-written record so pruneBackupRecords can trim without
    // re-scanning the directory. Records are ordered newest-first.
    const nextRecords = [{ record, filePath }, ...existingRecords];
    await pruneBackupRecords(dirPath, options.maxCount, nextRecords);

    return {
      created: true,
      backup: toBackupSummary(record),
    };
  }
}

function registerHandlers(ipcMain, electronModule) {
  const service = createVaultBackupService({
    app: electronModule?.app,
    safeStorage: electronModule?.safeStorage,
    shell: electronModule?.shell,
  });

  const BrowserWindow = electronModule?.BrowserWindow;

  // Broadcast a backup-changed event to every renderer so other windows
  // (notably the Settings window's backup list) can refresh without the
  // user manually navigating. Any successful create / trim path calls
  // this. Failures fall through silently — a dropped notification is
  // recoverable on the next manual refresh, while re-throwing here
  // would turn a harmless broadcast failure into a user-visible error.
  const broadcastBackupsChanged = () => {
    if (!BrowserWindow?.getAllWindows) return;
    try {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed?.()) continue;
        try {
          win.webContents?.send?.("netcatty:vaultBackups:changed");
        } catch (error) {
          console.warn("[vaultBackupBridge] Failed to notify window:", error);
        }
      }
    } catch (error) {
      console.warn("[vaultBackupBridge] Broadcast failed:", error);
    }
  };

  ipcMain.handle("netcatty:vaultBackups:capabilities", async () => {
    return { encryptionAvailable: service.isEncryptionAvailable() };
  });
  ipcMain.handle("netcatty:vaultBackups:create", async (_event, payload) => {
    const result = await service.createBackup(payload || {});
    // Only broadcast when a new record was actually written; a
    // deduped (created=false) return means the on-disk state did not
    // change, so other windows already show the latest backup.
    if (result?.created) {
      broadcastBackupsChanged();
    }
    return result;
  });
  ipcMain.handle("netcatty:vaultBackups:list", async () => {
    return service.listBackups();
  });
  ipcMain.handle("netcatty:vaultBackups:read", async (_event, payload) => {
    return service.readBackup(payload || {});
  });
  ipcMain.handle("netcatty:vaultBackups:trim", async (_event, payload) => {
    const result = await service.trimBackups(payload || {});
    if (result?.deletedCount) {
      broadcastBackupsChanged();
    }
    return result;
  });
  ipcMain.handle("netcatty:vaultBackups:openDir", async () => {
    return service.openBackupDir();
  });
}

module.exports = {
  BACKUP_DIR_NAME,
  BACKUP_FILE_EXT,
  BACKUP_FILE_PREFIX,
  MAX_PAYLOAD_BYTES,
  VaultBackupEncryptionUnavailableError,
  VaultBackupTooLargeError,
  buildPreview,
  computePayloadFingerprint,
  createVaultBackupService,
  registerHandlers,
};
