"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  _waitForApplicationSpawnForTests: waitForApplicationSpawn,
  _launchFileWithApplicationForTests: launchFileWithApplication,
} = require("./registerBridges.cjs");

test("application launch acknowledgement rejects an asynchronous spawn failure", async () => {
  const child = new EventEmitter();
  const waiting = waitForApplicationSpawn(child);
  const error = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
  process.nextTick(() => child.emit("error", error));
  await assert.rejects(waiting, { code: "ENOENT" });
  assert.equal(child.listenerCount("spawn"), 0);
});

test("application launch acknowledgement resolves only after spawn", async () => {
  const child = new EventEmitter();
  const waiting = waitForApplicationSpawn(child);
  process.nextTick(() => child.emit("spawn"));
  await waiting;
  assert.equal(child.listenerCount("spawn"), 0);
});

test("macOS launcher acknowledgement rejects a nonzero open command exit", async () => {
  const child = new EventEmitter();
  const waiting = waitForApplicationSpawn(child, true);
  process.nextTick(() => {
    child.emit("spawn");
    child.emit("close", 1);
  });
  await assert.rejects(waiting, /launcher exited with code 1/i);
});

function createFakeChild() {
  const child = new EventEmitter();
  const stderr = new EventEmitter();
  stderr.destroyed = false;
  stderr.destroy = () => {
    stderr.destroyed = true;
  };
  child.stderr = stderr;
  child.unreffed = false;
  child.unref = () => {
    child.unreffed = true;
  };
  return child;
}

test("launchFileWithApplication pipes stderr only for macOS open launcher and ignores stdio on Linux/Windows", async () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    const calls = [];
    const child = createFakeChild();
    if (platform !== "darwin") {
      child.stderr = null;
    }
    const spawnImpl = (cmd, args, options) => {
      calls.push({ cmd, args, options });
      process.nextTick(() => {
        child.emit("spawn");
        if (platform === "darwin") child.emit("close", 0);
      });
      return child;
    };

    const ok = await launchFileWithApplication({
      filePath: "/tmp/file.txt",
      appPath: "/Applications/Editor.app",
      platform,
      spawnImpl,
    });

    assert.equal(ok, true);
    assert.equal(calls.length, 1);
    if (platform === "darwin") {
      assert.deepEqual(calls[0].options, {
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
      assert.equal(child.stderr.destroyed, true, "stderr destroyed on darwin");
    } else {
      assert.deepEqual(calls[0].options, {
        detached: true,
        stdio: "ignore",
      });
    }
    assert.equal(child.unreffed, true, `child unreffed on ${platform}`);
  }
});

test("launchFileWithApplication rejects on ENOENT and destroys stderr when macOS open exits non-zero", async () => {
  // 1) Asynchronous ENOENT failure on Linux (stdio: "ignore", stderr is null)
  const linuxChild = createFakeChild();
  linuxChild.stderr = null;
  await assert.rejects(
    launchFileWithApplication({
      filePath: "/tmp/file.txt",
      appPath: "/no/such/editor",
      platform: "linux",
      spawnImpl: () => {
        process.nextTick(() => {
          linuxChild.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
        });
        return linuxChild;
      },
    }),
    { code: "ENOENT" },
  );
  assert.equal(linuxChild.unreffed, false);

  // 2) macOS open -a nonzero exit still rejects and destroys stderr
  const macChild = createFakeChild();
  await assert.rejects(
    launchFileWithApplication({
      filePath: "/tmp/file.txt",
      appPath: "/Applications/Missing.app",
      platform: "darwin",
      spawnImpl: () => {
        process.nextTick(() => {
          macChild.emit("spawn");
          macChild.stderr.emit("data", Buffer.from("Unable to find application"));
          macChild.emit("close", 1);
        });
        return macChild;
      },
    }),
    /launcher exited with code 1/i,
  );
  assert.equal(macChild.stderr.destroyed, true);
  assert.equal(macChild.unreffed, false);
});
