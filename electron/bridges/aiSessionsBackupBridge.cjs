/**
 * AI Sessions Backup Bridge - durable disk mirror of the renderer's AI chat
 * session store (`netcatty_ai_sessions_v1` in localStorage).
 *
 * localStorage lives inside the Electron profile directory, so reinstalling,
 * moving or recreating the app takes the chat history with it, and in-app
 * cleanup sweeps / cap eviction can also shrink the live store. This bridge
 * keeps timestamped JSON generations under
 * `{userData}/ai-sessions-backup/` so the newest store can be restored on
 * boot when the live store is missing or empty (never on top of a non-empty
 * store — see useAIState).
 *
 * Generations are capped (default 5) and each write is atomic
 * (temp file + rename). All handlers never throw: a backup failure must not
 * break chat persistence.
 */

const fs = require("node:fs");
const path = require("node:path");

let backupDir = null;
let electronDialog = null;

const BACKUP_DIR_NAME = "ai-sessions-backup";
const FILE_PREFIX = "ai-sessions-";
const EXPORT_PREFIX = "export-";
const FILE_SUFFIX = ".json";
/** Keep at most this many rolling generations (plus dated export files). */
const MAX_GENERATIONS = 5;
/**
 * Hard cap for a mirrored payload. localStorage itself targets ~2 MB, but when
 * cloud AI-session sync is enabled the renderer persists the full unpruned
 * history for the disk mirror — that can exceed 4 MB. Keep a generous disk
 * ceiling so synced histories still get rolling backups, while still rejecting
 * runaway payloads.
 */
const MAX_BACKUP_JSON_BYTES = 64 * 1024 * 1024;

/**
 * The automatic mirror recovers from in-profile localStorage loss or corruption
 * (quota, empty or corrupt JSON, or accidental clear). Profile deletion or
 * recreation is out of scope; use the manual export/import buttons for that.
 */
function ensureBackupDir() {
  if (backupDir) return backupDir;
  try {
    let userDataPath = null;
    try {
      const { app } = require("electron");
      userDataPath = app?.getPath?.("userData") ?? null;
    } catch {
      userDataPath = null;
    }
    if (!userDataPath) return null;
    backupDir = path.join(userDataPath, BACKUP_DIR_NAME);
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    return backupDir;
  } catch {
    return null;
  }
}

function listGenerationFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((file) => file.startsWith(FILE_PREFIX) && file.endsWith(FILE_SUFFIX))
      .sort()
      .reverse(); // timestamped names sort lexicographically newest-first
  } catch {
    return [];
  }
}

function listExportFiles(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((file) => file.startsWith(EXPORT_PREFIX) && file.endsWith(FILE_SUFFIX))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function timestampToken(now = new Date()) {
  return `${now.toISOString().replace(/[-:]/g, "").replace(".", "-")}`;
}

let writeQueue = Promise.resolve();

/**
 * Write one generation atomically (temp + rename) and prune older ones.
 * Resolves { ok, file } and never rejects. Writes are serialized and use
 * fs.promises: the history can be several MB and is written on every
 * debounced chat change, which used to block the main thread (all windows).
 */
function writeGeneration(json) {
  const run = () => writeGenerationNow(json);
  const result = writeQueue.then(run, run);
  writeQueue = result.catch(() => {});
  return result;
}

async function writeGenerationNow(json) {
  const dir = ensureBackupDir();
  if (!dir) return { ok: false, error: "no-backup-dir" };
  if (typeof json !== "string" || json.length === 0) {
    return { ok: false, error: "invalid-json" };
  }
  if (Buffer.byteLength(json, "utf-8") > MAX_BACKUP_JSON_BYTES) {
    return { ok: false, error: "payload-too-large" };
  }

  const file = `${FILE_PREFIX}${timestampToken()}${FILE_SUFFIX}`;
  const filePath = path.join(dir, file);
  const tmpPath = `${filePath}.tmp`;
  try {
    await fs.promises.writeFile(tmpPath, json, "utf-8");
    await fs.promises.rename(tmpPath, filePath);
  } catch (error) {
    await fs.promises.unlink(tmpPath).catch(() => {});
    return { ok: false, error: String(error) };
  }

  // Keep only the newest MAX_GENERATIONS generations.
  const generations = listGenerationFiles(dir);
  for (const stale of generations.slice(MAX_GENERATIONS)) {
    await fs.promises.unlink(path.join(dir, stale)).catch(() => {});
  }
  return { ok: true, file };
}

/**
 * Read the newest usable session array. Invalid generations are skipped and
 * older ones are tried, so one bad write never blocks a restore.
 */
function readLatestGeneration() {
  const dir = ensureBackupDir();
  if (!dir) return { ok: false };
  for (const file of listGenerationFiles(dir)) {
    try {
      const json = fs.readFileSync(path.join(dir, file), "utf-8");
      const parsed = JSON.parse(json);
      // Structurally unusable payloads can fall back to an older session array.
      if (!Array.isArray(parsed)) continue;
      // An empty array is an intentional wipe and must not resurrect older chats.
      if (parsed.length === 0) return { ok: true, json, file };
      if (!parsed.some((entry) => (
        entry !== null && typeof entry === "object"
        && typeof entry.id === "string"
        && typeof entry.title === "string"
        && typeof entry.agentId === "string"
        && entry.scope !== null && typeof entry.scope === "object"
        && typeof entry.scope.type === "string"
        && Array.isArray(entry.messages)
        && entry.messages.every((message) => (
          message !== null && typeof message === "object"
          && typeof message.id === "string"
          && typeof message.role === "string"
          && typeof message.content === "string"
          && typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
        ))
        && typeof entry.updatedAt === "number" && Number.isFinite(entry.updatedAt)
      ))) continue;
      return { ok: true, json, file };
    } catch {
      // try the next older generation
    }
  }
  return { ok: false };
}

async function exportToFile(json) {
  const dir = ensureBackupDir();
  if (!dir) return { success: false, error: "no-backup-dir" };
  if (typeof json !== "string" || json.length === 0) {
    return { success: false, error: "invalid-json" };
  }
  try {
    let result;
    if (electronDialog?.showSaveDialog) {
      result = await electronDialog.showSaveDialog({
        defaultPath: `${EXPORT_PREFIX}${timestampToken()}${FILE_SUFFIX}`,
        filters: [
          { name: "JSON", extensions: ["json"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });
      if (result.canceled || !result.filePath) {
        return { success: false, canceled: true };
      }
    } else {
      // Fallback when no dialog is available (tests / unusual hosts): fixed
      // path next to the rolling generations.
      return await writeExportFixed(dir, json);
    }
    await fs.promises.writeFile(result.filePath, json, "utf-8");
    return { success: true, filePath: result.filePath };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

async function writeExportFixed(dir, json) {
  const filePath = path.join(dir, `${EXPORT_PREFIX}${timestampToken()}${FILE_SUFFIX}`);
  try {
    await fs.promises.writeFile(filePath, json, "utf-8");
    return { success: true, filePath };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

async function importFromFile() {
  try {
    if (electronDialog?.showOpenDialog) {
      const result = await electronDialog.showOpenDialog({
        properties: ["openFile"],
        filters: [
          { name: "JSON", extensions: ["json"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }
      const json = await fs.promises.readFile(result.filePaths[0], "utf-8");
      return { success: true, json };
    }
    // No dialog available: import the newest fixed-path export instead of
    // failing outright.
    const dir = ensureBackupDir();
    if (!dir) return { success: false, error: "no-backup-dir" };
    const exports = listExportFiles(dir);
    if (exports.length === 0) return { success: false, error: "no-export-file" };
    const json = await fs.promises.readFile(path.join(dir, exports[0]), "utf-8");
    return { success: true, json };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}

function registerHandlers(ipcMain) {
  ipcMain.handle("netcatty:aiSessionsBackup:write", (_event, payload) =>
    writeGeneration(payload?.json));
  ipcMain.handle("netcatty:aiSessionsBackup:readLatest", () => readLatestGeneration());
  ipcMain.handle("netcatty:aiSessionsBackup:export", (_event, payload) =>
    exportToFile(payload?.json));
  ipcMain.handle("netcatty:aiSessionsBackup:import", () => importFromFile());
}

const __internals = {
  BACKUP_DIR_NAME,
  FILE_PREFIX,
  EXPORT_PREFIX,
  MAX_GENERATIONS,
  MAX_BACKUP_JSON_BYTES,
  listGenerationFiles,
  listExportFiles,
  timestampToken,
  writeGeneration,
  readLatestGeneration,
  writeExportFixed,
  // Tests point the bridge at a temp directory without Electron.
  _setBackupDir(dir) {
    backupDir = dir;
  },
};

module.exports = {
  init(deps) {
    electronDialog = deps?.electronModule?.dialog ?? null;
    ensureBackupDir();
  },
  registerHandlers,
  __internals,
};
