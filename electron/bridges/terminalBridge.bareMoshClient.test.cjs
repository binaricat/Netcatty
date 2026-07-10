const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");

const {
  addBundledMoshRuntimeEnv,
  resolveBareMoshClient,
} = require("./terminalBridge.cjs");
const { createMoshSessionApi } = require("./terminalBridge/moshSession.cjs");

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mosh-resolve-"));
}

function writeExecutable(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(filePath, 0o755);
}

test("resolveBareMoshClient ignores explicit local mosh-client paths", () => {
  const tmp = makeTmp();
  const p = path.join(tmp, "mosh-client");
  writeExecutable(p);
  assert.equal(resolveBareMoshClient({ moshClientPath: p }, { projectRoot: tmp, resourcesPath: path.join(tmp, "missing") }), null);
});

test("resolveBareMoshClient resolves only the bundled client", () => {
  const tmp = makeTmp();
  const bundled = path.join(tmp, "resources", "mosh", "linux-x64", "mosh-client");
  writeExecutable(bundled);

  assert.equal(
    resolveBareMoshClient({}, {
      platform: "linux",
      arch: "x64",
      projectRoot: tmp,
      resourcesPath: path.join(tmp, "missing"),
    }),
    bundled,
  );
});

test("resolveBareMoshClient rejects relative explicit paths", () => {
  const tmp = makeTmp();
  const got = resolveBareMoshClient({ moshClientPath: "./mosh-client" }, {
    projectRoot: tmp,
    resourcesPath: path.join(tmp, "missing"),
  });
  assert.equal(got, null);
});

test("resolveBareMoshClient ignores a non-executable explicit path", () => {
  const tmp = makeTmp();
  const p = path.join(tmp, "mosh-client");
  fs.writeFileSync(p, "");
  fs.chmodSync(p, 0o644);
  const got = resolveBareMoshClient({ moshClientPath: p }, {
    projectRoot: tmp,
    resourcesPath: path.join(tmp, "missing"),
  });
  assert.equal(got, null);
});

test("resolveBareMoshClient ignores mosh-client on PATH", () => {
  const tmp = makeTmp();
  const p = path.join(tmp, "mosh-client");
  writeExecutable(p);

  assert.equal(resolveBareMoshClient({}, {
    pathOverride: tmp,
    projectRoot: tmp,
    resourcesPath: path.join(tmp, "missing"),
  }), null);
});

test("mosh fallback messages do not point users to the removed Mosh settings field", () => {
  const source = fs.readFileSync(path.join(__dirname, "terminalBridge.cjs"), "utf8");

  assert.equal(source.includes("Settings → Terminal → Mosh"), false);
});

test("mosh runtime does not fall back to system mosh or mosh-client", () => {
  const source = fs.readFileSync(path.join(__dirname, "terminalBridge.cjs"), "utf8");

  assert.equal(source.includes('resolvePosixExecutable("mosh-client"'), false);
  assert.equal(source.includes('findExecutable("mosh-client"'), false);
  assert.equal(source.includes('resolvePosixExecutable("mosh"'), false);
  assert.equal(source.includes('findExecutable("mosh"'), false);
  assert.equal(source.includes("brew install mosh"), false);
});

test("MoshCatty runtime env is a no-op (no DLL bag / terminfo)", () => {
  const env = { Path: "C:\\Windows\\System32", TERM: "xterm-256color" };
  const out = addBundledMoshRuntimeEnv(env, "C:\\app\\mosh-client.exe", { platform: "win32" });
  assert.equal(out, env);
  assert.equal(env.TERMINFO, undefined);
  assert.equal(env.TERMINFO_DIRS, undefined);
  assert.equal(env.Path, "C:\\Windows\\System32");
});

test("mosh UTF-8 decoder preserves fragmented Chinese output", () => {
  const { createMoshUtf8Decoder } = createMoshSessionApi({
    StringDecoder,
    Buffer,
  });
  const decode = createMoshUtf8Decoder();
  const fixture = Buffer.from("mosh: 连接恢复，终端输出正常\n", "utf8");
  const chunks = [
    fixture.subarray(0, 9),
    fixture.subarray(9, 11),
    fixture.subarray(11, 17),
    fixture.subarray(17),
  ];

  const decoded = chunks.map((chunk) => decode(chunk)).join("");

  assert.equal(decoded, "mosh: 连接恢复，终端输出正常\n");
  assert.equal(decoded.includes("\uFFFD"), false);
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

test("Cygwin / terminfo helpers are gone from the mosh session module", () => {
  const source = fs.readFileSync(path.join(__dirname, "terminalBridge", "moshSession.cjs"), "utf8");
  assert.equal(source.includes("toCygwinPath"), false);
  assert.equal(source.includes("findBundledMoshDllDir"), false);
  assert.equal(source.includes("findBundledMoshTerminfoDir"), false);
  assert.equal(source.includes("cygwin1"), false);
});
