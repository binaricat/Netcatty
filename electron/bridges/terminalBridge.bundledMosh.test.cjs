const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { bundledMoshClient } = require("./terminalBridge.cjs");

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-mosh-"));
}

function writeExecutable(filePath, contents = "#!/bin/sh\nexit 0\n") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
  fs.chmodSync(filePath, 0o755);
}

test("bundledMoshClient returns null when no binary is present", () => {
  const projectRoot = makeTmp();
  const result = bundledMoshClient({
    platform: "linux",
    arch: "x64",
    projectRoot,
    resourcesPath: path.join(projectRoot, "missing-resources"),
  });
  assert.equal(result, null);
});

test("bundledMoshClient prefers the packaged Resources path", () => {
  const projectRoot = makeTmp();
  const resourcesPath = makeTmp();
  const packagedBin = path.join(resourcesPath, "mosh", "mosh-client");
  writeExecutable(packagedBin);

  const devBin = path.join(projectRoot, "resources", "mosh", "linux-x64", "mosh-client");
  writeExecutable(devBin);

  const result = bundledMoshClient({ platform: "linux", arch: "x64", projectRoot, resourcesPath });
  assert.equal(result, packagedBin);
});

test("bundledMoshClient falls back to the project-root dev path", () => {
  const projectRoot = makeTmp();
  const devBin = path.join(projectRoot, "resources", "mosh", "linux-x64", "mosh-client");
  writeExecutable(devBin);

  const result = bundledMoshClient({
    platform: "linux",
    arch: "x64",
    projectRoot,
    resourcesPath: path.join(projectRoot, "missing"),
  });
  assert.equal(result, devBin);
});

test("bundledMoshClient looks under darwin-universal regardless of arch on macOS", () => {
  const projectRoot = makeTmp();
  const universalBin = path.join(projectRoot, "resources", "mosh", "darwin-universal", "mosh-client");
  writeExecutable(universalBin);

  for (const arch of ["arm64", "x64"]) {
    const result = bundledMoshClient({
      platform: "darwin",
      arch,
      projectRoot,
      resourcesPath: path.join(projectRoot, "missing"),
    });
    assert.equal(result, universalBin, `arch=${arch}`);
  }
});

test("bundledMoshClient uses .exe basename on win32 (when running on a POSIX host)", { skip: process.platform === "win32" }, () => {
  const projectRoot = makeTmp();
  const winBin = path.join(projectRoot, "resources", "mosh", "win32-x64", "mosh-client.exe");
  writeExecutable(winBin);

  const result = bundledMoshClient({
    platform: "win32",
    arch: "x64",
    projectRoot,
    resourcesPath: path.join(projectRoot, "missing"),
  });
  assert.equal(result, winBin);
});

test("bundledMoshClient ignores non-executable matches", () => {
  const projectRoot = makeTmp();
  const candidate = path.join(projectRoot, "resources", "mosh", "linux-x64", "mosh-client");
  fs.mkdirSync(path.dirname(candidate), { recursive: true });
  fs.writeFileSync(candidate, "");
  fs.chmodSync(candidate, 0o644);

  const result = bundledMoshClient({
    platform: "linux",
    arch: "x64",
    projectRoot,
    resourcesPath: path.join(projectRoot, "missing"),
  });
  assert.equal(result, null);
});
