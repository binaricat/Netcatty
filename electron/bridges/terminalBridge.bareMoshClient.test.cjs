const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveBareMoshClient } = require("./terminalBridge.cjs");

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mosh-resolve-"));
}

function writeExecutable(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(filePath, 0o755);
}

test("resolveBareMoshClient honors an explicit path with a mosh-client basename", () => {
  const tmp = makeTmp();
  const p = path.join(tmp, "mosh-client");
  writeExecutable(p);
  assert.equal(resolveBareMoshClient({ moshClientPath: p }), p);
});

test("resolveBareMoshClient ignores an explicit path whose basename is `mosh` (the wrapper)", () => {
  const tmp = makeTmp();
  const p = path.join(tmp, "mosh");
  writeExecutable(p);
  // No bundled mosh available in this test (no resources/mosh/<x>/),
  // so the fallback is undefined → null/undefined return.
  const got = resolveBareMoshClient({ moshClientPath: p });
  assert.notEqual(got, p, "explicit `mosh` wrapper path should not be treated as a bare client");
});

test("resolveBareMoshClient rejects relative explicit paths", () => {
  const got = resolveBareMoshClient({ moshClientPath: "./mosh-client" });
  assert.notEqual(got, "./mosh-client");
});

test("resolveBareMoshClient ignores a non-executable explicit path", () => {
  const tmp = makeTmp();
  const p = path.join(tmp, "mosh-client");
  fs.writeFileSync(p, "");
  fs.chmodSync(p, 0o644);
  const got = resolveBareMoshClient({ moshClientPath: p });
  assert.notEqual(got, p);
});

test("resolveBareMoshClient honors caller PATH overrides", () => {
  const tmp = makeTmp();
  const p = path.join(tmp, "mosh-client");
  writeExecutable(p);

  assert.equal(resolveBareMoshClient({}, { pathOverride: tmp }), p);
});

test("mosh fallback messages do not point users to the removed Mosh settings field", () => {
  const source = fs.readFileSync(path.join(__dirname, "terminalBridge.cjs"), "utf8");

  assert.equal(source.includes("Settings → Terminal → Mosh"), false);
});

test("removed Mosh client detection APIs are not exposed to the renderer", () => {
  const bridgeSource = fs.readFileSync(path.join(__dirname, "terminalBridge.cjs"), "utf8");
  const preloadSource = fs.readFileSync(path.join(__dirname, "..", "preload.cjs"), "utf8");
  const globalTypes = fs.readFileSync(path.join(__dirname, "..", "..", "global.d.ts"), "utf8");

  for (const source of [bridgeSource, preloadSource, globalTypes]) {
    assert.equal(source.includes("detectMoshClient"), false);
    assert.equal(source.includes("pickMoshClient"), false);
    assert.equal(source.includes("netcatty:mosh:detectClient"), false);
    assert.equal(source.includes("netcatty:mosh:pickClient"), false);
  }
});
