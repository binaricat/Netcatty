const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const bridge = require("./mcpServerBridge.cjs");

function readDiscovery(discoveryPath) {
  return JSON.parse(fs.readFileSync(discoveryPath, "utf8"));
}

test("self-heals a deleted discovery file while the TCP host stays alive", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-discovery-test-"));
  const discoveryPath = path.join(dir, "discovery.json");
  t.after(() => {
    bridge.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  bridge.init({ cliDiscoveryFilePath: discoveryPath });

  const port = await bridge.getOrCreateHost();
  assert.ok(Number.isInteger(port) && port > 0);
  assert.ok(fs.existsSync(discoveryPath));
  const original = readDiscovery(discoveryPath);
  assert.equal(original.port, port);
  assert.equal(original.pid, process.pid);
  assert.ok(original.token);

  // Simulate an out-of-band deletion while the host is still listening.
  fs.rmSync(discoveryPath, { force: true });
  assert.ok(!fs.existsSync(discoveryPath));

  // The host reuse path repairs the file immediately from in-memory state.
  const portAgain = await bridge.getOrCreateHost();
  assert.equal(portAgain, port);
  assert.ok(fs.existsSync(discoveryPath));
  const repaired = readDiscovery(discoveryPath);
  assert.equal(repaired.port, port);
  assert.equal(repaired.token, original.token);
  assert.equal(repaired.pid, process.pid);

  // A stale file (wrong port/token) is rewritten too.
  fs.writeFileSync(discoveryPath, JSON.stringify({ port: 1, token: "stale", pid: 999 }));
  bridge.ensureCliDiscoveryFile();
  const fixed = readDiscovery(discoveryPath);
  assert.equal(fixed.port, port);
  assert.equal(fixed.token, original.token);
});

test("ensureCliDiscoveryFile does nothing while the host is down", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-discovery-test-"));
  const discoveryPath = path.join(dir, "discovery.json");
  t.after(() => {
    bridge.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  bridge.init({ cliDiscoveryFilePath: discoveryPath });
  bridge.ensureCliDiscoveryFile();
  assert.ok(!fs.existsSync(discoveryPath));

  const port = await bridge.getOrCreateHost();
  bridge.cleanup();

  // cleanup removes the file and the host is gone; ensure must not revive it.
  bridge.ensureCliDiscoveryFile();
  assert.ok(!fs.existsSync(discoveryPath));

  // A fresh host can still be started after cleanup and rewrites discovery.
  const newPort = await bridge.getOrCreateHost();
  assert.ok(Number.isInteger(newPort) && newPort > 0);
  assert.notEqual(newPort, port);
  assert.equal(readDiscovery(discoveryPath).port, newPort);
});
