"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const asar = require("@electron/asar");

const HOST_NATIVE_FILES = [
  "node_modules/@serialport/bindings-cpp/build/Release/bindings.node",
  "node_modules/node-pty/build/Release/pty.node",
  "node_modules/node-pty/build/Release/spawn-helper",
  "node_modules/@vscode/windows-process-tree/build/Release/windows_process_tree.node",
];

const REQUIRED_WINDOWS_NODE_PTY_FILES = [
  "conpty.node",
  "conpty/conpty.dll",
  "conpty/OpenConsole.exe",
];

const OPTIONAL_WINDOWS_NODE_PTY_FILES = [
  "pty.node",
  "conpty_console_list.node",
  "winpty.dll",
  "winpty-agent.exe",
];

function readPeMachine(fileOrBuffer) {
  const bytes = Buffer.isBuffer(fileOrBuffer) ? fileOrBuffer : fs.readFileSync(fileOrBuffer);
  if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return null;
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset > bytes.length - 24) return null;
  if (bytes[peOffset] !== 0x50 || bytes[peOffset + 1] !== 0x45
    || bytes[peOffset + 2] !== 0 || bytes[peOffset + 3] !== 0) return null;
  return bytes.readUInt16LE(peOffset + 4);
}

function isPortableExecutableFile(fileOrBuffer) {
  return readPeMachine(fileOrBuffer) === 0x8664;
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

function assertWindowsNativePayload(root, { asarPath } = {}) {
  const incompatible = listNativeFiles(root)
    .filter((file) => !isPortableExecutableFile(file))
    .map((file) => path.relative(root, file));
  if (asarPath && fs.existsSync(asarPath)) {
    for (const entry of asar.listPackage(asarPath)) {
      if (!entry.endsWith(".node")) continue;
      const relativePath = entry.replace(/^\//, "");
      if (asar.statFile(asarPath, relativePath).unpacked) continue;
      const bytes = asar.extractFile(asarPath, relativePath);
      if (!isPortableExecutableFile(bytes)) {
        incompatible.push(`${asarPath}:${relativePath}`);
      }
    }
  }
  if (incompatible.length > 0) {
    throw new Error(
      `[crossWinNative] Windows payload still contains native modules that are not a Windows x64 PE: ${incompatible.join(", ")}`,
    );
  }
}

function assertSupportedCrossWindowsArch(arch = "x64") {
  if (arch !== "x64") {
    throw new Error(`[crossWinNative] Unsupported cross-packaging Windows architecture: ${String(arch)}`);
  }
}

function installWindowsNodePtyPrebuild(unpackedDir, arch = "x64") {
  assertSupportedCrossWindowsArch(arch);
  const prebuildDir = path.join(unpackedDir, "node_modules/node-pty/prebuilds", `win32-${arch}`);
  const releaseDir = path.join(unpackedDir, "node_modules/node-pty/build/Release");
  const installed = [];

  for (const relativeFile of REQUIRED_WINDOWS_NODE_PTY_FILES) {
    const source = path.join(prebuildDir, relativeFile);
    if (!fs.existsSync(source) || !isPortableExecutableFile(source)) {
      throw new Error(
        `[crossWinNative] Missing or invalid Windows x64 node-pty prebuild artifact: ${relativeFile}`,
      );
    }
    const target = path.join(releaseDir, relativeFile);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    installed.push(`node_modules/node-pty/build/Release/${relativeFile}`);
  }

  for (const relativeFile of OPTIONAL_WINDOWS_NODE_PTY_FILES) {
    const source = path.join(prebuildDir, relativeFile);
    if (!fs.existsSync(source)) continue;
    if (!isPortableExecutableFile(source)) {
      throw new Error(
        `[crossWinNative] Invalid Windows x64 node-pty prebuild artifact: ${relativeFile}`,
      );
    }
    const target = path.join(releaseDir, relativeFile);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    installed.push(`node_modules/node-pty/build/Release/${relativeFile}`);
  }

  return installed;
}

function normalizeBundledWindowsNatives({
  unpackedDir,
  sqlite3WindowsFile,
  windowsProcessTreeFile = null,
  arch = "x64",
}) {
  assertSupportedCrossWindowsArch(arch);
  if (!fs.existsSync(unpackedDir)) {
    throw new Error(`[crossWinNative] Missing unpacked app directory: ${unpackedDir}`);
  }
  const sqlite3Bytes = Buffer.isBuffer(sqlite3WindowsFile)
    ? sqlite3WindowsFile
    : sqlite3WindowsFile
      ? fs.readFileSync(sqlite3WindowsFile)
      : null;
  if (!sqlite3Bytes || !isPortableExecutableFile(sqlite3Bytes)) {
    throw new Error("[crossWinNative] A Windows sqlite3 prebuild is required");
  }
  const windowsProcessTreeBytes = Buffer.isBuffer(windowsProcessTreeFile)
    ? windowsProcessTreeFile
    : windowsProcessTreeFile
      ? fs.readFileSync(windowsProcessTreeFile)
      : null;
  if (windowsProcessTreeFile && (!windowsProcessTreeBytes || !isPortableExecutableFile(windowsProcessTreeBytes))) {
    throw new Error("[crossWinNative] Provided windows-process-tree module is not a Windows x64 PE");
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

  const installedNodePty = installWindowsNodePtyPrebuild(unpackedDir, arch);
  const replacedSet = new Set(installedNodePty);

  const windowsProcessTreeRelative =
    "node_modules/@vscode/windows-process-tree/build/Release/windows_process_tree.node";
  let windowsProcessTreeTarget = null;
  if (windowsProcessTreeBytes) {
    windowsProcessTreeTarget = path.join(unpackedDir, windowsProcessTreeRelative);
    fs.mkdirSync(path.dirname(windowsProcessTreeTarget), { recursive: true });
    fs.writeFileSync(windowsProcessTreeTarget, windowsProcessTreeBytes);
    replacedSet.add(windowsProcessTreeRelative);
  }

  const sqlite3Target = path.join(
    unpackedDir,
    "node_modules/sqlite3/build/Release/node_sqlite3.node",
  );
  fs.mkdirSync(path.dirname(sqlite3Target), { recursive: true });
  fs.writeFileSync(sqlite3Target, sqlite3Bytes);

  const asarEntriesToRemove = removed.filter((entry) => !replacedSet.has(entry));

  assertWindowsNativePayload(unpackedDir);
  return {
    removed,
    installedNodePty,
    asarEntriesToRemove,
    sqlite3Target,
    windowsProcessTreeTarget,
  };
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

function normalizeCrossWindowsApp({
  appOutDir,
  projectDir,
  arch = "x64",
  windowsProcessTreeFile = process.env.NETCATTY_WIN_PROCESS_TREE_NODE || null,
}) {
  assertSupportedCrossWindowsArch(arch);
  const resourcesDir = path.join(appOutDir, "resources");
  const unpackedDir = path.join(resourcesDir, "app.asar.unpacked");
  const asarPath = path.join(resourcesDir, "app.asar");
  const sqlite3WindowsFile = downloadWindowsSqlite3Prebuild(projectDir);
  const result = normalizeBundledWindowsNatives({
    unpackedDir,
    sqlite3WindowsFile,
    windowsProcessTreeFile,
    arch,
  });
  assertWindowsNativePayload(resourcesDir, { asarPath });
  return result;
}

module.exports = {
  HOST_NATIVE_FILES,
  REQUIRED_WINDOWS_NODE_PTY_FILES,
  OPTIONAL_WINDOWS_NODE_PTY_FILES,
  assertWindowsNativePayload,
  downloadWindowsSqlite3Prebuild,
  installWindowsNodePtyPrebuild,
  isPortableExecutableFile,
  normalizeBundledWindowsNatives,
  normalizeCrossWindowsApp,
  readPeMachine,
};
