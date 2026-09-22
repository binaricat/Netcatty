const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { publishLocalFileExclusive } = require("./localFilePublish.cjs");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function stubLink(impl) {
  const original = fs.promises.link;
  fs.promises.link = impl;
  return () => { fs.promises.link = original; };
}

test("publishLocalFileExclusive falls back to copy when hardlink fails with EISDIR", async () => {
  const dir = makeTempDir("netcatty-publish-eisdir-");
  try {
    const source = path.join(dir, "staged");
    const target = path.join(dir, "target");
    fs.writeFileSync(source, "hello hardlink fallback");
    const restore = stubLink(async () => {
      // libuv maps Win32 ERROR_INVALID_FUNCTION on exFAT/FAT32 to EISDIR.
      const error = new Error("EISDIR: illegal operation on a directory, link 'src' -> 'dest'");
      error.code = "EISDIR";
      throw error;
    });
    try {
      const identity = await publishLocalFileExclusive(source, target);
      const stat = fs.lstatSync(target);
      assert.equal(fs.readFileSync(target, "utf8"), "hello hardlink fallback");
      assert.equal(stat.isFile(), true);
      assert.equal(identity.dev, stat.dev);
      assert.equal(identity.ino, stat.ino);
      assert.equal(identity.size, stat.size);
      // The prepared source still exists for the caller to unlink.
      assert.equal(fs.existsSync(source), true);
    } finally {
      restore();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("publishLocalFileExclusive still hardlinks on volumes that support it", async () => {
  const dir = makeTempDir("netcatty-publish-link-");
  try {
    const source = path.join(dir, "staged");
    const target = path.join(dir, "target");
    fs.writeFileSync(source, "hardlinked publish");
    const identity = await publishLocalFileExclusive(source, target);
    const [sourceStat, targetStat] = [fs.lstatSync(source), fs.lstatSync(target)];
    assert.equal(sourceStat.ino, targetStat.ino);
    assert.deepEqual(identity, { dev: targetStat.dev, ino: targetStat.ino, size: targetStat.size });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("publishLocalFileExclusive rethrows unexpected link errors", async () => {
  const dir = makeTempDir("netcatty-publish-eexist-");
  try {
    const source = path.join(dir, "staged");
    const target = path.join(dir, "target");
    fs.writeFileSync(source, "unrelated failure");
    const restore = stubLink(async () => {
      const error = new Error("EEXIST: file already exists");
      error.code = "EEXIST";
      throw error;
    });
    try {
      await assert.rejects(() => publishLocalFileExclusive(source, target), { code: "EEXIST" });
    } finally {
      restore();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
