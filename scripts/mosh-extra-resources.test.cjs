const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { moshExtraResources } = require("./mosh-extra-resources.cjs");

function makeTmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mosh-resources-"));
  t.after(() => {
    if (process.cwd().startsWith(dir)) process.chdir(os.tmpdir());
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function withCwdAndArch(t, cwd, arch) {
  const oldCwd = process.cwd();
  const oldArch = process.env.npm_config_arch;
  process.chdir(cwd);
  process.env.npm_config_arch = arch;
  t.after(() => {
    process.chdir(oldCwd);
    if (oldArch === undefined) delete process.env.npm_config_arch;
    else process.env.npm_config_arch = oldArch;
  });
}

function writeFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "x");
}

test("moshExtraResources returns concrete Linux arch paths (legacy bundle without terminfo)", (t) => {
  const root = makeTmp(t);
  withCwdAndArch(t, root, "x64");
  writeFile(path.join(root, "resources", "mosh", "linux-x64", "mosh-client"));

  const got = moshExtraResources("linux");
  assert.deepEqual(got, [
    { from: "resources/mosh/linux-x64/", to: "mosh/", filter: ["mosh-client"] },
  ]);
});

test("moshExtraResources packages bundled terminfo on Linux when present", (t) => {
  const root = makeTmp(t);
  withCwdAndArch(t, root, "arm64");
  writeFile(path.join(root, "resources", "mosh", "linux-arm64", "mosh-client"));
  writeFile(path.join(root, "resources", "mosh", "linux-arm64", "terminfo", "x", "xterm-256color"));

  const got = moshExtraResources("linux");
  assert.deepEqual(got, [
    { from: "resources/mosh/linux-arm64/", to: "mosh/", filter: ["mosh-client"] },
    { from: "resources/mosh/linux-arm64/terminfo/", to: "mosh/terminfo/", filter: ["**/*"] },
  ]);
});

test("moshExtraResources packages bundled terminfo on Darwin when present", (t) => {
  const root = makeTmp(t);
  withCwdAndArch(t, root, "x64");
  writeFile(path.join(root, "resources", "mosh", "darwin-universal", "mosh-client"));
  writeFile(path.join(root, "resources", "mosh", "darwin-universal", "terminfo", "x", "xterm-256color"));

  const got = moshExtraResources("darwin");
  assert.deepEqual(got, [
    { from: "resources/mosh/darwin-universal/", to: "mosh/", filter: ["mosh-client"] },
    { from: "resources/mosh/darwin-universal/terminfo/", to: "mosh/terminfo/", filter: ["**/*"] },
  ]);
});

test("moshExtraResources returns concrete Windows arch paths only when that arch exists", (t) => {
  const root = makeTmp(t);
  withCwdAndArch(t, root, "x64");
  writeFile(path.join(root, "resources", "mosh", "win32-x64", "mosh-client.exe"));
  writeFile(path.join(root, "resources", "mosh", "win32-x64", "mosh-client-win32-x64-dlls", "cygwin1.dll"));
  writeFile(path.join(root, "resources", "mosh", "win32-x64", "terminfo", "x", "xterm-256color"));

  const got = moshExtraResources("win32");
  assert.deepEqual(got, [
    { from: "resources/mosh/win32-x64/", to: "mosh/", filter: ["mosh-client.exe"] },
    {
      from: "resources/mosh/win32-x64/mosh-client-win32-x64-dlls/",
      to: "mosh/mosh-client-win32-x64-dlls/",
      filter: ["**/*"],
    },
    { from: "resources/mosh/win32-x64/terminfo/", to: "mosh/terminfo/", filter: ["**/*"] },
  ]);

  process.env.npm_config_arch = "arm64";
  assert.deepEqual(moshExtraResources("win32"), []);
});

test("moshExtraResources keeps legacy Windows bundles packageable", (t) => {
  const root = makeTmp(t);
  withCwdAndArch(t, root, "x64");
  writeFile(path.join(root, "resources", "mosh", "win32-x64", "mosh-client.exe"));
  writeFile(path.join(root, "resources", "mosh", "win32-x64", "mosh-client-win32-x64-dlls", "cygwin1.dll"));

  const got = moshExtraResources("win32");
  assert.deepEqual(got, [
    { from: "resources/mosh/win32-x64/", to: "mosh/", filter: ["mosh-client.exe"] },
    {
      from: "resources/mosh/win32-x64/mosh-client-win32-x64-dlls/",
      to: "mosh/mosh-client-win32-x64-dlls/",
      filter: ["**/*"],
    },
  ]);
});

test("moshExtraResources packages standalone Windows mosh-client.exe", (t) => {
  const root = makeTmp(t);
  withCwdAndArch(t, root, "x64");
  writeFile(path.join(root, "resources", "mosh", "win32-x64", "mosh-client.exe"));

  const got = moshExtraResources("win32");
  assert.deepEqual(got, [
    { from: "resources/mosh/win32-x64/", to: "mosh/", filter: ["mosh-client.exe"] },
  ]);
});
