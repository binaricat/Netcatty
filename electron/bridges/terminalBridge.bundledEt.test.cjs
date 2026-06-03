const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { bundledEtClient } = require("./terminalBridge.cjs");

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-et-"));
}

function writeExecutable(filePath, contents = "#!/bin/sh\nexit 0\n") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  fs.chmodSync(filePath, 0o755);
}

test("bundledEtClient returns null when no binary is present", () => {
  const projectRoot = makeTmp();
  const result = bundledEtClient({
    platform: "linux",
    arch: "x64",
    projectRoot,
    resourcesPath: path.join(projectRoot, "missing-resources"),
  });
  assert.equal(result, null);
});

test("bundledEtClient prefers the packaged Resources path", () => {
  const projectRoot = makeTmp();
  const resourcesPath = makeTmp();
  const packagedBin = path.join(resourcesPath, "et", "et");
  writeExecutable(packagedBin);

  const devBin = path.join(projectRoot, "resources", "et", "linux-x64", "et");
  writeExecutable(devBin);

  const result = bundledEtClient({ platform: "linux", arch: "x64", projectRoot, resourcesPath });
  assert.equal(result, packagedBin);
});

test("bundledEtClient falls back to the project-root dev path", () => {
  const projectRoot = makeTmp();
  const devBin = path.join(projectRoot, "resources", "et", "linux-x64", "et");
  writeExecutable(devBin);

  const result = bundledEtClient({
    platform: "linux",
    arch: "x64",
    projectRoot,
    resourcesPath: path.join(projectRoot, "missing"),
  });
  assert.equal(result, devBin);
});

test("bundledEtClient looks under darwin-universal regardless of arch on macOS", () => {
  const projectRoot = makeTmp();
  const universalBin = path.join(projectRoot, "resources", "et", "darwin-universal", "et");
  writeExecutable(universalBin);

  for (const arch of ["arm64", "x64"]) {
    const result = bundledEtClient({
      platform: "darwin",
      arch,
      projectRoot,
      resourcesPath: path.join(projectRoot, "missing"),
    });
    assert.equal(result, universalBin, `arch=${arch}`);
  }
});

test("bundledEtClient uses .exe basename on win32 (when running on a POSIX host)", { skip: process.platform === "win32" }, () => {
  const projectRoot = makeTmp();
  const winBin = path.join(projectRoot, "resources", "et", "win32-x64", "et.exe");
  writeExecutable(winBin);

  const result = bundledEtClient({
    platform: "win32",
    arch: "x64",
    projectRoot,
    resourcesPath: path.join(projectRoot, "missing"),
  });
  assert.equal(result, winBin);
});
