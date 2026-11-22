"use strict";

const path = require("node:path");
const { assertSafeRemotePath, shellQuotePath } = require("./scpShell.cjs");

const CREATE_ARCHIVE_OPEN_TIMEOUT_MS = 15_000;
const CREATE_ARCHIVE_RUN_TIMEOUT_MS = 30 * 60_000;
const CREATE_ARCHIVE_MAX_OUTPUT_BYTES = 64 * 1024;
const ARCHIVE_RESULT_OK = "NETCATTY_ARCHIVE_RESULT:OK";
const ARCHIVE_RESULT_EXISTS = "NETCATTY_ARCHIVE_RESULT:EEXIST";

function validateArchiveCreateOptions(options) {
  if (!options || typeof options !== "object") throw new Error("Archive options are required");
  const directory = assertSafeRemotePath(options.directory);
  if (!path.posix.isAbsolute(directory) || directory.includes("\\")) throw new Error("Archive directory must be an absolute POSIX path");
  const archiveName = assertSafeRemotePath(options.archiveName);
  if (archiveName === "." || archiveName === ".." || /[/\\]/.test(archiveName)) {
    throw new Error("Archive name must be a file name without a directory");
  }
  if (options.format !== "tar.gz" && options.format !== "zip") {
    throw new Error("Unsupported archive format");
  }
  if (!archiveName.toLowerCase().endsWith(`.${options.format}`) || archiveName.length <= options.format.length + 1) {
    throw new Error(`Archive name must end with .${options.format}`);
  }
  if (options.overwrite !== undefined && typeof options.overwrite !== "boolean") {
    throw new Error("Archive overwrite must be a boolean");
  }
  if (!Array.isArray(options.paths) || options.paths.length === 0 || options.paths.length > 1000) {
    throw new Error("Choose between 1 and 1000 items to archive");
  }
  const paths = [...new Set(options.paths.map((entry) => {
    const value = assertSafeRemotePath(entry);
    if (path.posix.isAbsolute(value) || value.includes("\\") || value.split("/").some((part) => part === "..")) {
      throw new Error("Archive source must stay inside the current directory");
    }
    const normalized = path.posix.normalize(value).replace(/\/$/, "");
    if (!normalized || normalized === ".") throw new Error("Cannot archive the current directory itself");
    if (normalized === archiveName || normalized.startsWith(`${archiveName}/`)) {
      throw new Error("Archive output cannot be one of the selected sources");
    }
    return normalized;
  }))];
  // Selecting a folder already includes its descendants.
  const roots = paths.filter((entry) => !paths.some((parent) => entry.startsWith(`${parent}/`)));
  return { directory, archiveName, format: options.format, overwrite: options.overwrite === true, paths: roots };
}

/**
 * Build a POSIX command that creates one archive without transferring its bytes.
 * A private sibling directory keeps partial data out of the final name. Passing
 * the fixed directory `.` to ln/mv publishes exactly basename(stage), even if
 * that name concurrently becomes a directory or a symlink to a directory.
 */
function buildCreateArchiveCommand(options, { encoding = "utf-8" } = {}) {
  const { directory, archiveName, format, overwrite, paths } = validateArchiveCreateOptions(options);
  const quote = (value) => shellQuotePath(value, encoding);
  const sourceArgs = paths.map((entry) => quote(`./${entry}`)).join(" ");
  const parentPaths = [...new Set(paths.flatMap((entry) => {
    const parts = entry.split("/");
    return parts.slice(0, -1).map((_part, index) => `./${parts.slice(0, index + 1).join("/")}`);
  }))];
  const lines = [
    "set -e",
    "umask 077",
    `cd ${quote(directory)}`,
    `name=${quote(archiveName)}`,
    'out="./$name"',
    "check_target() {",
    '  if [ -L "$out" ] || { [ -e "$out" ] && [ ! -f "$out" ]; }; then',
    "    echo 'Archive target must be a regular file, not a directory or symbolic link' >&2",
    "    exit 1",
    "  fi",
    // Case-insensitive filesystems and hard links can alias a selected source
    // even when the input and output names are different strings.
    ...paths.map((entry) => `  if [ -e "$out" ] && [ "$out" -ef ${quote(`./${entry}`)} ]; then echo 'Archive output refers to a selected source' >&2; exit 1; fi`),
    ...(overwrite ? [] : [
      '  if [ -e "$out" ]; then',
      `    printf '%s\n' '${ARCHIVE_RESULT_EXISTS}'`,
      "    exit 0",
      "  fi",
    ]),
    "}",
    "check_target",
    // An intermediate symlink can resolve a tree selection outside directory,
    // including back into the directory holding the newly written archive.
    ...parentPaths.map((entry) => `if [ -L ${quote(entry)} ]; then echo 'Archive source traverses a symbolic link' >&2; exit 1; fi`),
    ...paths.map((entry) => `if [ ! -e ${quote(`./${entry}`)} ] && [ ! -L ${quote(`./${entry}`)} ]; then echo 'Archive source no longer exists' >&2; exit 1; fi`),
    `command -v ${format === "zip" ? "zip" : "tar"} >/dev/null 2>&1 || { echo '${format === "zip" ? "zip" : "tar"} is not installed on the remote host' >&2; exit 127; }`,
    'stage=$(mktemp -d "./.netcatty-archive.XXXXXXXXXX")',
    'trap \'rm -rf -- "$stage"\' EXIT',
    "trap 'exit 1' HUP INT TERM",
    format === "zip"
      ? `zip -q -r -y -nw -MM "$stage/$name" -- ${sourceArgs} >/dev/null`
      : `tar -czf "$stage/$name" -- ${sourceArgs} >/dev/null`,
    "check_target",
    ...(overwrite ? [
      'mv -f -- "$stage/$name" .',
    ] : [
      'if ! ln -- "$stage/$name" .; then',
      // ln is an atomic no-replace operation. A concurrent regular-file
      // publication is a conflict, never permission to overwrite that file.
      '  if [ -f "$out" ] && [ ! -L "$out" ]; then',
      `    printf '%s\n' '${ARCHIVE_RESULT_EXISTS}'`,
      "    exit 0",
      "  fi",
      "  echo 'Could not publish archive without replacing an existing target' >&2",
      "  exit 1",
      "fi",
    ]),
    `printf '%s\n' '${ARCHIVE_RESULT_OK}'`,
  ];
  const command = lines.join("\n");
  if (Buffer.byteLength(command) > 256 * 1024) throw new Error("Archive selection is too large");
  return command;
}

function parseCreateArchiveResult(stdout) {
  const marker = String(stdout || "").trim().split(/\r?\n/).at(-1);
  if (marker === ARCHIVE_RESULT_OK) return { success: true };
  if (marker === ARCHIVE_RESULT_EXISTS) {
    return { success: false, code: "EEXIST", error: "An archive with this name already exists" };
  }
  throw new Error("Remote host did not confirm that the archive was created");
}

module.exports = {
  CREATE_ARCHIVE_OPEN_TIMEOUT_MS,
  CREATE_ARCHIVE_RUN_TIMEOUT_MS,
  CREATE_ARCHIVE_MAX_OUTPUT_BYTES,
  validateArchiveCreateOptions,
  buildCreateArchiveCommand,
  parseCreateArchiveResult,
};
