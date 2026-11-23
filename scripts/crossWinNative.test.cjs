const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const asar = require("@electron/asar");

const {
  assertWindowsNativePayload,
  normalizeBundledWindowsNatives,
} = require("./crossWinNative.cjs");

function writeFixture(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

function peBuffer(machine = 0x8664) {
  const bytes = Buffer.alloc(0xa0);
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write("PE\0\0", 0x80, "binary");
  bytes.writeUInt16LE(machine, 0x84);
  return bytes;
}

test("cross-built Windows payload removes host-native modules and installs Windows sqlite3 and node-pty", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-win-native-"));
  const sqliteSource = path.join(root, "sqlite3-win32-x64.node");
  const unpackedDir = path.join(root, "app.asar.unpacked");

  writeFixture(sqliteSource, peBuffer());
  writeFixture(
    path.join(unpackedDir, "node_modules/@serialport/bindings-cpp/build/Release/bindings.node"),
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  );
  writeFixture(
    path.join(unpackedDir, "node_modules/node-pty/build/Release/pty.node"),
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  );
  writeFixture(
    path.join(unpackedDir, "node_modules/node-pty/build/Release/spawn-helper"),
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  );
  writeFixture(
    path.join(unpackedDir, "node_modules/@vscode/windows-process-tree/build/Release/windows_process_tree.node"),
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  );
  for (const relativeFile of [
    "conpty.node",
    "conpty/conpty.dll",
    "conpty/OpenConsole.exe",
    "pty.node",
    "conpty_console_list.node",
    "winpty.dll",
    "winpty-agent.exe",
  ]) {
    writeFixture(
      path.join(unpackedDir, "node_modules/node-pty/prebuilds/win32-x64", relativeFile),
      peBuffer(),
    );
  }

  const result = normalizeBundledWindowsNatives({ unpackedDir, sqlite3WindowsFile: sqliteSource });

  assert.equal(
    fs.existsSync(path.join(unpackedDir, "node_modules/@serialport/bindings-cpp/build/Release/bindings.node")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(unpackedDir, "node_modules/node-pty/build/Release/spawn-helper")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(unpackedDir, "node_modules/@vscode/windows-process-tree/build/Release/windows_process_tree.node")),
    false,
  );
  for (const relativeFile of [
    "conpty.node",
    "conpty/conpty.dll",
    "conpty/OpenConsole.exe",
    "pty.node",
    "conpty_console_list.node",
    "winpty.dll",
    "winpty-agent.exe",
  ]) {
    const installed = path.join(unpackedDir, "node_modules/node-pty/build/Release", relativeFile);
    assert.equal(fs.existsSync(installed), true, relativeFile);
    assert.equal(fs.readFileSync(installed).subarray(0, 2).toString(), "MZ", relativeFile);
  }
  assert.equal(
    result.asarEntriesToRemove.includes("node_modules/node-pty/build/Release/pty.node"),
    false,
  );
  assert.equal(
    result.asarEntriesToRemove.includes("node_modules/node-pty/build/Release/spawn-helper"),
    true,
  );
  assert.equal(
    fs.readFileSync(path.join(unpackedDir, "node_modules/sqlite3/build/Release/node_sqlite3.node")).subarray(0, 2).toString(),
    "MZ",
  );
});

test("cross-built Windows payload fails closed when required node-pty prebuild files are missing or unsupported arch", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-win-native-missing-pty-"));
  const sqliteSource = path.join(root, "sqlite3-win32-x64.node");
  const unpackedDir = path.join(root, "app.asar.unpacked");
  writeFixture(sqliteSource, peBuffer());
  writeFixture(
    path.join(unpackedDir, "node_modules/node-pty/prebuilds/win32-x64/conpty.node"),
    peBuffer(),
  );

  assert.throws(
    () => normalizeBundledWindowsNatives({ unpackedDir, sqlite3WindowsFile: sqliteSource }),
    /Missing or invalid Windows x64 node-pty prebuild artifact: conpty\/conpty\.dll/,
  );

  assert.throws(
    () => normalizeBundledWindowsNatives({ unpackedDir, sqlite3WindowsFile: sqliteSource, arch: "arm64" }),
    /Unsupported cross-packaging Windows architecture: arm64/,
  );
});

test("cross-built Windows payload installs optional Windows process-tree addon when provided", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-win-native-wpt-"));
  const sqliteSource = path.join(root, "sqlite3-win32-x64.node");
  const wptSource = path.join(root, "windows_process_tree-win32-x64.node");
  const unpackedDir = path.join(root, "app.asar.unpacked");

  writeFixture(sqliteSource, peBuffer());
  writeFixture(wptSource, peBuffer());
  writeFixture(
    path.join(unpackedDir, "node_modules/@vscode/windows-process-tree/build/Release/windows_process_tree.node"),
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  );
  for (const relativeFile of [
    "conpty.node",
    "conpty/conpty.dll",
    "conpty/OpenConsole.exe",
  ]) {
    writeFixture(
      path.join(unpackedDir, "node_modules/node-pty/prebuilds/win32-x64", relativeFile),
      peBuffer(),
    );
  }

  const result = normalizeBundledWindowsNatives({
    unpackedDir,
    sqlite3WindowsFile: sqliteSource,
    windowsProcessTreeFile: wptSource,
  });

  const installedWpt = path.join(
    unpackedDir,
    "node_modules/@vscode/windows-process-tree/build/Release/windows_process_tree.node",
  );
  assert.equal(fs.existsSync(installedWpt), true);
  assert.equal(fs.readFileSync(installedWpt).subarray(0, 2).toString(), "MZ");
  assert.equal(
    result.asarEntriesToRemove.includes(
      "node_modules/@vscode/windows-process-tree/build/Release/windows_process_tree.node",
    ),
    false,
  );
  assert.throws(
    () => normalizeBundledWindowsNatives({
      unpackedDir,
      sqlite3WindowsFile: sqliteSource,
      windowsProcessTreeFile: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
    }),
    /not a Windows x64 PE/,
  );
});

test("cross-built Windows validation rejects fake MZ and wrong-architecture PE modules", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-win-native-invalid-"));
  writeFixture(path.join(root, "fake.node"), Buffer.from("MZnot-a-pe"));
  assert.throws(() => assertWindowsNativePayload(root), /not a Windows x64/);

  const wrongArch = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-win-native-arm64-"));
  writeFixture(path.join(wrongArch, "arm64.node"), peBuffer(0xaa64));
  assert.throws(() => assertWindowsNativePayload(wrongArch), /not a Windows x64/);
});

test("cross-built Windows validation scans native modules packed inside app.asar", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-win-native-asar-"));
  const sourceDir = path.join(root, "source");
  const unpackedDir = path.join(root, "app.asar.unpacked");
  const asarPath = path.join(root, "app.asar");
  writeFixture(
    path.join(sourceDir, "node_modules/host-native/index.node"),
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  );
  fs.mkdirSync(unpackedDir, { recursive: true });
  await asar.createPackage(sourceDir, asarPath);

  assert.throws(
    () => assertWindowsNativePayload(unpackedDir, { asarPath }),
    /not a Windows x64[\s\S]*app\.asar/,
  );
});

test("cross-built Windows validation ignores removed unpacked entries until ASAR pruning", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-win-native-unpacked-"));
  const sourceDir = path.join(root, "source");
  const resourcesDir = path.join(root, "resources");
  const unpackedDir = path.join(resourcesDir, "app.asar.unpacked");
  const asarPath = path.join(resourcesDir, "app.asar");
  const hostNativePath = path.join(
    sourceDir,
    "node_modules/node-pty/build/Release/pty.node",
  );
  writeFixture(hostNativePath, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
  fs.mkdirSync(resourcesDir, { recursive: true });
  await asar.createPackageWithOptions(sourceDir, asarPath, { unpack: "**/*.node" });
  fs.rmSync(path.join(
    unpackedDir,
    "node_modules/node-pty/build/Release/pty.node",
  ));

  assert.doesNotThrow(() => assertWindowsNativePayload(resourcesDir, { asarPath }));
});
