"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  EXPECTED_VERSION,
  PATCHES,
  patchXtermSource,
  patchInstalledLigaturesCacheSize,
} = require("./patch-xterm-ligatures-cache-size.cjs");

for (const patch of PATCHES) {
  test(`${patch.file}: applies once and rejects unknown or ambiguous shapes`, () => {
    const first = patchXtermSource(`before;${patch.original}after`, patch);
    assert.equal(first.changed, true);
    assert.equal(first.source, `before;${patch.replacement}after`);
    assert.match(first.source, /\.length\s*\|\|\s*1/);
    assert.deepEqual(patchXtermSource(first.source, patch), { source: first.source, changed: false });
    for (const source of [
      "upstream changed",
      patch.original.repeat(2),
      patch.replacement.repeat(2),
      patch.original + patch.replacement,
    ]) {
      assert.throws(() => patchXtermSource(source, patch), /unexpected ligatures cache-size patch shape/);
    }
  });
}

test("version guard matches the pinned package dependency", () => {
  assert.equal(EXPECTED_VERSION, "0.11.0-beta.292");
  assert.equal(EXPECTED_VERSION, require("../package.json").devDependencies["@xterm/addon-ligatures"]);
});

test("patchInstalledLigaturesCacheSize is idempotent and clears Vite cache on change", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-ligatures-cache-size-"));
  try {
    const pkgDir = path.join(root, "node_modules/@xterm/addon-ligatures");
    fs.mkdirSync(path.join(pkgDir, "lib"), { recursive: true });
    fs.mkdirSync(path.join(pkgDir, "src/fontLigatures"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ version: EXPECTED_VERSION }));
    for (const patch of PATCHES) {
      fs.writeFileSync(path.join(root, patch.file), `prefix;${patch.original};suffix`);
    }
    const viteCache = path.join(root, "node_modules/.vite");
    fs.mkdirSync(viteCache, { recursive: true });

    const first = patchInstalledLigaturesCacheSize(root);
    assert.equal(first.changed, PATCHES.length);
    assert.equal(fs.existsSync(viteCache), false);

    fs.mkdirSync(viteCache, { recursive: true });
    const second = patchInstalledLigaturesCacheSize(root);
    assert.equal(second.changed, 0);
    assert.equal(fs.existsSync(viteCache), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("installed @xterm/addon-ligatures bundles are patched against zero-length cache keys", () => {
  const root = path.resolve(__dirname, "..");
  for (const patch of PATCHES) {
    const content = fs.readFileSync(path.join(root, patch.file), "utf8");
    assert.equal(content.includes(patch.replacement), true, `${patch.file} should include patched sizeCalculation`);
    assert.equal(content.includes(patch.original), false, `${patch.file} should not retain unpatched sizeCalculation`);
  }
});
