const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { etExtraResources } = require("./et-extra-resources.cjs");

function makeTmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-et-resources-"));
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

test("etExtraResources returns concrete Linux arch paths", (t) => {
  const root = makeTmp(t);
  withCwdAndArch(t, root, "x64");
  writeFile(path.join(root, "resources", "et", "linux-x64", "et"));

  const got = etExtraResources("linux");
  assert.deepEqual(got, [
    { from: "resources/et/linux-x64/", to: "et/", filter: ["et"] },
  ]);
});

test("etExtraResources returns concrete Linux arm64 paths", (t) => {
  const root = makeTmp(t);
  withCwdAndArch(t, root, "arm64");
  writeFile(path.join(root, "resources", "et", "linux-arm64", "et"));

  const got = etExtraResources("linux");
  assert.deepEqual(got, [
    { from: "resources/et/linux-arm64/", to: "et/", filter: ["et"] },
  ]);
});

test("etExtraResources packages the universal Darwin binary", (t) => {
  const root = makeTmp(t);
  withCwdAndArch(t, root, "x64");
  writeFile(path.join(root, "resources", "et", "darwin-universal", "et"));

  const got = etExtraResources("darwin");
  assert.deepEqual(got, [
    { from: "resources/et/darwin-universal/", to: "et/", filter: ["et"] },
  ]);
});

test("etExtraResources returns concrete Windows arch paths only when that arch exists", (t) => {
  const root = makeTmp(t);
  withCwdAndArch(t, root, "x64");
  writeFile(path.join(root, "resources", "et", "win32-x64", "et.exe"));

  const got = etExtraResources("win32");
  assert.deepEqual(got, [
    { from: "resources/et/win32-x64/", to: "et/", filter: ["et.exe"] },
  ]);

  process.env.npm_config_arch = "arm64";
  assert.deepEqual(etExtraResources("win32"), []);
});

test("etExtraResources packages an optional Windows DLL directory when present", (t) => {
  const root = makeTmp(t);
  withCwdAndArch(t, root, "x64");
  writeFile(path.join(root, "resources", "et", "win32-x64", "et.exe"));
  writeFile(path.join(root, "resources", "et", "win32-x64", "et-win32-x64-dlls", "vcruntime140.dll"));

  const got = etExtraResources("win32");
  assert.deepEqual(got, [
    { from: "resources/et/win32-x64/", to: "et/", filter: ["et.exe"] },
    {
      from: "resources/et/win32-x64/et-win32-x64-dlls/",
      to: "et/et-win32-x64-dlls/",
      filter: ["**/*"],
    },
  ]);
});

test("etExtraResources returns [] when the binary is missing", (t) => {
  const root = makeTmp(t);
  withCwdAndArch(t, root, "x64");
  fs.mkdirSync(path.join(root, "resources", "et"), { recursive: true });

  assert.deepEqual(etExtraResources("linux"), []);
  assert.deepEqual(etExtraResources("darwin"), []);
  assert.deepEqual(etExtraResources("win32"), []);
});
