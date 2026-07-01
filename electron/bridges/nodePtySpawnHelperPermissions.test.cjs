const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ensureNodePtySpawnHelperExecutable } = require("./nodePtySpawnHelperPermissions.cjs");

function makeTempPackageRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-node-pty-perms-"));
}

function writeHelper(root, relativePath, mode = 0o644) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(filePath, mode);
  return filePath;
}

test("ensureNodePtySpawnHelperExecutable marks packaged helpers executable", () => {
  const root = makeTempPackageRoot();
  const prebuildHelper = writeHelper(root, "prebuilds/darwin-arm64/spawn-helper");
  const releaseHelper = writeHelper(root, "build/Release/spawn-helper");

  const changed = ensureNodePtySpawnHelperExecutable({
    packageRoot: root,
    platform: "darwin",
    arch: "arm64",
  });

  assert.deepEqual(
    changed.sort(),
    [prebuildHelper, releaseHelper].sort(),
  );
  assert.notEqual(fs.statSync(prebuildHelper).mode & 0o111, 0);
  assert.notEqual(fs.statSync(releaseHelper).mode & 0o111, 0);
});

test("ensureNodePtySpawnHelperExecutable ignores missing helpers", () => {
  const root = makeTempPackageRoot();

  assert.deepEqual(ensureNodePtySpawnHelperExecutable({
    packageRoot: root,
    platform: "darwin",
    arch: "arm64",
  }), []);
});
