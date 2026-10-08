const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const tempDirBridge = require("./tempDirBridge.cjs");

const { publishLocalFileExclusive } = require("./localFilePublish.cjs");

function makeTempDir(prefix) {
  return fs.mkdtempSync(`${tempDirBridge.getTempFilePath(prefix)}-`);
}

function stubLink(impl) {
  const original = fs.promises.link;
  fs.promises.link = impl;
  return () => { fs.promises.link = original; };
}

function stubPromises(method, impl) {
  const original = fs.promises[method];
  fs.promises[method] = impl;
  return () => { fs.promises[method] = original; };
}

// Metadata operations are issued through the owned fs.promises FileHandle,
// not the fs.promises namespace, so the stub installs on open().
function handleStub(method, impl) {
  const original = fs.promises.open;
  fs.promises.open = async (...args) => {
    const handle = await original.apply(fs.promises, args);
    if (typeof handle[method] === "function") {
      handle[method] = impl;
    }
    return handle;
  };
  return () => { fs.promises.open = original; };
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
    assert.deepEqual(identity, {
      dev: targetStat.dev, ino: targetStat.ino, size: targetStat.size, timestampsPreserved: true,
    });
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

test("publishLocalFileExclusive stamps timestamps through the pathname when futimens is refused", async () => {
  const dir = makeTempDir("netcatty-publish-path-utimes-");
  try {
    const source = path.join(dir, "staged");
    const target = path.join(dir, "target");
    fs.writeFileSync(source, "pathname-stamped bytes");
    const when = new Date(1_700_000_000_000);
    fs.utimesSync(source, when, when);
    const linkRestore = stubLink(async () => {
      throw Object.assign(new Error("ENOTSUP: operation not supported, link 'src' -> 'dest'"), { code: "ENOTSUP" });
    });
    // Refuse the owned-handle futimens like a backend that implements
    // utimensat but not futimens; the pathname-based retry must still stamp
    // the published inode.
    const handleRestore = handleStub("utimes", async () => {
      throw Object.assign(new Error("ENOTSUP: operation not supported"), { code: "ENOTSUP" });
    });
    try {
      const identity = await publishLocalFileExclusive(source, target);
      assert.equal(fs.readFileSync(target, "utf8"), "pathname-stamped bytes");
      assert.equal(fs.statSync(target).mtimeMs, when.getTime());
      assert.equal(identity.timestampsPreserved, true);
    } finally {
      linkRestore();
      handleRestore();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("publishLocalFileExclusive reports unstamped timestamps when both stamp paths refuse", async () => {
  const dir = makeTempDir("netcatty-publish-unstamped-");
  try {
    const source = path.join(dir, "staged");
    const target = path.join(dir, "target");
    fs.writeFileSync(source, "unstamped bytes");
    fs.utimesSync(source, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    const linkRestore = stubLink(async () => {
      throw Object.assign(new Error("ENOTSUP: operation not supported, link 'src' -> 'dest'"), { code: "ENOTSUP" });
    });
    const handleRestore = handleStub("utimes", async () => {
      throw Object.assign(new Error("ENOTSUP: operation not supported"), { code: "ENOTSUP" });
    });
    const utimesRestore = stubPromises("utimes", async () => {
      throw Object.assign(new Error("ENOTSUP: operation not supported, utimensat"), { code: "ENOTSUP" });
    });
    try {
      const identity = await publishLocalFileExclusive(source, target);
      assert.equal(fs.readFileSync(target, "utf8"), "unstamped bytes");
      // The transfer still completes, but the caller must not treat the
      // prepared timestamps as applied.
      assert.equal(identity.timestampsPreserved, false);
    } finally {
      linkRestore();
      handleRestore();
      utimesRestore();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
