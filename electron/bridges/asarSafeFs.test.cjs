const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  withNoAsar,
  statLocal,
  openLocal,
  createLocalReadStream,
  openLocalReadStream,
  fastPutLocal,
} = require("./asarSafeFs.cjs");

test("withNoAsar restores the previous flag synchronously, also on throw", () => {
  assert.equal(process.noAsar, undefined);
  const value = withNoAsar(() => process.noAsar);
  assert.equal(value, true);
  assert.equal(process.noAsar, undefined);

  const seen = withNoAsar(() => {
    const inner = process.noAsar;
    assert.equal(inner, true);
    return 42;
  });
  assert.equal(seen, 42);

  assert.throws(() => withNoAsar(() => {
    throw new Error("boom");
  }), /boom/);
  assert.equal(process.noAsar, undefined);
});

test("statLocal and openLocal read real files whose name ends with .asar", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-asar-"));
  try {
    const payload = "real-bytes-not-an-archive";
    const filePath = path.join(dir, "app.asar");
    fs.writeFileSync(filePath, payload);

    const st = await statLocal(filePath);
    assert.equal(st.isFile(), true);
    assert.equal(st.size, payload.length);

    const handle = await openLocal(filePath, "r");
    try {
      const hst = await handle.stat();
      assert.equal(hst.size, payload.length);
      const buf = Buffer.alloc(payload.length);
      await handle.read(buf, 0, payload.length, 0);
      assert.equal(buf.toString(), payload);
    } finally {
      await handle.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("createLocalReadStream streams real .asar-named files and closes its fd", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-asar-"));
  try {
    const payload = "stream-me";
    const filePath = path.join(dir, "real.ASAR");
    fs.writeFileSync(filePath, payload);

    const chunks = [];
    for await (const chunk of createLocalReadStream(filePath)) {
      chunks.push(Buffer.from(chunk));
    }
    assert.equal(Buffer.concat(chunks).toString(), payload);
    assert.equal(process.noAsar, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("openLocalReadStream streams real .asar-named files and closes its fd", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-asar-"));
  try {
    const payload = "open-me-async";
    const filePath = path.join(dir, "app.asar");
    fs.writeFileSync(filePath, payload);

    const chunks = [];
    const stream = await openLocalReadStream(filePath);
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }
    assert.equal(Buffer.concat(chunks).toString(), payload);
    assert.equal(process.noAsar, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("openLocalReadStream opens its fd asynchronously, never via fs.openSync", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-asar-"));
  try {
    const filePath = path.join(dir, "app.asar");
    fs.writeFileSync(filePath, "no-blocking-open");

    const origOpenSync = fs.openSync;
    let openSyncCalled = false;
    fs.openSync = (...args) => {
      openSyncCalled = true;
      return origOpenSync(...args);
    };
    try {
      const chunks = [];
      const stream = await openLocalReadStream(filePath);
      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      assert.equal(Buffer.concat(chunks).toString(), "no-blocking-open");
      assert.equal(openSyncCalled, false);
    } finally {
      fs.openSync = origOpenSync;
    }
    assert.equal(process.noAsar, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("open errors reject asynchronously and never leak the toggle", async () => {
  const missing = path.join(os.tmpdir(), `netcatty-asar-missing-${Date.now()}.asar`);
  await assert.rejects(() => openLocalReadStream(missing), /ENOENT/);
  assert.equal(process.noAsar, undefined);
});

test("createLocalReadStream throws synchronously for missing files without leaking the toggle", () => {
  const missing = path.join(os.tmpdir(), `netcatty-asar-missing-${Date.now()}.asar`);
  assert.throws(() => createLocalReadStream(missing), /ENOENT/);
  assert.equal(process.noAsar, undefined);
});

test("fastPutLocal calls fastPut synchronously with the given args and restores the flag", () => {
  const calls = [];
  const fakeSftp = {
    fastPut(localPath, remotePath, options, callback) {
      calls.push({ localPath, remotePath, options, noAsarDuringCall: process.noAsar });
      callback(null);
    },
  };
  const done = fastPutLocal(fakeSftp, "/tmp/in.asar", "/remote/out", { chunkSize: 1 }, () => {});
  assert.ok(typeof done?.then === "function" || done === undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].localPath, "/tmp/in.asar");
  assert.equal(calls[0].remotePath, "/remote/out");
  assert.deepEqual(calls[0].options, { chunkSize: 1 });
  assert.equal(calls[0].noAsarDuringCall, true);
  assert.equal(process.noAsar, undefined);
});

test("fastPutLocal restores the flag when fastPut throws synchronously", () => {
  const fakeSftp = {
    fastPut() {
      assert.equal(process.noAsar, true);
      throw new Error("channel gone");
    },
  };
  assert.throws(() => fastPutLocal(fakeSftp, "/tmp/in.asar", "/remote/out", {}, () => {}), /channel gone/);
  assert.equal(process.noAsar, undefined);
});
