const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  addBundledMoshDllPath,
  addBundledMoshRuntimeEnv,
  addBundledMoshTerminfoEnv,
  resolveBareMoshClient,
} = require("./terminalBridge.cjs");

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

test("Windows dev mosh-client prepends the bundled DLL directory", () => {
  const tmp = makeTmp();
  const client = path.join(tmp, "resources", "mosh", "win32-x64", "mosh-client.exe");
  const dllDir = path.join(tmp, "resources", "mosh", "win32-x64", "mosh-client-win32-x64-dlls");
  writeExecutable(client);
  fs.mkdirSync(dllDir, { recursive: true });
  fs.writeFileSync(path.join(dllDir, "cygwin1.dll"), "dll");

  const env = { Path: "C:\\Windows\\System32" };
  addBundledMoshDllPath(env, client, { platform: "win32", arch: "x64" });

  assert.equal(env.Path.split(";")[0], dllDir);
});

test("Windows dev mosh-client updates the PATH key used by child process env", () => {
  const tmp = makeTmp();
  const client = path.join(tmp, "resources", "mosh", "win32-x64", "mosh-client.exe");
  const dllDir = path.join(tmp, "resources", "mosh", "win32-x64", "mosh-client-win32-x64-dlls");
  writeExecutable(client);
  fs.mkdirSync(dllDir, { recursive: true });
  fs.writeFileSync(path.join(dllDir, "cygwin1.dll"), "dll");

  const env = {
    Path: "C:\\Windows\\System32",
    PATH: "C:\\Tools",
  };
  addBundledMoshDllPath(env, client, { platform: "win32", arch: "x64" });

  assert.equal(env.PATH.split(";")[0], dllDir);
  assert.equal(Object.prototype.hasOwnProperty.call(env, "Path"), false);
});

test("Linux mosh-client prefers a sibling bundled terminfo dir", () => {
  const tmp = makeTmp();
  const client = path.join(tmp, "resources", "mosh", "linux-x64", "mosh-client");
  const terminfo = path.join(tmp, "resources", "mosh", "linux-x64", "terminfo");
  writeExecutable(client);
  fs.mkdirSync(path.join(terminfo, "x"), { recursive: true });
  fs.writeFileSync(path.join(terminfo, "x", "xterm-256color"), "terminfo");

  const env = {};
  addBundledMoshTerminfoEnv(env, client, { platform: "linux" });

  assert.equal(env.TERMINFO, terminfo);
  const dirs = env.TERMINFO_DIRS.split(":");
  assert.equal(dirs[0], terminfo);
  assert.ok(dirs.includes("/usr/share/terminfo"));
});

test("Linux mosh-client falls back to distro paths when no bundle present", () => {
  const tmp = makeTmp();
  const client = path.join(tmp, "resources", "mosh", "linux-x64", "mosh-client");
  writeExecutable(client);

  const env = {};
  addBundledMoshTerminfoEnv(env, client, { platform: "linux" });

  assert.equal(env.TERMINFO, undefined);
  const dirs = env.TERMINFO_DIRS.split(":");
  assert.ok(dirs.includes("/etc/terminfo"));
  assert.ok(dirs.includes("/lib/terminfo"));
  assert.ok(dirs.includes("/usr/share/terminfo"));
});

test("Linux mosh-client merges caller-supplied TERMINFO_DIRS between bundle and system defaults", () => {
  const tmp = makeTmp();
  const client = path.join(tmp, "resources", "mosh", "linux-x64", "mosh-client");
  const terminfo = path.join(tmp, "resources", "mosh", "linux-x64", "terminfo");
  writeExecutable(client);
  fs.mkdirSync(path.join(terminfo, "x"), { recursive: true });
  fs.writeFileSync(path.join(terminfo, "x", "xterm-256color"), "terminfo");

  const env = { TERMINFO_DIRS: "/home/user/.terminfo" };
  addBundledMoshTerminfoEnv(env, client, { platform: "linux" });

  const dirs = env.TERMINFO_DIRS.split(":");
  assert.equal(dirs[0], terminfo);
  assert.equal(dirs[1], "/home/user/.terminfo");
  assert.ok(dirs.includes("/usr/share/terminfo"));
});

test("Darwin mosh-client uses macOS-aware terminfo search paths", () => {
  const tmp = makeTmp();
  const client = path.join(tmp, "resources", "mosh", "darwin-universal", "mosh-client");
  writeExecutable(client);

  const env = {};
  addBundledMoshTerminfoEnv(env, client, { platform: "darwin" });

  const dirs = env.TERMINFO_DIRS.split(":");
  assert.ok(dirs.includes("/usr/share/terminfo"));
  assert.ok(dirs.includes("/opt/homebrew/share/terminfo"));
});

test("Windows mosh-client points ncurses at bundled terminfo", () => {
  const tmp = makeTmp();
  const client = path.join(tmp, "resources", "mosh", "win32-x64", "mosh-client.exe");
  const terminfo = path.join(tmp, "resources", "mosh", "win32-x64", "terminfo");
  writeExecutable(client);
  fs.mkdirSync(path.join(terminfo, "x"), { recursive: true });
  fs.writeFileSync(path.join(terminfo, "x", "xterm-256color"), "terminfo");

  const env = {};
  addBundledMoshTerminfoEnv(env, client, { platform: "win32" });

  assert.equal(env.TERMINFO, terminfo);
  assert.equal(env.TERMINFO_DIRS, terminfo);
});

test("Windows mosh runtime env includes DLL path and terminfo", () => {
  const tmp = makeTmp();
  const client = path.join(tmp, "resources", "mosh", "win32-x64", "mosh-client.exe");
  const dllDir = path.join(tmp, "resources", "mosh", "win32-x64", "mosh-client-win32-x64-dlls");
  const terminfo = path.join(tmp, "resources", "mosh", "win32-x64", "terminfo");
  writeExecutable(client);
  fs.mkdirSync(dllDir, { recursive: true });
  fs.writeFileSync(path.join(dllDir, "cygwin1.dll"), "dll");
  fs.mkdirSync(path.join(terminfo, "78"), { recursive: true });
  fs.writeFileSync(path.join(terminfo, "78", "xterm-256color"), "terminfo");

  const env = { Path: "C:\\Windows\\System32" };
  addBundledMoshRuntimeEnv(env, client, { platform: "win32", arch: "x64" });

  assert.equal(env.Path.split(";")[0], dllDir);
  assert.equal(env.TERMINFO, terminfo);
  assert.equal(env.TERMINFO_DIRS, terminfo);
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
