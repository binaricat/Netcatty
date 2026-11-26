"use strict";

const fs = require("node:fs");
const path = require("node:path");

// ── MS-RDPEFS / NTSTATUS Constants ──

const NTSTATUS = Object.freeze({
  SUCCESS: 0x00000000,
  NO_MORE_FILES: 0x80000006,
  UNSUCCESSFUL: 0xc0000001,
  NOT_IMPLEMENTED: 0xc0000002,
  INVALID_PARAMETER: 0xc000000d,
  NO_SUCH_FILE: 0xc000000f,
  ACCESS_DENIED: 0xc0000022,
  OBJECT_NAME_INVALID: 0xc0000033,
  OBJECT_NAME_NOT_FOUND: 0xc0000034,
  OBJECT_NAME_COLLISION: 0xc0000035,
  OBJECT_PATH_NOT_FOUND: 0xc000003a,
  DELETE_PENDING: 0xc0000056,
  DISK_FULL: 0xc000007f,
  INSUFFICIENT_RESOURCES: 0xc000009a,
  MEDIA_WRITE_PROTECTED: 0xc00000a2,
  FILE_IS_A_DIRECTORY: 0xc00000ba,
  NOT_SUPPORTED: 0xc00000bb,
  DIRECTORY_NOT_EMPTY: 0xc0000101,
  NOT_A_DIRECTORY: 0xc0000103,
  CANNOT_DELETE: 0xc0000121,
});

const CREATE_DISPOSITION = Object.freeze({
  FILE_SUPERSEDE: 0x00000000,
  FILE_OPEN: 0x00000001,
  FILE_CREATE: 0x00000002,
  FILE_OPEN_IF: 0x00000003,
  FILE_OVERWRITE: 0x00000004,
  FILE_OVERWRITE_IF: 0x00000005,
});

const CREATE_INFORMATION = Object.freeze({
  FILE_SUPERSEDED: 0x00,
  FILE_OPENED: 0x01,
  FILE_CREATED: 0x02,
  FILE_OVERWRITTEN: 0x03,
});

const CREATE_OPTIONS = Object.freeze({
  FILE_DIRECTORY_FILE: 0x00000001,
  FILE_NON_DIRECTORY_FILE: 0x00000040,
  FILE_DELETE_ON_CLOSE: 0x00001000,
});

const DESIRED_ACCESS = Object.freeze({
  FILE_READ_DATA: 0x00000001,
  FILE_WRITE_DATA: 0x00000002,
  FILE_APPEND_DATA: 0x00000004,
  FILE_EXECUTE: 0x00000020,
  FILE_WRITE_ATTRIBUTES: 0x00000100,
  DELETE: 0x00010000,
  MAXIMUM_ALLOWED: 0x02000000,
  GENERIC_ALL: 0x10000000,
  GENERIC_EXECUTE: 0x20000000,
  GENERIC_WRITE: 0x40000000,
  GENERIC_READ: 0x80000000,
});

const FILE_ATTRIBUTES = Object.freeze({
  READONLY: 0x00000001,
  HIDDEN: 0x00000002,
  DIRECTORY: 0x00000010,
  ARCHIVE: 0x00000020,
  NORMAL: 0x00000080,
});

const FILE_INFO_CLASS = Object.freeze({
  DIRECTORY: 1,
  FULL_DIRECTORY: 2,
  BOTH_DIRECTORY: 3,
  BASIC: 4,
  STANDARD: 5,
  RENAME: 10,
  NAMES: 12,
  DISPOSITION: 13,
  ALLOCATION: 19,
  END_OF_FILE: 20,
  ATTRIBUTE_TAG: 35,
});

const FS_INFO_CLASS = Object.freeze({
  VOLUME: 1,
  SIZE: 3,
  DEVICE: 4,
  ATTRIBUTE: 5,
  FULL_SIZE: 7,
});

const FS_ATTRIBUTES = Object.freeze({
  CASE_SENSITIVE_SEARCH: 0x00000001,
  CASE_PRESERVED_NAMES: 0x00000002,
  UNICODE_ON_DISK: 0x00000004,
  READ_ONLY_VOLUME: 0x00080000,
});

const MAX_OPEN_HANDLES_PER_SESSION = 256;
const MAX_READ_BYTES = 2 * 1024 * 1024; // 2 MiB
const FILETIME_EPOCH_DIFF = 116444736000000000n;
const ALLOCATION_BLOCK_SIZE = 4096;

// ── Time, Attributes, Wildcard & Error Helpers ──

function unixMsToFiletimeString(ms) {
  if (!Number.isFinite(ms)) return "0";
  const ticks = BigInt(Math.trunc(ms)) * 10000n + FILETIME_EPOCH_DIFF;
  return (ticks < 0n ? 0n : ticks).toString();
}

function filetimeToUnixSeconds(value) {
  if (value === null || value === undefined || value === "") return null;
  let ft;
  try {
    if (typeof value === "bigint") {
      ft = value;
    } else if (typeof value === "string") {
      const trimmed = value.trim();
      if (!/^-?\d+$/.test(trimmed)) return null;
      ft = BigInt(trimmed);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      ft = BigInt(Math.trunc(value));
    } else {
      return null;
    }
  } catch {
    return null;
  }
  // Windows passes 0 or -1 to mean "do not modify this timestamp".
  if (ft <= 0n) return null;
  const diff = ft - FILETIME_EPOCH_DIFF;
  if (diff < 0n) return null;
  const secs = Number(diff / 10000000n);
  const frac = Number(diff % 10000000n) / 10000000;
  return secs + frac;
}

function computeFileAttributes(stat, fileName, driveReadOnly) {
  const isDir = stat.isDirectory();
  let attrs = isDir ? FILE_ATTRIBUTES.DIRECTORY : FILE_ATTRIBUTES.ARCHIVE;
  if (
    typeof fileName === "string"
    && fileName.length > 1
    && fileName.startsWith(".")
    && fileName !== ".."
  ) {
    attrs |= FILE_ATTRIBUTES.HIDDEN;
  }
  const posixReadOnly = typeof stat.mode === "number" && (stat.mode & 0o222) === 0;
  if (driveReadOnly || posixReadOnly) {
    attrs |= FILE_ATTRIBUTES.READONLY;
  }
  return attrs;
}

function roundAllocationSize(size, isDir) {
  if (isDir || !Number.isFinite(size) || size <= 0) return 0;
  return Math.ceil(size / ALLOCATION_BLOCK_SIZE) * ALLOCATION_BLOCK_SIZE;
}

function statToEntry(fileName, stat, driveReadOnly) {
  const isDir = stat.isDirectory();
  const size = isDir ? 0 : Math.max(0, Number(stat.size) || 0);
  const ctimeMs = Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0
    ? stat.birthtimeMs
    : stat.ctimeMs;
  return {
    fileName,
    creationTime: unixMsToFiletimeString(ctimeMs),
    lastAccessTime: unixMsToFiletimeString(stat.atimeMs),
    lastWriteTime: unixMsToFiletimeString(stat.mtimeMs),
    changeTime: unixMsToFiletimeString(stat.ctimeMs),
    endOfFile: size,
    allocationSize: roundAllocationSize(size, isDir),
    fileAttributes: computeFileAttributes(stat, fileName, driveReadOnly),
  };
}

function mapErrnoToNtStatus(err) {
  const code = err?.code;
  switch (code) {
    case "ENOENT":
      return NTSTATUS.OBJECT_NAME_NOT_FOUND;
    case "EEXIST":
      return NTSTATUS.OBJECT_NAME_COLLISION;
    case "ENOTDIR":
      return NTSTATUS.NOT_A_DIRECTORY;
    case "EISDIR":
      return NTSTATUS.FILE_IS_A_DIRECTORY;
    case "ENOTEMPTY":
      return NTSTATUS.DIRECTORY_NOT_EMPTY;
    case "ENAMETOOLONG":
      return NTSTATUS.OBJECT_NAME_INVALID;
    case "EACCES":
    case "EPERM":
    case "ELOOP":
    case "EXDEV":
    case "EBADF":
      return NTSTATUS.ACCESS_DENIED;
    case "EROFS":
      return NTSTATUS.MEDIA_WRITE_PROTECTED;
    case "ENOSPC":
    case "EDQUOT":
      return NTSTATUS.DISK_FULL;
    case "EMFILE":
    case "ENFILE":
      return NTSTATUS.INSUFFICIENT_RESOURCES;
    default:
      return NTSTATUS.UNSUCCESSFUL;
  }
}

function escapeRegexChar(ch) {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Windows/DOS-compatible wildcard matching (`*`, `?`, `*.*`, trailing `.*`).
 */
function matchWindowsWildcard(fileName, pattern) {
  const name = String(fileName || "").toLowerCase();
  const pat = String(pattern || "*").toLowerCase();
  if (pat === "*" || pat === "*.*" || pat === "") {
    return true;
  }

  // Handle trailing ".*" (in DOS/Windows, "foo.*" matches both "foo" and "foo.txt").
  const normalizedPat = pat.endsWith(".*")
    ? { prefix: pat.slice(0, -2), optionalDotStar: true }
    : { prefix: pat, optionalDotStar: false };

  let regexStr = "^";
  for (let i = 0; i < normalizedPat.prefix.length; i += 1) {
    const ch = normalizedPat.prefix[i];
    if (ch === "*") {
      regexStr += ".*";
    } else if (ch === "?") {
      regexStr += ".";
    } else {
      regexStr += escapeRegexChar(ch);
    }
  }
  if (normalizedPat.optionalDotStar) {
    regexStr += "(?:\\..*)?$";
  } else {
    regexStr += "$";
  }

  return new RegExp(regexStr).test(name);
}

// ── Strict Path Jail ──

function isPathInsideRoot(canonicalRoot, candidate, pathImpl = path) {
  if (candidate === canonicalRoot) return true;
  const prefix = canonicalRoot.endsWith(pathImpl.sep)
    ? canonicalRoot
    : `${canonicalRoot}${pathImpl.sep}`;
  return candidate.startsWith(prefix);
}

function parseAndValidateRelativePath(rawPath) {
  if (rawPath === undefined || rawPath === null) {
    return { ok: true, segments: [], relPath: "" };
  }
  if (typeof rawPath !== "string") {
    return { ok: false, status: NTSTATUS.ACCESS_DENIED };
  }
  // Reject NUL bytes and Windows Alternate Data Stream (ADS) colons.
  if (rawPath.includes("\0") || rawPath.includes(":")) {
    return { ok: false, status: NTSTATUS.ACCESS_DENIED };
  }

  const normalized = rawPath.replace(/\\/g, "/");
  const rawSegments = normalized.split("/");
  const segments = [];
  for (const seg of rawSegments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      return { ok: false, status: NTSTATUS.ACCESS_DENIED };
    }
    segments.push(seg);
  }
  return { ok: true, segments, relPath: segments.join("/") };
}

async function resolveJailedPath(canonicalRoot, rawPath, fsPromises, pathImpl = path) {
  const parsed = parseAndValidateRelativePath(rawPath);
  if (!parsed.ok) {
    return { ok: false, status: parsed.status };
  }

  const resolved = parsed.segments.length === 0
    ? canonicalRoot
    : pathImpl.resolve(canonicalRoot, ...parsed.segments);

  if (!isPathInsideRoot(canonicalRoot, resolved, pathImpl)) {
    return { ok: false, status: NTSTATUS.ACCESS_DENIED };
  }

  // Verify realpath for existing targets or nearest existing parent for non-existent targets.
  try {
    const lstat = await fsPromises.lstat(resolved);
    try {
      const real = await fsPromises.realpath(resolved);
      if (!isPathInsideRoot(canonicalRoot, real, pathImpl)) {
        return { ok: false, status: NTSTATUS.ACCESS_DENIED };
      }
      const stat = lstat.isSymbolicLink() ? await fsPromises.stat(real) : lstat;
      return {
        ok: true,
        exists: true,
        relPath: parsed.relPath,
        fullPath: resolved,
        realPath: real,
        stat,
        lstat,
      };
    } catch (realErr) {
      // Broken symlink or symlink loop must never be allowed through.
      if (lstat.isSymbolicLink()) {
        return { ok: false, status: NTSTATUS.ACCESS_DENIED };
      }
      return { ok: false, status: mapErrnoToNtStatus(realErr) };
    }
  } catch (err) {
    if (err?.code !== "ENOENT" && err?.code !== "ENOTDIR") {
      return { ok: false, status: mapErrnoToNtStatus(err) };
    }

    // Walk up to nearest existing ancestor and confirm it lies strictly inside canonicalRoot.
    let ancestor = pathImpl.dirname(resolved);
    let verifiedAncestor = false;
    while (isPathInsideRoot(canonicalRoot, ancestor, pathImpl)) {
      try {
        const realAncestor = await fsPromises.realpath(ancestor);
        if (!isPathInsideRoot(canonicalRoot, realAncestor, pathImpl)) {
          return { ok: false, status: NTSTATUS.ACCESS_DENIED };
        }
        verifiedAncestor = true;
        break;
      } catch (ancErr) {
        if (ancErr?.code === "ENOENT" || ancErr?.code === "ENOTDIR") {
          const next = pathImpl.dirname(ancestor);
          if (next === ancestor) break;
          ancestor = next;
          continue;
        }
        return { ok: false, status: NTSTATUS.ACCESS_DENIED };
      }
    }

    if (!verifiedAncestor) {
      return { ok: false, status: NTSTATUS.ACCESS_DENIED };
    }

    if (err?.code === "ENOTDIR") {
      return { ok: false, status: NTSTATUS.OBJECT_PATH_NOT_FOUND };
    }

    return {
      ok: true,
      exists: false,
      relPath: parsed.relPath,
      fullPath: resolved,
      realPath: null,
      stat: null,
      lstat: null,
    };
  }
}

function sanitizeDriveName(name, fallbackPath, pathImpl = path) {
  const base = typeof name === "string" && name.trim()
    ? name.trim()
    : pathImpl.basename(String(fallbackPath || "")) || "Shared";
  const cleaned = base
    .replace(/[\0\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
  return cleaned || "Shared";
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (Array.isArray(data)) {
    return Buffer.from(data);
  }
  if (typeof data === "string") {
    return Buffer.from(data, "base64");
  }
  return Buffer.alloc(0);
}

// ── Core RDPDR Filesystem Bridge Factory ──

function createRemoteDesktopRdpdrBridge(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const fsPromises = fsImpl.promises;
  const pathImpl = options.pathImpl || path;
  const maxOpenHandles = Number.isInteger(options.maxOpenHandles) && options.maxOpenHandles > 0
    ? options.maxOpenHandles
    : MAX_OPEN_HANDLES_PER_SESSION;

  /**
   * sessionId -> {
   *   drives: Map<number, { deviceId, rootPath, canonicalRoot, name, readOnly }>,
   *   handles: Map<number, HandleEntry>,
   *   nextFileId: number,
   *   webContentsId: number | null,
   * }
   */
  const sessions = new Map();
  /** webContentsId -> Set<sessionId> */
  const ownerSessions = new Map();

  function getOrCreateSession(sessionId, webContentsId = null) {
    let state = sessions.get(sessionId);
    if (!state) {
      state = {
        drives: new Map(),
        handles: new Map(),
        nextFileId: 1,
        webContentsId,
      };
      sessions.set(sessionId, state);
    } else if (webContentsId !== null && state.webContentsId === null) {
      state.webContentsId = webContentsId;
    }
    if (Number.isSafeInteger(webContentsId)) {
      let set = ownerSessions.get(webContentsId);
      if (!set) {
        set = new Set();
        ownerSessions.set(webContentsId, set);
      }
      set.add(sessionId);
    }
    return state;
  }

  function allocateFileId(state) {
    for (let attempts = 0; attempts <= state.handles.size + 2; attempts += 1) {
      const candidate = state.nextFileId;
      state.nextFileId = state.nextFileId >= 0xffffffff ? 1 : state.nextFileId + 1;
      if (candidate >= 1 && !state.handles.has(candidate)) {
        return candidate;
      }
    }
    return null;
  }

  async function closeHandleEntry(state, fileId, { allowDeleteOnClose = true } = {}) {
    const entry = state.handles.get(fileId);
    if (!entry) return;
    state.handles.delete(fileId);
    if (entry.fh) {
      try {
        await entry.fh.close();
      } catch {
        // ignore close errors
      }
      entry.fh = null;
    }

    if (allowDeleteOnClose && entry.deleteOnClose && entry.relPath !== "") {
      const drive = state.drives.get(entry.deviceId);
      if (!drive || drive.readOnly) return;
      const stillOpen = [...state.handles.values()].some(
        (other) => other.deviceId === entry.deviceId && other.relPath === entry.relPath,
      );
      if (stillOpen) return;

      const check = await resolveJailedPath(drive.canonicalRoot, entry.relPath, fsPromises, pathImpl);
      if (!check.ok || !check.exists || check.relPath === "") return;
      try {
        if (check.stat.isDirectory()) {
          await fsPromises.rmdir(check.fullPath);
        } else {
          await fsPromises.unlink(check.fullPath);
        }
      } catch {
        // Per MS-FSA 2.1.5.5, close never returns delete-on-close errors.
      }
    }
  }

  async function closeAllHandlesForSession(sessionId, { allowDeleteOnClose = false } = {}) {
    const state = sessions.get(sessionId);
    if (!state) return;
    state.resetGeneration = (state.resetGeneration || 0) + 1;
    const ids = [...state.handles.keys()];
    for (const fileId of ids) {
      await closeHandleEntry(state, fileId, { allowDeleteOnClose });
    }
  }

  async function registerDrives(sessionId, drives = [], { webContentsId = null } = {}) {
    if (!sessionId || typeof sessionId !== "string") {
      return { ok: false, error: "sessionId is required", registered: [], rejected: [] };
    }
    const state = getOrCreateSession(sessionId, webContentsId);
    const list = Array.isArray(drives) ? drives : [];
    const nextDeviceIds = new Set();
    const registered = [];
    const rejected = [];

    for (const item of list) {
      const deviceId = Number(item?.deviceId);
      const rawRoot = typeof item?.path === "string" ? item.path.trim() : "";
      if (!Number.isInteger(deviceId) || deviceId <= 0 || !rawRoot) {
        rejected.push({
          deviceId: item?.deviceId,
          path: rawRoot,
          reason: "Invalid deviceId or path",
        });
        continue;
      }

      try {
        const stat = await fsPromises.stat(rawRoot);
        if (!stat.isDirectory()) {
          rejected.push({ deviceId, path: rawRoot, reason: "Path is not a directory" });
          continue;
        }
        const canonicalRoot = await fsPromises.realpath(rawRoot);
        const name = sanitizeDriveName(item?.name, canonicalRoot, pathImpl);
        const readOnly = item?.readOnly === true;
        state.drives.set(deviceId, {
          deviceId,
          rootPath: rawRoot,
          canonicalRoot,
          name,
          readOnly,
        });
        nextDeviceIds.add(deviceId);
        registered.push({ deviceId, name, path: canonicalRoot, readOnly });
      } catch (err) {
        rejected.push({
          deviceId,
          path: rawRoot,
          reason: err?.message || "Failed to access directory",
        });
      }
    }

    // Close open handles for any drive removed from the session's active drive set.
    for (const [existingDeviceId] of [...state.drives]) {
      if (!nextDeviceIds.has(existingDeviceId)) {
        for (const [fileId, handle] of [...state.handles]) {
          if (handle.deviceId === existingDeviceId) {
            await closeHandleEntry(state, fileId, { allowDeleteOnClose: false });
          }
        }
        state.drives.delete(existingDeviceId);
      }
    }

    return { ok: true, registered, rejected };
  }

  async function cleanupSession(sessionId) {
    if (!sessionId || typeof sessionId !== "string") return { ok: false };
    const state = sessions.get(sessionId);
    if (!state) return { ok: true };
    // Detach synchronously BEFORE awaiting handle closure so a concurrent
    // reconnect registering drives for the same sessionId gets a fresh state
    // that cannot be wiped when this cleanup resumes after fh.close().
    state.closed = true;
    state.resetGeneration = (state.resetGeneration || 0) + 1;
    sessions.delete(sessionId);
    if (Number.isSafeInteger(state.webContentsId)) {
      const set = ownerSessions.get(state.webContentsId);
      set?.delete(sessionId);
      if (set?.size === 0) ownerSessions.delete(state.webContentsId);
    }
    const ids = [...state.handles.keys()];
    for (const fileId of ids) {
      await closeHandleEntry(state, fileId, { allowDeleteOnClose: false });
    }
    return { ok: true };
  }

  async function cleanupOwnerSessions(webContentsId) {
    if (!Number.isSafeInteger(webContentsId)) return { cleaned: 0 };
    const set = ownerSessions.get(webContentsId);
    if (!set || set.size === 0) return { cleaned: 0 };
    const sessionIds = [...set];
    for (const sid of sessionIds) {
      await cleanupSession(sid);
    }
    return { cleaned: sessionIds.length };
  }

  async function cleanupAll() {
    const sessionIds = [...sessions.keys()];
    for (const sid of sessionIds) {
      await cleanupSession(sid);
    }
    ownerSessions.clear();
    return { ok: true };
  }

  // ── IRP Handlers ──

  async function handleCreate(state, drive, req, baseResp) {
    const startResetGen = state.resetGeneration || 0;
    const isCreateStillValid = () => (
      !state.closed
      && (state.resetGeneration || 0) === startResetGen
      && state.drives.get(drive.deviceId) === drive
      && state.handles.size < maxOpenHandles
    );
    if (!isCreateStillValid()) {
      return { ...baseResp, status: NTSTATUS.INSUFFICIENT_RESOURCES };
    }

    const disposition = Number(req.createDisposition);
    if (
      !Number.isInteger(disposition)
      || disposition < CREATE_DISPOSITION.FILE_SUPERSEDE
      || disposition > CREATE_DISPOSITION.FILE_OVERWRITE_IF
    ) {
      return { ...baseResp, status: NTSTATUS.INVALID_PARAMETER };
    }

    const createOptions = (Number(req.createOptions) || 0) >>> 0;
    const desiredAccess = (Number(req.desiredAccess) || 0) >>> 0;
    const isDirReq = (createOptions & CREATE_OPTIONS.FILE_DIRECTORY_FILE) !== 0;
    const isNonDirReq = (createOptions & CREATE_OPTIONS.FILE_NON_DIRECTORY_FILE) !== 0;
    const deleteOnClose = (createOptions & CREATE_OPTIONS.FILE_DELETE_ON_CLOSE) !== 0;

    if (isDirReq && isNonDirReq) {
      return { ...baseResp, status: NTSTATUS.INVALID_PARAMETER };
    }
    if (
      isDirReq
      && disposition !== CREATE_DISPOSITION.FILE_CREATE
      && disposition !== CREATE_DISPOSITION.FILE_OPEN
      && disposition !== CREATE_DISPOSITION.FILE_OPEN_IF
    ) {
      return { ...baseResp, status: NTSTATUS.INVALID_PARAMETER };
    }
    if (deleteOnClose && (desiredAccess & DESIRED_ACCESS.DELETE) === 0) {
      return { ...baseResp, status: NTSTATUS.INVALID_PARAMETER };
    }

    const jailed = await resolveJailedPath(drive.canonicalRoot, req.path, fsPromises, pathImpl);
    if (!jailed.ok) {
      return { ...baseResp, status: jailed.status };
    }

    const truncates =
      disposition === CREATE_DISPOSITION.FILE_SUPERSEDE
      || disposition === CREATE_DISPOSITION.FILE_OVERWRITE
      || disposition === CREATE_DISPOSITION.FILE_OVERWRITE_IF;
    const createsIfMissing =
      disposition === CREATE_DISPOSITION.FILE_CREATE
      || disposition === CREATE_DISPOSITION.FILE_OPEN_IF
      || disposition === CREATE_DISPOSITION.FILE_OVERWRITE_IF
      || disposition === CREATE_DISPOSITION.FILE_SUPERSEDE;

    const explicitWriteAccess =
      (desiredAccess & (
        DESIRED_ACCESS.FILE_WRITE_DATA
        | DESIRED_ACCESS.FILE_APPEND_DATA
        | DESIRED_ACCESS.GENERIC_WRITE
        | DESIRED_ACCESS.DELETE
      )) !== 0;
    const hasMaxAllowed = (desiredAccess & DESIRED_ACCESS.MAXIMUM_ALLOWED) !== 0;
    const hasGenericAll = (desiredAccess & DESIRED_ACCESS.GENERIC_ALL) !== 0;

    // Enforce read-only drive protection strictly.
    if (drive.readOnly) {
      if (
        deleteOnClose
        || truncates
        || disposition === CREATE_DISPOSITION.FILE_CREATE
        || (!jailed.exists && createsIfMissing)
        || (explicitWriteAccess && !hasMaxAllowed)
      ) {
        return { ...baseResp, status: NTSTATUS.MEDIA_WRITE_PROTECTED };
      }
    }

    // Refuse deleting the shared root directory itself.
    if (deleteOnClose && jailed.relPath === "") {
      return { ...baseResp, status: NTSTATUS.ACCESS_DENIED };
    }

    // Case 1: Target already exists and is a directory.
    if (jailed.exists && jailed.stat.isDirectory()) {
      if (isNonDirReq) {
        return { ...baseResp, status: NTSTATUS.FILE_IS_A_DIRECTORY };
      }
      if (
        disposition !== CREATE_DISPOSITION.FILE_OPEN
        && disposition !== CREATE_DISPOSITION.FILE_OPEN_IF
      ) {
        return {
          ...baseResp,
          status: jailed.relPath === "" ? NTSTATUS.ACCESS_DENIED : NTSTATUS.OBJECT_NAME_COLLISION,
        };
      }
      const fileId = allocateFileId(state);
      if (fileId === null) {
        return { ...baseResp, status: NTSTATUS.INSUFFICIENT_RESOURCES };
      }
      state.handles.set(fileId, {
        fileId,
        deviceId: drive.deviceId,
        relPath: jailed.relPath,
        fullPath: jailed.fullPath,
        isDir: true,
        fh: null,
        deleteOnClose,
        mayDelete: !drive.readOnly && (
          (desiredAccess & (DESIRED_ACCESS.DELETE | DESIRED_ACCESS.GENERIC_ALL | DESIRED_ACCESS.MAXIMUM_ALLOWED)) !== 0
        ),
        dirCursor: null,
        readOnlyHandle: true,
      });
      return {
        ...baseResp,
        status: NTSTATUS.SUCCESS,
        fileId,
        information: CREATE_INFORMATION.FILE_OPENED,
      };
    }

    // Case 2: Target exists as regular file, but directory requested.
    if (jailed.exists && isDirReq) {
      return {
        ...baseResp,
        status: disposition === CREATE_DISPOSITION.FILE_CREATE
          ? NTSTATUS.OBJECT_NAME_COLLISION
          : NTSTATUS.NOT_A_DIRECTORY,
      };
    }

    // Case 3: Target does not exist and directory requested.
    if (!jailed.exists && isDirReq) {
      if (disposition === CREATE_DISPOSITION.FILE_OPEN) {
        return { ...baseResp, status: NTSTATUS.OBJECT_NAME_NOT_FOUND };
      }
      // Verify parent exists inside jail.
      const parentDir = pathImpl.dirname(jailed.fullPath);
      try {
        const parentStat = await fsPromises.stat(parentDir);
        if (!parentStat.isDirectory()) {
          return { ...baseResp, status: NTSTATUS.OBJECT_PATH_NOT_FOUND };
        }
      } catch {
        return { ...baseResp, status: NTSTATUS.OBJECT_PATH_NOT_FOUND };
      }
      try {
        await fsPromises.mkdir(jailed.fullPath);
      } catch (err) {
        return { ...baseResp, status: mapErrnoToNtStatus(err) };
      }
      const fileId = allocateFileId(state);
      if (fileId === null) {
        return { ...baseResp, status: NTSTATUS.INSUFFICIENT_RESOURCES };
      }
      state.handles.set(fileId, {
        fileId,
        deviceId: drive.deviceId,
        relPath: jailed.relPath,
        fullPath: jailed.fullPath,
        isDir: true,
        fh: null,
        deleteOnClose,
        mayDelete: !drive.readOnly && (
          (desiredAccess & (DESIRED_ACCESS.DELETE | DESIRED_ACCESS.GENERIC_ALL | DESIRED_ACCESS.MAXIMUM_ALLOWED)) !== 0
        ),
        dirCursor: null,
        readOnlyHandle: true,
      });
      return {
        ...baseResp,
        status: NTSTATUS.SUCCESS,
        fileId,
        information: CREATE_INFORMATION.FILE_CREATED,
      };
    }

    // Case 4: Regular file open / create / overwrite.
    if (!jailed.exists) {
      if (
        disposition === CREATE_DISPOSITION.FILE_OPEN
        || disposition === CREATE_DISPOSITION.FILE_OVERWRITE
      ) {
        return { ...baseResp, status: NTSTATUS.OBJECT_NAME_NOT_FOUND };
      }
      // Confirm parent directory exists.
      const parentDir = pathImpl.dirname(jailed.fullPath);
      try {
        const parentStat = await fsPromises.stat(parentDir);
        if (!parentStat.isDirectory()) {
          return { ...baseResp, status: NTSTATUS.OBJECT_PATH_NOT_FOUND };
        }
      } catch {
        return { ...baseResp, status: NTSTATUS.OBJECT_PATH_NOT_FOUND };
      }
    } else if (disposition === CREATE_DISPOSITION.FILE_CREATE) {
      return { ...baseResp, status: NTSTATUS.OBJECT_NAME_COLLISION };
    }

    const wantsWrite = !drive.readOnly && (
      truncates
      || !jailed.exists
      || explicitWriteAccess
      || hasGenericAll
      || hasMaxAllowed
    );

    let fh = null;
    let openedReadOnly = !wantsWrite;
    try {
      if (!jailed.exists) {
        const openFlags = disposition === CREATE_DISPOSITION.FILE_CREATE
          ? (fsImpl.constants.O_RDWR | fsImpl.constants.O_CREAT | fsImpl.constants.O_EXCL)
          : (fsImpl.constants.O_RDWR | fsImpl.constants.O_CREAT);
        fh = await fsPromises.open(jailed.fullPath, openFlags, 0o666);
        openedReadOnly = false;
      } else if (wantsWrite) {
        try {
          fh = await fsPromises.open(jailed.fullPath, fsImpl.constants.O_RDWR);
          openedReadOnly = false;
        } catch (openErr) {
          // MAXIMUM_ALLOWED falls back to read-only when write permission is denied.
          if ((openErr?.code === "EACCES" || openErr?.code === "EROFS") && hasMaxAllowed && !truncates) {
            fh = await fsPromises.open(jailed.fullPath, fsImpl.constants.O_RDONLY);
            openedReadOnly = true;
          } else {
            throw openErr;
          }
        }
      } else {
        fh = await fsPromises.open(jailed.fullPath, fsImpl.constants.O_RDONLY);
        openedReadOnly = true;
      }

      if (jailed.exists && truncates) {
        await fh.truncate(0);
      }
    } catch (err) {
      if (fh) {
        try { await fh.close(); } catch { /* ignore */ }
      }
      return { ...baseResp, status: mapErrnoToNtStatus(err) };
    }

    if (!isCreateStillValid()) {
      try { await fh.close(); } catch { /* ignore */ }
      return {
        ...baseResp,
        status: state.handles.size >= maxOpenHandles
          ? NTSTATUS.INSUFFICIENT_RESOURCES
          : NTSTATUS.NO_SUCH_FILE,
      };
    }

    const fileId = allocateFileId(state);
    if (fileId === null) {
      try { await fh.close(); } catch { /* ignore */ }
      return { ...baseResp, status: NTSTATUS.INSUFFICIENT_RESOURCES };
    }

    let information = CREATE_INFORMATION.FILE_OPENED;
    if (!jailed.exists) {
      information = CREATE_INFORMATION.FILE_CREATED;
    } else if (disposition === CREATE_DISPOSITION.FILE_SUPERSEDE) {
      information = CREATE_INFORMATION.FILE_SUPERSEDED;
    } else if (
      disposition === CREATE_DISPOSITION.FILE_OVERWRITE
      || disposition === CREATE_DISPOSITION.FILE_OVERWRITE_IF
    ) {
      information = CREATE_INFORMATION.FILE_OVERWRITTEN;
    }

    state.handles.set(fileId, {
      fileId,
      deviceId: drive.deviceId,
      relPath: jailed.relPath,
      fullPath: jailed.fullPath,
      isDir: false,
      fh,
      deleteOnClose,
      mayDelete: !drive.readOnly && (
        (desiredAccess & (DESIRED_ACCESS.DELETE | DESIRED_ACCESS.GENERIC_ALL | DESIRED_ACCESS.MAXIMUM_ALLOWED)) !== 0
      ),
      dirCursor: null,
      readOnlyHandle: openedReadOnly,
    });

    return {
      ...baseResp,
      status: NTSTATUS.SUCCESS,
      fileId,
      information,
    };
  }

  async function handleRead(state, req, baseResp) {
    const handle = state.handles.get(Number(req.fileId));
    if (!handle) {
      return { ...baseResp, status: NTSTATUS.NO_SUCH_FILE };
    }
    if (handle.isDir || !handle.fh) {
      return { ...baseResp, status: NTSTATUS.FILE_IS_A_DIRECTORY };
    }
    const requestedLen = Number(req.length);
    const offset = Number(req.offset) || 0;
    if (!Number.isFinite(requestedLen) || requestedLen < 0 || !Number.isFinite(offset) || offset < 0) {
      return { ...baseResp, status: NTSTATUS.INVALID_PARAMETER };
    }
    const cappedLen = Math.min(Math.trunc(requestedLen), MAX_READ_BYTES);
    if (cappedLen === 0) {
      return { ...baseResp, status: NTSTATUS.SUCCESS, data: new Uint8Array(0) };
    }

    try {
      const buf = Buffer.allocUnsafe(cappedLen);
      const { bytesRead } = await handle.fh.read(buf, 0, cappedLen, Math.trunc(offset));
      const out = new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
      return {
        ...baseResp,
        status: NTSTATUS.SUCCESS,
        data: bytesRead === cappedLen ? out : Uint8Array.from(out),
      };
    } catch (err) {
      return { ...baseResp, status: mapErrnoToNtStatus(err) };
    }
  }

  async function handleWrite(state, drive, req, baseResp) {
    if (drive.readOnly) {
      return { ...baseResp, status: NTSTATUS.MEDIA_WRITE_PROTECTED };
    }
    const handle = state.handles.get(Number(req.fileId));
    if (!handle) {
      return { ...baseResp, status: NTSTATUS.NO_SUCH_FILE };
    }
    if (handle.isDir || !handle.fh) {
      return { ...baseResp, status: NTSTATUS.FILE_IS_A_DIRECTORY };
    }
    if (handle.readOnlyHandle) {
      return { ...baseResp, status: NTSTATUS.ACCESS_DENIED };
    }
    const offset = Number(req.offset) || 0;
    if (!Number.isFinite(offset) || offset < 0) {
      return { ...baseResp, status: NTSTATUS.INVALID_PARAMETER };
    }
    const buf = toBuffer(req.data);
    if (buf.length === 0) {
      return { ...baseResp, status: NTSTATUS.SUCCESS, bytesWritten: 0 };
    }
    try {
      const { bytesWritten } = await handle.fh.write(buf, 0, buf.length, Math.trunc(offset));
      return { ...baseResp, status: NTSTATUS.SUCCESS, bytesWritten };
    } catch (err) {
      return { ...baseResp, status: mapErrnoToNtStatus(err) };
    }
  }

  async function handleQueryDirectory(state, drive, req, baseResp) {
    const handle = state.handles.get(Number(req.fileId));
    const infoClass = Number(req.informationClass) || FILE_INFO_CLASS.BOTH_DIRECTORY;
    if (!handle) {
      return { ...baseResp, informationClass: infoClass, status: NTSTATUS.NO_SUCH_FILE };
    }
    if (
      infoClass !== FILE_INFO_CLASS.DIRECTORY
      && infoClass !== FILE_INFO_CLASS.FULL_DIRECTORY
      && infoClass !== FILE_INFO_CLASS.BOTH_DIRECTORY
      && infoClass !== FILE_INFO_CLASS.NAMES
    ) {
      return { ...baseResp, informationClass: infoClass, status: NTSTATUS.NOT_SUPPORTED };
    }

    if (req.initialQuery) {
      handle.dirCursor = null;
      const rawQuery = typeof req.path === "string" ? req.path : "";
      if (rawQuery.includes("\0") || rawQuery.includes(":")) {
        return { ...baseResp, informationClass: infoClass, status: NTSTATUS.ACCESS_DENIED };
      }

      let dirRawPath = handle.relPath;
      let pattern = "*";
      const trimmed = rawQuery.replace(/\\/g, "/");
      if (trimmed !== "" && trimmed !== "/") {
        const isDriveAbsolute = trimmed.startsWith("/");
        const cleaned = trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
        if (cleaned !== "") {
          const lastSlash = cleaned.lastIndexOf("/");
          if (lastSlash === -1) {
            if (isDriveAbsolute) {
              dirRawPath = "";
              pattern = cleaned;
            } else {
              dirRawPath = handle.relPath;
              pattern = cleaned;
            }
          } else {
            const prefix = cleaned.slice(0, lastSlash);
            pattern = cleaned.slice(lastSlash + 1) || "*";
            dirRawPath = isDriveAbsolute || !handle.relPath
              ? prefix
              : `${handle.relPath}/${prefix}`;
          }
        }
      }

      if (pattern === "..") {
        return { ...baseResp, informationClass: infoClass, status: NTSTATUS.ACCESS_DENIED };
      }

      const jailedDir = await resolveJailedPath(drive.canonicalRoot, dirRawPath, fsPromises, pathImpl);
      if (!jailedDir.ok) {
        return { ...baseResp, informationClass: infoClass, status: jailedDir.status };
      }
      if (!jailedDir.exists) {
        return { ...baseResp, informationClass: infoClass, status: NTSTATUS.NO_SUCH_FILE };
      }
      if (!jailedDir.stat.isDirectory()) {
        return { ...baseResp, informationClass: infoClass, status: NTSTATUS.NOT_A_DIRECTORY };
      }

      let names;
      try {
        names = await fsPromises.readdir(jailedDir.fullPath);
      } catch (err) {
        return { ...baseResp, informationClass: infoClass, status: mapErrnoToNtStatus(err) };
      }

      const entries = [];
      // Non-root directories include '.' and '..' when '.' matches the pattern (MS-FSA 2.1.5.6.3).
      if (jailedDir.relPath !== "" && matchWindowsWildcard(".", pattern)) {
        entries.push(statToEntry(".", jailedDir.stat, drive.readOnly));
        try {
          const parentPath = pathImpl.dirname(jailedDir.fullPath);
          const parentStat = await fsPromises.stat(parentPath);
          entries.push(statToEntry("..", parentStat, drive.readOnly));
        } catch {
          entries.push(statToEntry("..", jailedDir.stat, drive.readOnly));
        }
      }

      names.sort();
      for (const name of names) {
        if (!matchWindowsWildcard(name, pattern)) continue;
        const childFull = pathImpl.join(jailedDir.fullPath, name);
        try {
          const lstat = await fsPromises.lstat(childFull);
          let stat = lstat;
          if (lstat.isSymbolicLink()) {
            const real = await fsPromises.realpath(childFull);
            if (!isPathInsideRoot(drive.canonicalRoot, real, pathImpl)) {
              // Skip symlinks pointing outside the sandbox jail.
              continue;
            }
            stat = await fsPromises.stat(real);
          }
          entries.push(statToEntry(name, stat, drive.readOnly));
        } catch {
          // Entry disappeared or broken symlink; skip cleanly.
        }
      }

      handle.dirCursor = { entries, index: 0 };
      if (entries.length === 0) {
        return { ...baseResp, informationClass: infoClass, status: NTSTATUS.NO_SUCH_FILE };
      }
      const first = entries[0];
      handle.dirCursor.index = 1;
      return {
        ...baseResp,
        informationClass: infoClass,
        status: NTSTATUS.SUCCESS,
        entry: first,
      };
    }

    // Subsequent pagination call (initialQuery === false)
    if (!handle.dirCursor || handle.dirCursor.index >= handle.dirCursor.entries.length) {
      handle.dirCursor = null;
      return { ...baseResp, informationClass: infoClass, status: NTSTATUS.NO_MORE_FILES };
    }
    const nextEntry = handle.dirCursor.entries[handle.dirCursor.index];
    handle.dirCursor.index += 1;
    if (handle.dirCursor.index >= handle.dirCursor.entries.length) {
      handle.dirCursor = null;
    }
    return {
      ...baseResp,
      informationClass: infoClass,
      status: NTSTATUS.SUCCESS,
      entry: nextEntry,
    };
  }

  async function handleQueryInformation(state, drive, req, baseResp) {
    const handle = state.handles.get(Number(req.fileId));
    const infoClass = Number(req.informationClass);
    if (!handle) {
      return { ...baseResp, informationClass: infoClass, status: NTSTATUS.NO_SUCH_FILE };
    }

    let stat;
    try {
      if (handle.fh) {
        stat = await handle.fh.stat();
      } else {
        const jailed = await resolveJailedPath(drive.canonicalRoot, handle.relPath, fsPromises, pathImpl);
        if (!jailed.ok || !jailed.exists) {
          return {
            ...baseResp,
            informationClass: infoClass,
            status: jailed.ok ? NTSTATUS.NO_SUCH_FILE : jailed.status,
          };
        }
        stat = jailed.stat;
      }
    } catch (err) {
      return { ...baseResp, informationClass: infoClass, status: mapErrnoToNtStatus(err) };
    }

    const baseName = handle.relPath ? pathImpl.basename(handle.fullPath) : "";
    const fileAttributes = computeFileAttributes(stat, baseName, drive.readOnly);
    const isDir = stat.isDirectory();
    const size = isDir ? 0 : Math.max(0, Number(stat.size) || 0);

    if (infoClass === FILE_INFO_CLASS.BASIC) {
      const ctimeMs = Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0
        ? stat.birthtimeMs
        : stat.ctimeMs;
      return {
        ...baseResp,
        informationClass: infoClass,
        status: NTSTATUS.SUCCESS,
        basic: {
          creationTime: unixMsToFiletimeString(ctimeMs),
          lastAccessTime: unixMsToFiletimeString(stat.atimeMs),
          lastWriteTime: unixMsToFiletimeString(stat.mtimeMs),
          changeTime: unixMsToFiletimeString(stat.ctimeMs),
          fileAttributes,
        },
      };
    }

    if (infoClass === FILE_INFO_CLASS.STANDARD) {
      return {
        ...baseResp,
        informationClass: infoClass,
        status: NTSTATUS.SUCCESS,
        standard: {
          allocationSize: roundAllocationSize(size, isDir),
          endOfFile: size,
          numberOfLinks: isDir ? 1 : Math.max(1, Number(stat.nlink) || 1),
          deletePending: Boolean(handle.deleteOnClose),
          directory: isDir,
        },
      };
    }

    if (infoClass === FILE_INFO_CLASS.ATTRIBUTE_TAG) {
      return {
        ...baseResp,
        informationClass: infoClass,
        status: NTSTATUS.SUCCESS,
        attributeTag: {
          fileAttributes,
          reparseTag: 0,
        },
      };
    }

    return { ...baseResp, informationClass: infoClass, status: NTSTATUS.NOT_SUPPORTED };
  }

  async function handleQueryVolumeInformation(state, drive, req, baseResp) {
    const handle = state.handles.get(Number(req.fileId));
    const infoClass = Number(req.informationClass);
    if (!handle) {
      return { ...baseResp, informationClass: infoClass, status: NTSTATUS.NO_SUCH_FILE };
    }

    let fsStats = {
      bsize: 4096,
      blocks: 1024 * 1024,
      bfree: 512 * 1024,
      bavail: 512 * 1024,
    };
    if (typeof fsPromises.statfs === "function") {
      try {
        const s = await fsPromises.statfs(drive.canonicalRoot);
        if (s && Number.isFinite(Number(s.bsize)) && Number(s.bsize) > 0) {
          fsStats = {
            bsize: Number(s.bsize),
            blocks: Math.max(0, Number(s.blocks) || 0),
            bfree: Math.max(0, Number(s.bfree) || 0),
            bavail: Math.max(0, Number(s.bavail) || 0),
          };
        }
      } catch {
        // Use clean fallback above
      }
    }

    if (infoClass === FS_INFO_CLASS.VOLUME) {
      let creationTime = unixMsToFiletimeString(Date.now());
      try {
        const rootStat = await fsPromises.stat(drive.canonicalRoot);
        creationTime = unixMsToFiletimeString(
          Number.isFinite(rootStat.birthtimeMs) && rootStat.birthtimeMs > 0
            ? rootStat.birthtimeMs
            : rootStat.ctimeMs,
        );
      } catch {
        // fallback creationTime
      }
      return {
        ...baseResp,
        informationClass: infoClass,
        status: NTSTATUS.SUCCESS,
        volume: {
          creationTime,
          serialNumber: ((drive.deviceId * 2654435761) >>> 0) || 1,
          supportsObjects: false,
          label: drive.name,
        },
      };
    }

    if (infoClass === FS_INFO_CLASS.SIZE) {
      return {
        ...baseResp,
        informationClass: infoClass,
        status: NTSTATUS.SUCCESS,
        size: {
          totalAllocationUnits: fsStats.blocks,
          availableAllocationUnits: fsStats.bavail,
          sectorsPerAllocationUnit: 1,
          bytesPerSector: fsStats.bsize,
        },
      };
    }

    if (infoClass === FS_INFO_CLASS.FULL_SIZE) {
      return {
        ...baseResp,
        informationClass: infoClass,
        status: NTSTATUS.SUCCESS,
        fullSize: {
          totalAllocationUnits: fsStats.blocks,
          callerAvailableAllocationUnits: fsStats.bavail,
          actualAvailableAllocationUnits: fsStats.bfree,
          sectorsPerAllocationUnit: 1,
          bytesPerSector: fsStats.bsize,
        },
      };
    }

    if (infoClass === FS_INFO_CLASS.ATTRIBUTE) {
      const attrs =
        FS_ATTRIBUTES.CASE_SENSITIVE_SEARCH
        | FS_ATTRIBUTES.CASE_PRESERVED_NAMES
        | FS_ATTRIBUTES.UNICODE_ON_DISK
        | (drive.readOnly ? FS_ATTRIBUTES.READ_ONLY_VOLUME : 0);
      return {
        ...baseResp,
        informationClass: infoClass,
        status: NTSTATUS.SUCCESS,
        attribute: {
          attributes: attrs,
          maxComponentNameLen: 255,
          fileSystemName: "NTFS",
        },
      };
    }

    if (infoClass === FS_INFO_CLASS.DEVICE) {
      return {
        ...baseResp,
        informationClass: infoClass,
        status: NTSTATUS.SUCCESS,
        device: {
          deviceType: 0x00000007, // FILE_DEVICE_DISK
          characteristics: 0x00000010 | (drive.readOnly ? 0x00000002 : 0),
        },
      };
    }

    return { ...baseResp, informationClass: infoClass, status: NTSTATUS.NOT_SUPPORTED };
  }

  async function handleSetInformation(state, drive, req, baseResp) {
    if (drive.readOnly) {
      return { ...baseResp, status: NTSTATUS.MEDIA_WRITE_PROTECTED };
    }
    const handle = state.handles.get(Number(req.fileId));
    const infoClass = Number(req.informationClass);
    if (!handle) {
      return { ...baseResp, status: NTSTATUS.NO_SUCH_FILE };
    }

    if (infoClass === FILE_INFO_CLASS.RENAME) {
      if (!handle.mayDelete || handle.relPath === "") {
        return { ...baseResp, status: NTSTATUS.ACCESS_DENIED };
      }
      const targetRaw = req.renameTarget;
      if (typeof targetRaw !== "string" || !targetRaw.trim()) {
        return { ...baseResp, status: NTSTATUS.OBJECT_NAME_INVALID };
      }
      const jailedTarget = await resolveJailedPath(drive.canonicalRoot, targetRaw, fsPromises, pathImpl);
      if (!jailedTarget.ok) {
        return { ...baseResp, status: jailedTarget.status };
      }
      if (jailedTarget.relPath === "") {
        return { ...baseResp, status: NTSTATUS.OBJECT_NAME_INVALID };
      }
      // Verify target parent exists and is a directory inside the jail.
      const targetParent = pathImpl.dirname(jailedTarget.fullPath);
      try {
        const parentStat = await fsPromises.stat(targetParent);
        if (!parentStat.isDirectory()) {
          return { ...baseResp, status: NTSTATUS.OBJECT_PATH_NOT_FOUND };
        }
      } catch {
        return { ...baseResp, status: NTSTATUS.OBJECT_PATH_NOT_FOUND };
      }

      if (jailedTarget.exists && jailedTarget.fullPath !== handle.fullPath) {
        if (!req.replaceIfExists) {
          return { ...baseResp, status: NTSTATUS.OBJECT_NAME_COLLISION };
        }
        if (jailedTarget.stat.isDirectory()) {
          return { ...baseResp, status: NTSTATUS.ACCESS_DENIED };
        }
      }

      try {
        await fsPromises.rename(handle.fullPath, jailedTarget.fullPath);
        const oldRel = handle.relPath;
        const oldPrefix = `${oldRel}/`;
        for (const entry of state.handles.values()) {
          if (entry.deviceId !== drive.deviceId) continue;
          if (entry.relPath === oldRel) {
            entry.relPath = jailedTarget.relPath;
            entry.fullPath = jailedTarget.fullPath;
          } else if (oldRel && entry.relPath.startsWith(oldPrefix)) {
            const suffix = entry.relPath.slice(oldPrefix.length);
            entry.relPath = `${jailedTarget.relPath}/${suffix}`;
            entry.fullPath = pathImpl.resolve(jailedTarget.fullPath, suffix);
          }
        }
        return { ...baseResp, status: NTSTATUS.SUCCESS };
      } catch (err) {
        return { ...baseResp, status: mapErrnoToNtStatus(err) };
      }
    }

    if (infoClass === FILE_INFO_CLASS.DISPOSITION) {
      if (!handle.mayDelete || handle.relPath === "") {
        return { ...baseResp, status: NTSTATUS.ACCESS_DENIED };
      }
      const wantDelete = Boolean(req.deleteOnClose ?? req.deletePending);
      if (wantDelete && handle.isDir) {
        try {
          const children = await fsPromises.readdir(handle.fullPath);
          if (children.length > 0) {
            return { ...baseResp, status: NTSTATUS.DIRECTORY_NOT_EMPTY };
          }
        } catch (err) {
          return { ...baseResp, status: mapErrnoToNtStatus(err) };
        }
      }
      handle.deleteOnClose = wantDelete;
      return { ...baseResp, status: NTSTATUS.SUCCESS };
    }

    if (infoClass === FILE_INFO_CLASS.END_OF_FILE) {
      if (handle.isDir) {
        return { ...baseResp, status: NTSTATUS.FILE_IS_A_DIRECTORY };
      }
      const eofSize = Number(req.eofSize);
      if (!Number.isFinite(eofSize) || eofSize < 0) {
        return { ...baseResp, status: NTSTATUS.INVALID_PARAMETER };
      }
      try {
        if (handle.fh) {
          await handle.fh.truncate(Math.trunc(eofSize));
        } else {
          await fsPromises.truncate(handle.fullPath, Math.trunc(eofSize));
        }
        return { ...baseResp, status: NTSTATUS.SUCCESS };
      } catch (err) {
        return { ...baseResp, status: mapErrnoToNtStatus(err) };
      }
    }

    if (infoClass === FILE_INFO_CLASS.ALLOCATION) {
      return { ...baseResp, status: NTSTATUS.SUCCESS };
    }

    if (infoClass === FILE_INFO_CLASS.BASIC) {
      const atime = filetimeToUnixSeconds(req.lastAccessTime);
      const mtime = filetimeToUnixSeconds(req.lastWriteTime);
      if (atime !== null || mtime !== null) {
        try {
          const stat = handle.fh ? await handle.fh.stat() : await fsPromises.stat(handle.fullPath);
          const nextAtime = atime !== null ? atime : stat.atimeMs / 1000;
          const nextMtime = mtime !== null ? mtime : stat.mtimeMs / 1000;
          if (handle.fh && typeof handle.fh.utimes === "function") {
            await handle.fh.utimes(nextAtime, nextMtime);
          } else {
            await fsPromises.utimes(handle.fullPath, nextAtime, nextMtime);
          }
        } catch (err) {
          return { ...baseResp, status: mapErrnoToNtStatus(err) };
        }
      }
      return { ...baseResp, status: NTSTATUS.SUCCESS };
    }

    return { ...baseResp, status: NTSTATUS.NOT_SUPPORTED };
  }

  async function handleOp(sessionId, request = {}) {
    const op = typeof request?.op === "string" ? request.op : "";
    const deviceId = Number(request?.deviceId) || 0;
    const completionId = Number(request?.completionId) || 0;
    const baseResp = { op, deviceId, completionId };

    if (!sessionId || typeof sessionId !== "string") {
      return { ...baseResp, status: NTSTATUS.INVALID_PARAMETER };
    }

    if (op === "reset") {
      await closeAllHandlesForSession(sessionId, { allowDeleteOnClose: false });
      return { ...baseResp, status: NTSTATUS.SUCCESS };
    }

    const state = sessions.get(sessionId);
    if (!state) {
      return { ...baseResp, status: NTSTATUS.NO_SUCH_FILE };
    }

    const drive = state.drives.get(deviceId);
    if (!drive) {
      if (op === "close") {
        await closeHandleEntry(state, Number(request.fileId), { allowDeleteOnClose: false });
        return { ...baseResp, status: NTSTATUS.SUCCESS };
      }
      return { ...baseResp, status: NTSTATUS.NO_SUCH_FILE };
    }

    switch (op) {
      case "create":
        return handleCreate(state, drive, request, baseResp);
      case "close":
        await closeHandleEntry(state, Number(request.fileId), { allowDeleteOnClose: true });
        return { ...baseResp, status: NTSTATUS.SUCCESS };
      case "read":
        return handleRead(state, request, baseResp);
      case "write":
        return handleWrite(state, drive, request, baseResp);
      case "query_directory":
        return handleQueryDirectory(state, drive, request, baseResp);
      case "query_information":
        return handleQueryInformation(state, drive, request, baseResp);
      case "query_volume_information":
        return handleQueryVolumeInformation(state, drive, request, baseResp);
      case "set_information":
        return handleSetInformation(state, drive, request, baseResp);
      case "flush": {
        const handle = state.handles.get(Number(request.fileId));
        if (!handle) return { ...baseResp, status: NTSTATUS.NO_SUCH_FILE };
        if (handle.fh && !drive.readOnly && typeof handle.fh.datasync === "function") {
          try { await handle.fh.datasync(); } catch { /* ignore */ }
        }
        return { ...baseResp, status: NTSTATUS.SUCCESS };
      }
      case "lock_control": {
        const handle = state.handles.get(Number(request.fileId));
        if (!handle) return { ...baseResp, status: NTSTATUS.NO_SUCH_FILE };
        return { ...baseResp, status: NTSTATUS.SUCCESS };
      }
      case "device_control":
      case "notify_change_directory":
        return { ...baseResp, status: NTSTATUS.NOT_SUPPORTED };
      default:
        return { ...baseResp, status: NTSTATUS.NOT_SUPPORTED };
    }
  }

  function getSessionHandleCount(sessionId) {
    return sessions.get(sessionId)?.handles.size || 0;
  }

  function getSessionDriveCount(sessionId) {
    return sessions.get(sessionId)?.drives.size || 0;
  }

  return {
    registerDrives,
    handleOp,
    cleanupSession,
    cleanupOwnerSessions,
    cleanupAll,
    getSessionHandleCount,
    getSessionDriveCount,
  };
}

// ── Electron Main IPC Registration ──

function mapLocalDisplays(electronModule) {
  const screen = electronModule?.screen;
  if (!screen || typeof screen.getAllDisplays !== "function") {
    return [];
  }
  const all = screen.getAllDisplays() || [];
  const primary = typeof screen.getPrimaryDisplay === "function"
    ? screen.getPrimaryDisplay()
    : null;
  const primaryId = primary?.id ?? null;

  return all.map((display) => {
    const bounds = display?.bounds || {};
    const left = Number.isFinite(bounds.x) ? Math.round(bounds.x) : 0;
    const top = Number.isFinite(bounds.y) ? Math.round(bounds.y) : 0;
    const width = Number.isFinite(bounds.width) ? Math.max(1, Math.round(bounds.width)) : 1920;
    const height = Number.isFinite(bounds.height) ? Math.max(1, Math.round(bounds.height)) : 1080;
    const scaleFactor = Number.isFinite(display?.scaleFactor) && display.scaleFactor > 0
      ? display.scaleFactor
      : 1;
    const isPrimary = primaryId !== null
      ? display.id === primaryId
      : (left === 0 && top === 0);
    return {
      id: display.id,
      left,
      top,
      width,
      height,
      scaleFactor,
      isPrimary,
    };
  });
}

function registerRdpdrHandlers(ipcMain, options = {}) {
  const {
    electronModule,
    fsImpl = fs,
    pathImpl = path,
    maxOpenHandles,
  } = options;

  const bridge = createRemoteDesktopRdpdrBridge({ fsImpl, pathImpl, maxOpenHandles });
  const trackedSenders = new WeakSet();

  const trackSenderLifecycle = (sender) => {
    if (!sender || !Number.isSafeInteger(sender.id) || trackedSenders.has(sender)) return;
    trackedSenders.add(sender);
    const webContentsId = sender.id;
    sender.once?.("destroyed", () => {
      void bridge.cleanupOwnerSessions(webContentsId).catch(() => {});
    });
  };

  ipcMain.handle("netcatty:remote-desktop:rdpdr:pick-folder", async (event) => {
    const dialog = electronModule?.dialog;
    const BrowserWindow = electronModule?.BrowserWindow;
    const ownerWin = BrowserWindow?.fromWebContents?.(event?.sender) || undefined;
    if (!dialog?.showOpenDialog) {
      return { ok: false, canceled: false, error: "Folder picker dialog is unavailable" };
    }
    const result = await dialog.showOpenDialog(ownerWin, {
      title: "Select Local Folder to Share",
      properties: ["openDirectory"],
    });
    if (result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
      return { ok: true, canceled: true };
    }
    const selectedPath = result.filePaths[0];
    return {
      ok: true,
      canceled: false,
      path: selectedPath,
      name: sanitizeDriveName("", selectedPath, pathImpl),
    };
  });

  ipcMain.handle("netcatty:remote-desktop:rdpdr:register-drives", async (event, payload = {}) => {
    trackSenderLifecycle(event?.sender);
    return bridge.registerDrives(payload?.sessionId, payload?.drives, {
      webContentsId: event?.sender?.id ?? null,
    });
  });

  ipcMain.handle("netcatty:remote-desktop:rdpdr:op", async (_event, payload = {}) => (
    bridge.handleOp(payload?.sessionId, payload?.request)
  ));

  ipcMain.handle("netcatty:remote-desktop:rdpdr:cleanup", async (_event, payload = {}) => {
    const sessionId = typeof payload === "string" ? payload : payload?.sessionId;
    return bridge.cleanupSession(sessionId);
  });

  ipcMain.handle("netcatty:remote-desktop:get-local-displays", async () => (
    mapLocalDisplays(electronModule)
  ));

  return {
    bridge,
    cleanupAll: () => bridge.cleanupAll(),
  };
}

module.exports = {
  NTSTATUS,
  CREATE_DISPOSITION,
  CREATE_INFORMATION,
  CREATE_OPTIONS,
  DESIRED_ACCESS,
  FILE_ATTRIBUTES,
  FILE_INFO_CLASS,
  FS_INFO_CLASS,
  FS_ATTRIBUTES,
  MAX_OPEN_HANDLES_PER_SESSION,
  MAX_READ_BYTES,
  unixMsToFiletimeString,
  filetimeToUnixSeconds,
  matchWindowsWildcard,
  isPathInsideRoot,
  parseAndValidateRelativePath,
  resolveJailedPath,
  sanitizeDriveName,
  mapLocalDisplays,
  createRemoteDesktopRdpdrBridge,
  registerRdpdrHandlers,
};
