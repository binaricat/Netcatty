const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  normalizeBundledWindowsNatives,
} = require("./crossWinNative.cjs");

function writeFixture(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

test("cross-built Windows payload removes host-native modules and keeps Windows-native binaries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-win-native-"));
  const sqliteSource = path.join(root, "sqlite3-win32-x64.node");
  const unpackedDir = path.join(root, "app.asar.unpacked");

  writeFixture(sqliteSource, Buffer.from("MZsqlite3-windows"));
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
    Buffer.from("MZnode-pty-windows"),
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
    fs.readFileSync(path.join(unpackedDir, "node_modules/sqlite3/build/Release/node_sqlite3.node"), "utf8"),
    "MZsqlite3-windows",
  );
});
