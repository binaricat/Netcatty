/**
 * Shell quoting + remote browse/manage command builders for SCP-mode sessions.
 * Pure helpers — no SSH I/O. Commands are designed for POSIX / BusyBox shells.
 */

"use strict";

class ScpShellError extends Error {
  constructor(message, code = "SCP_SHELL_ERROR") {
    super(message);
    this.name = "ScpShellError";
    this.code = code;
  }
}

/**
 * Single-quote a remote path/argument for POSIX sh.
 * Rejects NUL and rejects empty strings for path ops (callers may allow empty for flags).
 */
function shellQuote(value, { allowEmpty = false } = {}) {
  if (value == null) {
    throw new ScpShellError("Shell argument is required");
  }
  const str = String(value);
  if (str.includes("\0")) {
    throw new ScpShellError("Shell argument must not contain NUL");
  }
  if (!allowEmpty && str.length === 0) {
    throw new ScpShellError("Shell argument must not be empty");
  }
  // ' -> '\''  (end quote, escaped quote, re-open)
  return `'${str.replace(/'/g, `'\\''`)}'`;
}

/**
 * Validate a remote path used in shell commands.
 * Blocks obvious injection patterns beyond quoting (newlines).
 */
function assertSafeRemotePath(remotePath) {
  if (typeof remotePath !== "string" || !remotePath) {
    throw new ScpShellError("Remote path is required");
  }
  if (remotePath.includes("\0") || /[\r\n]/.test(remotePath)) {
    throw new ScpShellError("Remote path must not contain NUL or newlines");
  }
  return remotePath;
}

/**
 * Build `scp -t` sink command (upload to remote directory parent).
 * Destination is the directory that will receive the file named in the C line.
 */
function buildScpSinkCommand(remoteDir, encoding = "utf-8") {
  const dir = assertSafeRemotePath(remoteDir || ".");
  return `scp -t -- ${shellQuotePath(dir, encoding)}`;
}

/**
 * Build `scp -f` source command (download from remote path).
 */
function buildScpSourceCommand(remotePath, encoding = "utf-8") {
  const p = assertSafeRemotePath(remotePath);
  return `scp -f -- ${shellQuotePath(p, encoding)}`;
}

/**
 * Portable directory listing that emits one record per line:
 *   T|MODE|SIZE|MTIME|B64NAME
 * where T is f/d/l (file/dir/link), MODE is octal perms, MTIME unix seconds,
 * B64NAME is base64 of the basename (handles spaces/unicode safely).
 *
 * Uses a POSIX-oriented shell loop; avoids GNU-only find -printf.
 */
function buildListCommand(remotePath, encoding = "utf-8") {
  const p = assertSafeRemotePath(remotePath);
  const q = shellQuotePath(p, encoding);
  // Join the for-loop body with newlines so we never emit invalid `do;` (`;`
  // after `do` is a syntax error on POSIX sh and would force the ls -la fallback).
  const loop = [
    "for f in * .[!.]* ..?*; do",
    // Include broken symlinks: -e is false for dangling links, but -L is true.
    '  { [ -e "$f" ] || [ -L "$f" ]; } || continue',
    '  [ "$f" = "." ] && continue',
    '  [ "$f" = ".." ] && continue',
    '  if [ -L "$f" ]; then t=l',
    '  elif [ -d "$f" ]; then t=d',
    '  else t=f; fi',
    '  lsline=$(ls -ld -- "$f" 2>/dev/null)',
    '  mode=$(printf "%s\\n" "$lsline" | awk \'{print $1}\')',
    '  owner=$(printf "%s\\n" "$lsline" | awk \'{print $3}\')',
    // Use metadata only — never open the file (FIFOs/special files would hang on wc -c).
    '  size=$(stat -c %s -- "$f" 2>/dev/null || stat -f %z -- "$f" 2>/dev/null || echo 0)',
    '  [ -z "$size" ] && size=0',
    '  mtime=$(date -r "$f" +%s 2>/dev/null || stat -c %Y -- "$f" 2>/dev/null || stat -f %m -- "$f" 2>/dev/null || echo 0)',
    // basename base64: prefer base64 -w0 (GNU), fallback base64, then od
    // Prefer `base64` when present; otherwise openssl. Avoid `cmd | tr || fallback`
    // because a missing base64 still lets tr succeed with empty input.
    '  if command -v base64 >/dev/null 2>&1; then b64=$(printf "%s" "$f" | base64 2>/dev/null | tr -d "\\r\\n")',
    '  elif command -v openssl >/dev/null 2>&1; then b64=$(printf "%s" "$f" | openssl base64 2>/dev/null | tr -d "\\r\\n")',
    '  else b64=; fi',
    '  printf "%s|%s|%s|%s|%s|%s\\n" "$t" "${mode:-?}" "$size" "$mtime" "$b64" "${owner:-}"',
    "done",
  ].join("\n");
  return `cd ${q} || exit 1; ${loop}`;
}

/**
 * Simpler listing using `ls -la` as a fallback parse path (for tests / remotes
 * where the loop above is too heavy). Primary runtime still prefers buildListCommand.
 */
function buildListCommandLs(remotePath, encoding = "utf-8") {
  const p = assertSafeRemotePath(remotePath);
  const q = shellQuotePath(p, encoding);
  return `LC_ALL=C ls -la -- ${q} 2>/dev/null || LC_ALL=C ls -la ${q}`;
}

function buildStatCommand(remotePath, encoding = "utf-8") {
  const p = assertSafeRemotePath(remotePath);
  const q = shellQuotePath(p, encoding);
  // Emit: T|MODE_OCT|SIZE|MTIME|ABS|INO
  // INO is optional identity for staged-upload race checks (SFTP v3 has none).
  return [
    `p=${q}`,
    'if [ ! -e "$p" ] && [ ! -L "$p" ]; then echo "ENOENT" >&2; exit 2; fi',
    'if [ -L "$p" ]; then t=l',
    'elif [ -d "$p" ]; then t=d',
    'else t=f; fi',
    'mode=$(ls -ld -- "$p" 2>/dev/null | awk \'{print $1}\')',
    'size=$(stat -c %s -- "$p" 2>/dev/null || stat -f %z -- "$p" 2>/dev/null || echo 0)',
    'mtime=$(date -r "$p" +%s 2>/dev/null || stat -c %Y -- "$p" 2>/dev/null || stat -f %m -- "$p" 2>/dev/null || echo 0)',
    'abs=$(cd "$(dirname -- "$p")" 2>/dev/null && printf "%s/%s\\n" "$(pwd -P 2>/dev/null || pwd)" "$(basename -- "$p")" || printf "%s\\n" "$p")',
    'ino=$(stat -c %i -- "$p" 2>/dev/null || stat -f %i -- "$p" 2>/dev/null || echo)',
    'printf "%s|%s|%s|%s|%s|%s\\n" "$t" "${mode:-?}" "${size:-0}" "${mtime:-0}" "$abs" "${ino}"',
  ].join("; ");
}

function buildMkdirCommand(remotePath, { recursive = true, encoding = "utf-8" } = {}) {
  const p = assertSafeRemotePath(remotePath);
  const q = shellQuotePath(p, encoding);
  return recursive
    ? `mkdir -p -- ${q}`
    : `mkdir -- ${q}`;
}

function buildDeleteCommand(remotePath, { recursive = false, encoding = "utf-8" } = {}) {
  const p = assertSafeRemotePath(remotePath);
  const q = shellQuotePath(p, encoding);
  if (recursive) {
    return `rm -rf -- ${q}`;
  }
  return `rm -f -- ${q} 2>/dev/null || rmdir -- ${q}`;
}

function buildUnlinkCommand(remotePath, encoding = "utf-8") {
  const p = assertSafeRemotePath(remotePath);
  const q = shellQuotePath(p, encoding);
  return `rm -f -- ${q}`;
}

function buildRenameCommand(oldPath, newPath, encoding = "utf-8") {
  const a = shellQuotePath(assertSafeRemotePath(oldPath), encoding);
  const b = shellQuotePath(assertSafeRemotePath(newPath), encoding);
  return `mv -- ${a} ${b}`;
}

function buildChmodCommand(remotePath, modeOctal, encoding = "utf-8") {
  const p = assertSafeRemotePath(remotePath);
  const mode = String(modeOctal);
  if (!/^[0-7]{3,4}$/.test(mode)) {
    throw new ScpShellError(`Invalid chmod mode: ${mode}`);
  }
  // Mode is validated digits-only; path is shell-quoted.
  return `chmod ${mode} -- ${shellQuotePath(p, encoding)}`;
}

function buildHomeCommand() {
  return 'printf "%s\\n" "$HOME"';
}

function buildRealpathCommand(remotePath, encoding = "utf-8") {
  const p = assertSafeRemotePath(remotePath);
  const q = shellQuotePath(p, encoding);
  return (
    `realpath -- ${q} 2>/dev/null || ` +
    `readlink -f -- ${q} 2>/dev/null || ` +
    `(cd ${q} 2>/dev/null && pwd -P) || ` +
    `(cd "$(dirname -- ${q})" 2>/dev/null && printf "%s/%s\\n" "$(pwd -P 2>/dev/null || pwd)" "$(basename -- ${q})")`
  );
}

/**
 * Decode a base64-encoded remote basename using the session filename encoding.
 * @param {string} b64
 * @param {string} [encoding] utf-8 | gb18030 | auto
 */
function decodeListBasename(b64, encoding = "utf-8") {
  const raw = Buffer.from(b64, "base64");
  const enc = String(encoding || "utf-8").toLowerCase();
  if (enc === "gb18030" || enc === "gbk" || enc === "gb2312") {
    try {
      // eslint-disable-next-line global-require
      const iconv = require("iconv-lite");
      return iconv.decode(raw, "gb18030");
    } catch {
      return raw.toString("utf8");
    }
  }
  return raw.toString("utf8");
}

/**
 * Quote a remote path for shell, encoding non-UTF-8 path bytes when needed.
 * For gb18030 hosts the remote filesystem expects gb18030 bytes, not UTF-8.
 */
function shellQuotePath(remotePath, encoding = "utf-8") {
  assertSafeRemotePath(remotePath);
  const enc = String(encoding || "utf-8").toLowerCase();
  if (enc === "gb18030" || enc === "gbk" || enc === "gb2312") {
    // eslint-disable-next-line global-require
    const iconv = require("iconv-lite");
    const b64 = iconv.encode(remotePath, "gb18030").toString("base64");
    // Expand base64 to raw bytes on the remote. Prefer base64, then openssl
    // (same fallback used when listing names on minimal NAS hosts).
    return `"$(printf '%s' '${b64}' | base64 -d 2>/dev/null || printf '%s' '${b64}' | base64 -D 2>/dev/null || printf '%s' '${b64}' | openssl base64 -d 2>/dev/null || printf '%s' '${b64}' | openssl enc -base64 -d 2>/dev/null)"`;
  }
  return shellQuote(remotePath);
}

/**
 * Parse a username from an SFTP longname / `ls -l` line.
 * Example: "-rwxr-xr-x  1 root  root  4096 Jan 1 00:00 filename"
 */
function ownerFromSftpLongname(longname) {
  if (!longname) return undefined;
  const match = String(longname).match(/^[dlbcps\-][rwxsStT\-]{9}[+.@]?\s+\d+\s+(\S+)\s+\S+\s+/);
  const owner = match?.[1]?.trim();
  return owner || undefined;
}

function ownerFromUid(uid) {
  if (typeof uid !== "number" || !Number.isFinite(uid)) return undefined;
  return String(uid);
}

function normalizeListingOwner(value) {
  if (typeof value !== "string") return undefined;
  const owner = value.trim();
  if (!owner || owner === "?" || owner === "UNKNOWN") return undefined;
  return owner;
}

function resolveListingOwner({ owner, longname, uid } = {}) {
  return normalizeListingOwner(owner)
    || ownerFromSftpLongname(longname)
    || ownerFromUid(uid);
}

/**
 * Parse records from buildListCommand output.
 * @returns {Array<{ name: string, type: 'file'|'directory'|'symlink', size: number, modifyTime: number, permissions?: string, owner?: string }>}
 */
function parseListRecords(stdout, encoding = "utf-8") {
  const lines = String(stdout || "").split(/\r?\n/).filter(Boolean);
  const results = [];
  for (const line of lines) {
    const parts = line.split("|");
    if (parts.length < 5) continue;
    const [t, modeStr, sizeStr, mtimeStr, b64, ownerRaw] = parts;
    let name;
    try {
      name = decodeListBasename(b64, encoding);
    } catch {
      continue;
    }
    if (!name || name === "." || name === "..") continue;
    const type = t === "d" ? "directory" : t === "l" ? "symlink" : "file";
    const size = Number(sizeStr) || 0;
    const modifyTime = (Number(mtimeStr) || 0) * 1000;
    const permissions = parseLsModeToPermissions(modeStr);
    const owner = resolveListingOwner({ owner: ownerRaw });
    results.push({ name, type, size, modifyTime, permissions, ...(owner ? { owner } : {}) });
  }
  return results;
}

/**
 * Parse classic `ls -la` output as a fallback.
 */
function parseLsLaOutput(stdout, { basePath = "" } = {}) {
  const lines = String(stdout || "").split(/\r?\n/);
  const results = [];
  for (const line of lines) {
    if (!line || line.startsWith("total ")) continue;
    // permissions links owner group size month day time/year name
    const match = line.match(
      /^([dlbcps\-])([rwxsStT\-]{9})[+.@]?\s+\d+\s+(\S+)\s+\S+\s+(\d+)\s+(\S+\s+\S+\s+\S+)\s+(.+)$/,
    );
    if (!match) continue;
    const typeChar = match[1];
    const perm = match[2];
    const owner = resolveListingOwner({ owner: match[3] });
    const size = Number(match[4]) || 0;
    let name = match[6];
    // strip " -> target" only for symlink rows (backslash filenames may contain " -> ")
    if (typeChar === "l") {
      const arrow = name.indexOf(" -> ");
      if (arrow >= 0) name = name.slice(0, arrow);
    }
    name = name.trim();
    if (!name || name === "." || name === "..") continue;
    // when listing a directory, ls -la path shows path prefix sometimes — use basename
    if (name.includes("/") && basePath) {
      const base = name.endsWith("/") ? name.slice(0, -1) : name;
      const idx = base.lastIndexOf("/");
      if (idx >= 0) name = base.slice(idx + 1);
    }
    const type = typeChar === "d" ? "directory" : typeChar === "l" ? "symlink" : "file";
    results.push({
      name,
      type,
      size,
      modifyTime: Date.now(),
      permissions: perm,
      ...(owner ? { owner } : {}),
    });
  }
  return results;
}

function parseStatRecord(stdout) {
  const line = String(stdout || "").trim().split(/\r?\n/)[0] || "";
  if (!line || line === "ENOENT") {
    const err = new ScpShellError("No such file", "ENOENT");
    err.code = "ENOENT";
    throw err;
  }
  const parts = line.split("|");
  if (parts.length < 5) {
    throw new ScpShellError(`Malformed stat record: ${line.slice(0, 80)}`);
  }
  const [t, modeStr, sizeStr, mtimeStr, abs, inoStr] = parts;
  const ino = inoStr && /^\d+$/.test(String(inoStr).trim())
    ? String(inoStr).trim()
    : undefined;
  return {
    type: t === "d" ? "directory" : t === "l" ? "symlink" : "file",
    isDirectory: t === "d",
    isSymbolicLink: t === "l",
    size: Number(sizeStr) || 0,
    modifyTime: (Number(mtimeStr) || 0) * 1000,
    mode: lsModeToNumber(modeStr),
    permissions: parseLsModeToPermissions(modeStr),
    path: abs,
    ...(ino ? { ino } : {}),
  };
}

function parseLsModeToPermissions(modeStr) {
  if (!modeStr || modeStr === "?") return undefined;
  // -rwxr-xr-x or drwxr-xr-x → rwxr-xr-x
  if (modeStr.length >= 10) return modeStr.slice(1, 10);
  if (modeStr.length === 9) return modeStr;
  return undefined;
}

function lsModeToNumber(modeStr) {
  const perm = parseLsModeToPermissions(modeStr);
  if (!perm || perm.length < 9) return 0;
  const bit = (ch, w, r, x) => {
    if (ch === "r") return r;
    if (ch === "w") return w;
    // lowercase s/t include execute; uppercase S/T are special-bit-only
    if (ch === "x" || ch === "s" || ch === "t") return x;
    return 0;
  };
  let mode = 0;
  mode |= bit(perm[0], 0, 0o400, 0);
  mode |= bit(perm[1], 0o200, 0, 0);
  mode |= bit(perm[2], 0, 0, 0o100);
  mode |= bit(perm[3], 0, 0o040, 0);
  mode |= bit(perm[4], 0o020, 0, 0);
  mode |= bit(perm[5], 0, 0, 0o010);
  mode |= bit(perm[6], 0, 0o004, 0);
  mode |= bit(perm[7], 0o002, 0, 0);
  mode |= bit(perm[8], 0, 0, 0o001);
  // Special bits: setuid / setgid / sticky (s/S in user/group exec, t/T in other)
  if (perm[2] === "s" || perm[2] === "S") mode |= 0o4000;
  if (perm[5] === "s" || perm[5] === "S") mode |= 0o2000;
  if (perm[8] === "t" || perm[8] === "T") mode |= 0o1000;
  return mode;
}

function modeToPermissionsString(mode) {
  if (typeof mode !== "number") return undefined;
  const toTriplet = (bits) =>
    `${bits & 4 ? "r" : "-"}${bits & 2 ? "w" : "-"}${bits & 1 ? "x" : "-"}`;
  return `${toTriplet((mode >> 6) & 7)}${toTriplet((mode >> 3) & 7)}${toTriplet(mode & 7)}`;
}

/**
 * Normalize file protocol preference from host/open options.
 * @returns {'auto'|'sftp'|'scp'}
 */
function normalizeFileProtocol(value) {
  const v = String(value || "auto").toLowerCase().trim();
  if (v === "sftp" || v === "scp") return v;
  return "auto";
}

function isScpModeClient(client) {
  return !!(client && client.__netcattyFileProtocol === "scp");
}

module.exports = {
  ScpShellError,
  shellQuote,
  assertSafeRemotePath,
  buildScpSinkCommand,
  buildScpSourceCommand,
  buildListCommand,
  buildListCommandLs,
  buildStatCommand,
  buildMkdirCommand,
  buildDeleteCommand,
  buildUnlinkCommand,
  buildRenameCommand,
  buildChmodCommand,
  buildHomeCommand,
  buildRealpathCommand,
  parseListRecords,
  parseLsLaOutput,
  ownerFromSftpLongname,
  ownerFromUid,
  resolveListingOwner,
  parseStatRecord,
  parseLsModeToPermissions,
  lsModeToNumber,
  modeToPermissionsString,
  decodeListBasename,
  shellQuotePath,
  normalizeFileProtocol,
  isScpModeClient,
};
