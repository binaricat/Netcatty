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

test("cross-built Windows payload removes host-native modules and keeps Windows-native binaries", () => {
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
    path.join(unpackedDir, "node_modules/@vscode/windows-process-tree/build/Release/windows_process_tree.node"),
    Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  );
  writeFixture(
    path.join(unpackedDir, "node_modules/node-pty/prebuilds/win32-x64/pty.node"),
    peBuffer(),
  );

  normalizeBundledWindowsNatives({ unpackedDir, sqlite3WindowsFile: sqliteSource });

  assert.equal(
    fs.existsSync(path.join(unpackedDir, "node_modules/@serialport/bindings-cpp/build/Release/bindings.node")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(unpackedDir, "node_modules/node-pty/build/Release/pty.node")),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(unpackedDir, "node_modules/@vscode/windows-process-tree/build/Release/windows_process_tree.node")),
    false,
  );
  assert.equal(
    fs.readFileSync(path.join(unpackedDir, "node_modules/sqlite3/build/Release/node_sqlite3.node")).subarray(0, 2).toString(),
    "MZ",
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
