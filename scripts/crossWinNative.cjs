"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const HOST_NATIVE_FILES = [
  "node_modules/@serialport/bindings-cpp/build/Release/bindings.node",
  "node_modules/node-pty/build/Release/pty.node",
  "node_modules/@vscode/windows-process-tree/build/Release/windows_process_tree.node",
];

function isPortableExecutableFile(file) {
  const fd = fs.openSync(file, "r");
  try {
    const magic = Buffer.alloc(2);
    return fs.readSync(fd, magic, 0, 2, 0) === 2 && magic[0] === 0x4d && magic[1] === 0x5a;
  } finally {
    fs.closeSync(fd);
  }
}

function listNativeFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listNativeFiles(fullPath));
    else if (entry.isFile() && entry.name.endsWith(".node")) files.push(fullPath);
  }
  return files;
}

function assertWindowsNativePayload(unpackedDir) {
  const incompatible = listNativeFiles(unpackedDir)
    .filter((file) => !isPortableExecutableFile(file))
    .map((file) => path.relative(unpackedDir, file));
  if (incompatible.length > 0) {
    throw new Error(
      `[crossWinNative] Windows payload still contains non-PE native modules: ${incompatible.join(", ")}`,
    );
  }
}

function normalizeBundledWindowsNatives({ unpackedDir, sqlite3WindowsFile }) {
  if (!fs.existsSync(unpackedDir)) {
    throw new Error(`[crossWinNative] Missing unpacked app directory: ${unpackedDir}`);
  }
  const sqlite3Bytes = Buffer.isBuffer(sqlite3WindowsFile)
    ? sqlite3WindowsFile
    : sqlite3WindowsFile
      ? fs.readFileSync(sqlite3WindowsFile)
      : null;
  if (!sqlite3Bytes || sqlite3Bytes[0] !== 0x4d || sqlite3Bytes[1] !== 0x5a) {
    throw new Error("[crossWinNative] A Windows sqlite3 prebuild is required");
  }

  const removed = [];
  for (const relativePath of HOST_NATIVE_FILES) {
    const file = path.join(unpackedDir, relativePath);
    if (!fs.existsSync(file)) continue;
    fs.rmSync(file, { force: true });
    removed.push(relativePath);
  }

  const darwinNodePtyDir = path.join(unpackedDir, "node_modules/node-pty/bin");
  if (fs.existsSync(darwinNodePtyDir)) {
    fs.rmSync(darwinNodePtyDir, { recursive: true, force: true });
    removed.push("node_modules/node-pty/bin");
  }

  const sqlite3Target = path.join(
    unpackedDir,
    "node_modules/sqlite3/build/Release/node_sqlite3.node",
  );
  fs.mkdirSync(path.dirname(sqlite3Target), { recursive: true });
  fs.writeFileSync(sqlite3Target, sqlite3Bytes);

  assertWindowsNativePayload(unpackedDir);
  return { removed, sqlite3Target };
}

function downloadWindowsSqlite3Prebuild(projectDir) {
  const sqlitePackageJson = path.join(projectDir, "node_modules/sqlite3/package.json");
  const prebuildInstall = path.join(projectDir, "node_modules/prebuild-install/bin.js");
  if (!fs.existsSync(sqlitePackageJson) || !fs.existsSync(prebuildInstall)) {
    throw new Error("[crossWinNative] sqlite3/prebuild-install is unavailable");
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-win-sqlite3-"));
  try {
    fs.copyFileSync(sqlitePackageJson, path.join(tempDir, "package.json"));
    execFileSync(
      process.execPath,
      [
        prebuildInstall,
        "--runtime",
        "napi",
        "--platform",
        "win32",
        "--arch",
        "x64",
        "--force",
      ],
      {
        cwd: tempDir,
        env: { ...process.env, PREBUILDS_ONLY: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const binary = path.join(tempDir, "build/Release/node_sqlite3.node");
    if (!isPortableExecutableFile(binary)) {
      throw new Error("[crossWinNative] Downloaded sqlite3 binary is not a Windows PE module");
    }
    return fs.readFileSync(binary);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

function normalizeCrossWindowsApp({ appOutDir, projectDir }) {
  const resourcesDir = path.join(appOutDir, "resources");
  const unpackedDir = path.join(resourcesDir, "app.asar.unpacked");
  const sqlite3WindowsFile = downloadWindowsSqlite3Prebuild(projectDir);
  const result = normalizeBundledWindowsNatives({ unpackedDir, sqlite3WindowsFile });
  return {
    ...result,
    asarEntriesToRemove: result.removed,
  };
}

module.exports = {
  HOST_NATIVE_FILES,
  assertWindowsNativePayload,
  downloadWindowsSqlite3Prebuild,
  isPortableExecutableFile,
  normalizeBundledWindowsNatives,
  normalizeCrossWindowsApp,
};
