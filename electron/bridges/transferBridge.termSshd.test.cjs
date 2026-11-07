"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const transferBridge = require("./transferBridge.cjs");
const tempDirBridge = require("./tempDirBridge.cjs");

async function downloadFromSequentialPeer(t, { corruptVerification = false, closeFailure = null, closeTimeout = false } = {}) {
  const payload = crypto.randomBytes(3 * 32768 + 17);
  const rewritten = Buffer.from(payload);
  rewritten[40000] ^= 0xff;
  const target = tempDirBridge.getTempFilePath(`term-sshd-${crypto.randomUUID()}.bin`);
  const transferId = crypto.randomUUID();
  const staged = tempDirBridge.getTransferTempFilePath(transferId, path.basename(target));
  t.after(async () => {
    await fs.rm(target, { force: true });
    await fs.rm(staged, { force: true });
  });
  const cursors = new Map();
  let opens = 0;
  let reads = 0;
  let active = 0;
  let maxActive = 0;
  let ended = 0;
  const sftp = new EventEmitter();
  Object.assign(sftp, {
    _client: { _remoteVer: "TERM-SSHD" },
    readdir(_p, callback) { callback(null, []); },
    stat(_p, callback) { callback(null, { size: payload.length, mtime: 1 }); },
    mkdir(_p, callback) { callback(null); },
    unlink(_p, callback) { callback(null); },
    open(_p, _flags, callback) {
      if (cursors.size) return callback(new Error("General failure: one open handle per channel"));
      const handle = Buffer.from(String(++opens));
      cursors.set(handle, 0);
      callback(null, handle);
    },
    read(handle, buffer, offset, length, _position, callback) {
      // Reproduce TERM-SSHD: READ position is ignored; each handle advances.
      const cursor = cursors.get(handle);
      const source = corruptVerification && Number(handle.toString()) >= 2 ? rewritten : payload;
      const count = Math.min(length, source.length - cursor);
      source.copy(buffer, offset, cursor, cursor + count);
      cursors.set(handle, cursor + count);
      reads += count;
      maxActive = Math.max(maxActive, ++active);
      setImmediate(() => { active--; callback(null, count); });
    },
    close(handle, callback) {
      if ((closeFailure === "verification" && opens >= 2) || (closeFailure === "body" && opens === 1)) {
        if (closeTimeout) return;
        return callback(new Error("General failure"));
      }
      cursors.delete(handle); callback(null);
    },
    end() { ended++; },
  });
  const client = {
    sftp, __netcattySingleChannelSsh: true,
    stat: async () => ({ size: payload.length, mtime: 1 }),
    client: { _remoteVer: "TERM-SSHD", sftp() { throw new Error("No terminal subsystem reuse"); } },
  };
  transferBridge.init({ sftpClients: new Map([["sequential", client]]) });
  const result = await transferBridge.startTransfer({ sender: { send() {} } }, {
    transferId, sourcePath: "/source.bin", targetPath: target,
    sourceType: "sftp", targetType: "local", sourceSftpId: "sequential",
    totalBytes: payload.length, resumable: true,
  });
  return { result, target, payload, opens, reads, maxActive, client, sftp, ended };
}

test("TERM-SSHD download reopens and verifies the complete file without seeking", async (t) => {
  const actual = await downloadFromSequentialPeer(t);
  assert.equal(actual.result.error, undefined);
  assert.deepEqual(await fs.readFile(actual.target), actual.payload);
  assert.ok(actual.opens >= 2, "verification must use a fresh handle");
  assert.ok(actual.reads >= 2 * actual.payload.length, "verify the full file, not just samples");
  assert.equal(actual.maxActive, 1);
});

test("TERM-SSHD full verification rejects changed bytes and never publishes the destination", async (t) => {
  const actual = await downloadFromSequentialPeer(t, { corruptVerification: true });
  assert.match(actual.result.error || "", /source.*changed/i);
  await assert.rejects(fs.stat(actual.target), { code: "ENOENT" });
});

for (const closeFailure of ["body", "verification"]) {
  for (const closeTimeout of [false, true]) {
    test(`TERM-SSHD ${closeFailure} CLOSE ${closeTimeout ? "timeout" : "failure"} discards the shared channel without publication`, async (t) => {
      const actual = await downloadFromSequentialPeer(t, { closeFailure, closeTimeout });
      assert.match(actual.result.error || "", new RegExp(`${closeFailure} handle could not be closed`));
      await assert.rejects(fs.stat(actual.target), { code: "ENOENT" });
      assert.equal(actual.client.sftp, null, "the wedged channel must not remain cached");
      assert.ok(actual.ended > 0, "dispose the uncertain remote handle with its channel");
      await assert.rejects(require("./sftpBridge.cjs").requireSftpChannel(actual.client), /Please reconnect/);
    });
  }
}

for (const corrupt of [false, true]) {
  test(`TERM-SSHD uploads verify remote content before promotion (corrupt=${corrupt})`, async (t) => {
    const payload = crypto.randomBytes(3 * 32768 + 17);
    const source = tempDirBridge.getTempFilePath(`term-upload-${crypto.randomUUID()}.bin`);
    await fs.writeFile(source, payload);
    t.after(() => fs.rm(source, { force: true }));
    const files = new Map();
    const handles = new Map();
    const target = `/target-${crypto.randomUUID()}.bin`;
    const sftp = new EventEmitter();
    const missing = () => Object.assign(new Error("ENOENT"), { code: 2 });
    const stats = (p) => {
      const data = files.get(String(p));
      if (!data) throw missing();
      return { size: data.length, mode: 0o100644, mtime: 1, isDirectory: () => false, isSymbolicLink: () => false };
    };
    Object.assign(sftp, {
      _client: { _remoteVer: "TERM-SSHD" },
      readdir(_p, cb) { cb(null, []); }, mkdir(_p, cb) { cb(null); },
      stat(p, cb) { try { cb(null, stats(p)); } catch (err) { cb(err); } },
      lstat(p, cb) { try { cb(null, stats(p)); } catch (err) { cb(err); } },
      unlink(p, cb) { files.delete(String(p)); cb(null); },
      chmod(_p, _mode, cb) { cb(null); },
      open(p, flags, cb) {
        const name = String(p);
        if (flags === "w") files.set(name, Buffer.alloc(payload.length));
        const handle = Buffer.from(crypto.randomUUID());
        handles.set(handle, { name, cursor: 0 }); cb(null, handle);
      },
      write(handle, buffer, offset, length, _position, cb) {
        const h = handles.get(handle);
        const data = files.get(h.name);
        buffer.copy(data, h.cursor, offset, offset + length);
        if (corrupt && h.cursor <= 40000 && h.cursor + length > 40000) data[40000] ^= 0xff;
        h.cursor += length; setImmediate(() => cb(null));
      },
      read(handle, buffer, offset, length, _position, cb) {
        const h = handles.get(handle); const data = files.get(h.name);
        const count = Math.min(length, data.length - h.cursor);
        data.copy(buffer, offset, h.cursor, h.cursor + count); h.cursor += count;
        setImmediate(() => cb(null, count));
      },
      close(handle, cb) { handles.delete(handle); cb(null); },
      end() {},
    });
    const client = {
      sftp, __netcattySingleChannelSsh: true,
      stat: async (p) => stats(p),
      rename: async (from, to) => { files.set(String(to), files.get(String(from))); files.delete(String(from)); },
      delete: async (p) => { files.delete(String(p)); },
      client: { _remoteVer: "TERM-SSHD", sftp() { throw new Error("No terminal subsystem reuse"); } },
    };
    transferBridge.init({ sftpClients: new Map([["sequential", client]]) });
    const result = await transferBridge.startTransfer({ sender: { send() {} } }, {
      transferId: crypto.randomUUID(), sourcePath: source, targetPath: target,
      sourceType: "local", targetType: "sftp", targetSftpId: "sequential",
      totalBytes: payload.length, resumable: true,
    });
    if (corrupt) {
      assert.match(result.error || "", /content verification failed/i);
      assert.equal(files.has(target), false, "corrupt stage must never be promoted");
    } else {
      assert.equal(result.error, undefined);
      assert.deepEqual(files.get(target), payload);
    }
  });
}

async function createSequentialTransferFixture(t) {
  const payload = crypto.randomBytes(3 * 32768 + 17);
  const files = new Map([["/source.bin", payload]]);
  const handles = new Map();
  const paths = [];
  const staged = [];
  let rejectedOpens = 0;
  let opens = 0;
  const missing = () => Object.assign(new Error("ENOENT"), { code: 2 });
  const stats = (p) => {
    const data = files.get(String(p));
    if (!data) throw missing();
    return { size: data.length, mode: 0o100644, mtime: 1, isDirectory: () => false, isSymbolicLink: () => false };
  };
  const sftp = new EventEmitter();
  Object.assign(sftp, {
    _client: { _remoteVer: "TERM-SSHD" },
    readdir(_p, cb) { cb(null, []); }, mkdir(_p, cb) { cb(null); },
    stat(p, cb) { try { cb(null, stats(p)); } catch (err) { cb(err); } },
    lstat(p, cb) { try { cb(null, stats(p)); } catch (err) { cb(err); } },
    unlink(p, cb) { files.delete(String(p)); cb(null); },
    chmod(_p, _mode, cb) { cb(null); },
    open(p, flags, cb) {
      if (handles.size) {
        rejectedOpens++;
        return cb(new Error("General failure: one open handle per channel"));
      }
      const name = String(p);
      if (flags === "w") files.set(name, Buffer.alloc(payload.length));
      if (!files.has(name)) return cb(missing());
      const handle = Buffer.from(String(++opens));
      handles.set(handle, { name, cursor: 0 }); cb(null, handle);
    },
    write(handle, buffer, offset, length, _position, cb) {
      const h = handles.get(handle);
      buffer.copy(files.get(h.name), h.cursor, offset, offset + length);
      h.cursor += length;
      setTimeout(() => cb(null), 5);
    },
    read(handle, buffer, offset, length, _position, cb) {
      const h = handles.get(handle); const data = files.get(h.name);
      const count = Math.min(length, data.length - h.cursor);
      data.copy(buffer, offset, h.cursor, h.cursor + count); h.cursor += count;
      setTimeout(() => cb(null, count), 5);
    },
    close(handle, cb) { handles.delete(handle); cb(null); },
    end() {},
  });
  const createClient = () => ({
    sftp, __netcattySingleChannelSsh: true,
    stat: async (p) => stats(p),
    rename: async (from, to) => { files.set(String(to), files.get(String(from))); files.delete(String(from)); },
    delete: async (p) => { files.delete(String(p)); },
    client: { _remoteVer: "TERM-SSHD", sftp() { throw new Error("No terminal subsystem reuse"); } },
  });
  // Real pooled single-channel clients are distinct aliases of one SFTP stream.
  const clients = new Map([["first", createClient()], ["alias", createClient()]]);
  transferBridge.init({ sftpClients: clients });
  t.after(async () => {
    for (const p of [...paths, ...staged]) await fs.rm(p, { force: true });
  });
  return {
    payload, files, sftp, handles, clients,
    rejectedOpens: () => rejectedOpens,
    openCount: () => opens,
    async start(direction, sftpId = "first", options = {}, beforeTransfer = null) {
      const transferId = options.transferId || crypto.randomUUID();
      const localPath = tempDirBridge.getTempFilePath(`term-concurrent-${transferId}.bin`);
      paths.push(localPath);
      const stagePath = tempDirBridge.getTransferTempFilePath(transferId,
        direction === "copy" ? "source.bin" : path.basename(localPath));
      staged.push(stagePath);
      if (direction === "upload") await fs.writeFile(localPath, payload);
      const targetPath = direction === "download" ? localPath : `/uploaded-${transferId}.bin`;
      const checkpoint = options.checkpointBytes || options.downloadCheckpointBytes || 0;
      if (checkpoint > 0) await fs.writeFile(stagePath, payload.subarray(0, checkpoint));
      if (direction === "copy" && options.resumeStage === "upload") {
        await fs.writeFile(stagePath, payload);
        const remoteStage = `/.${path.basename(targetPath)}.netcatty-${transferId}.part`;
        files.set(remoteStage, payload.subarray(0, options.uploadCheckpointBytes || 0));
      }
      if (beforeTransfer) await beforeTransfer;
      const result = await transferBridge.startTransfer({ sender: { send() {} } }, {
        transferId,
        sourcePath: direction === "upload" ? localPath : "/source.bin", targetPath,
        sourceType: direction === "upload" ? "local" : "sftp",
        targetType: direction === "download" ? "local" : "sftp",
        sourceSftpId: sftpId, targetSftpId: sftpId,
        totalBytes: payload.length, resumable: true,
        ...options,
      });
      return { result, targetPath, direction };
    },
  };
}

test("single-channel upload waits for the prior promotion before starting the next file", { timeout: 5_000 }, async (t) => {
  const fixture = await createSequentialTransferFixture(t);
  const originalLstat = fixture.sftp.lstat;
  let lstatCalls = 0;
  let promotionStarted;
  const promotionStartedPromise = new Promise((resolve) => { promotionStarted = resolve; });
  let releasePromotion;
  const promotionGate = new Promise((resolve) => { releasePromotion = resolve; });

  fixture.sftp.lstat = (remotePath, callback) => {
    lstatCalls += 1;
    // The first two calls inspect the recovery backup and initial destination.
    // The third is the final safety check after the .part write; hold it to
    // prove that the next file cannot acquire the channel yet.
    if (lstatCalls === 3) {
      promotionStarted();
      void promotionGate.then(() => originalLstat(remotePath, callback));
      return;
    }
    originalLstat(remotePath, callback);
  };

  const first = fixture.start("upload", "first");
  await promotionStartedPromise;
  const openCountAtPromotion = fixture.openCount();
  const second = fixture.start("upload", "alias");
  let firstResult;
  let secondResult;
  try {
    // start() first writes its local source. Wait until the second upload
    // actually queues, or incorrectly starts remote work, before asserting.
    const deadline = Date.now() + 1_000;
    while (
      transferBridge._getSessionFastDownloadWaiterCountForTests(fixture.sftp) === 0
      && lstatCalls === 3
      && fixture.openCount() === openCountAtPromotion
      && Date.now() < deadline
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(lstatCalls, 3, "the next file must not inspect its target during prior promotion");
    assert.equal(fixture.openCount(), openCountAtPromotion, "the next file must not open a remote handle during prior promotion");
    assert.equal(transferBridge._getSessionFastDownloadWaiterCountForTests(fixture.sftp), 1,
      "the second upload must be waiting for the shared channel");
  } finally {
    releasePromotion();
    [firstResult, secondResult] = await Promise.all([first, second]);
  }
  assert.equal(firstResult.result.error, undefined);
  assert.equal(secondResult.result.error, undefined);
  assert.deepEqual(fixture.files.get(firstResult.targetPath), fixture.payload);
  assert.deepEqual(fixture.files.get(secondResult.targetPath), fixture.payload);
  assert.equal(fixture.rejectedOpens(), 0);
});

for (const secondId of ["first", "alias"]) {
  test(`TERM-SSHD small downloads serialize through body and verification (${secondId})`, async (t) => {
    const fixture = await createSequentialTransferFixture(t);
    const downloads = await Promise.all([fixture.start("download"), fixture.start("download", secondId)]);
    for (const download of downloads) {
      assert.equal(download.result.error, undefined);
      assert.deepEqual(await fs.readFile(download.targetPath), fixture.payload);
    }
    assert.equal(fixture.rejectedOpens(), 0, "the channel must never hold two file handles");
  });
}

for (const directions of [["upload", "upload"], ["upload", "download"]]) {
  test(`TERM-SSHD aliases serialize ${directions.join(" and ")} including verification`, async (t) => {
    const fixture = await createSequentialTransferFixture(t);
    const transfers = await Promise.all(directions.map((direction, index) => fixture.start(direction, index ? "alias" : "first")));
    for (const transfer of transfers) {
      assert.equal(transfer.result.error, undefined);
      assert.deepEqual(transfer.direction === "upload"
        ? fixture.files.get(transfer.targetPath)
        : await fs.readFile(transfer.targetPath), fixture.payload);
    }
    assert.equal(fixture.rejectedOpens(), 0, "the channel must never hold two file handles");
  });
}


test("TERM-SSHD queued cancellation releases its turn without closing the owner channel", async (t) => {
  const fixture = await createSequentialTransferFixture(t);
  const first = fixture.start("download");
  const transferId = crypto.randomUUID();
  const cancelled = fixture.start("download", "alias", { transferId });
  const deadline = Date.now() + 1_000;
  while (transferBridge._getSessionFastDownloadWaiterCountForTests(fixture.sftp) === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(transferBridge._getSessionFastDownloadWaiterCountForTests(fixture.sftp), 1);
  await transferBridge.cancelTransfer(null, { transferId });
  assert.match((await cancelled).result.error || "", /cancelled/i);
  const last = fixture.start("download", "alias");
  for (const download of await Promise.all([first, last])) {
    assert.equal(download.result.error, undefined);
    assert.deepEqual(await fs.readFile(download.targetPath), fixture.payload);
  }
  assert.equal(fixture.rejectedOpens(), 0);
  assert.equal(transferBridge._getSessionFastDownloadWaiterCountForTests(fixture.sftp), 0);
});

for (const firstArrival of ["first", "alias"]) {
  test(`TERM-SSHD failed transfer releases the physical channel for the next alias (${firstArrival} arrives first)`, { timeout: 5_000 }, async (t) => {
    const fixture = await createSequentialTransferFixture(t);
    const originalOpen = fixture.sftp.open;
    let signalFirstOpen;
    let rejectFirstOpen;
    let firstOpenPending = true;
    const firstOpened = new Promise((resolve) => { signalFirstOpen = resolve; });
    fixture.sftp.open = (...args) => {
      if (firstOpenPending) {
        firstOpenPending = false;
        rejectFirstOpen = () => args.at(-1)(Object.assign(new Error("Permission denied"), { code: 3 }));
        signalFirstOpen();
      } else originalOpen(...args);
    };
    let releaseDelayed;
    const delayed = new Promise((resolve) => { releaseDelayed = resolve; });
    // Gate fixture admission to exercise both physical OPEN arrival orders
    // while keeping calls-array order fixed. Local I/O can reorder real calls.
    const calls = [
      fixture.start("download", "first", {}, firstArrival === "alias" ? delayed : null),
      fixture.start("download", "alias", {}, firstArrival === "first" ? delayed : null),
    ];
    const settled = Promise.allSettled(calls);
    const failedIndex = firstArrival === "first" ? 0 : 1;
    let transfers;
    try {
      await Promise.race([firstOpened, calls[failedIndex].then(() => {
        throw new Error("Transfer finished before the controlled OPEN");
      })]);
      releaseDelayed();
      const deadline = Date.now() + 1_000;
      while (transferBridge._getSessionFastDownloadWaiterCountForTests(fixture.sftp) === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(transferBridge._getSessionFastDownloadWaiterCountForTests(fixture.sftp), 1,
        "the other alias must queue before the first OPEN fails");
    } finally {
      releaseDelayed();
      rejectFirstOpen?.();
      transfers = await settled;
    }
    for (const transfer of transfers) assert.equal(transfer.status, "fulfilled");
    const failed = transfers[failedIndex].value;
    const succeeded = transfers[1 - failedIndex].value;
    assert.match(failed.result.error || "", /Permission denied/);
    assert.equal(succeeded.result.error, undefined);
    assert.deepEqual(await fs.readFile(succeeded.targetPath), fixture.payload);
    assert.equal(fixture.rejectedOpens(), 0);
    assert.equal(transferBridge._getSessionFastDownloadWaiterCountForTests(fixture.sftp), 0);
  });
}


for (const direction of ["download", "upload"]) {
  for (const closeMode of ["delayed", "error", "timeout"]) {
    test(`TERM-SSHD active ${direction} cancel handles ${closeMode} CLOSE before releasing an alias`, { timeout: 5_000 }, async (t) => {
      const fixture = await createSequentialTransferFixture(t);
      const originalClose = fixture.sftp.close;
      fixture.sftp.close = (handle, callback) => {
        if (closeMode === "timeout") return;
        if (closeMode === "error") return callback(new Error("General failure"));
        setTimeout(() => originalClose(handle, callback), 100);
      };
      const transferId = crypto.randomUUID();
      const first = fixture.start(direction, "first", { transferId });
      const deadline = Date.now() + 1_000;
      while (fixture.handles.size === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.equal(fixture.handles.size, 1);
      const next = fixture.start("download", "alias");
      await transferBridge.cancelTransfer(null, { transferId });
      const [cancelled, download] = await Promise.all([first, next]);
      assert.ok(cancelled.result.error);
      if (closeMode === "delayed") {
        assert.equal(download.result.error, undefined);
        assert.deepEqual(await fs.readFile(download.targetPath), fixture.payload);
      } else {
        assert.match(download.result.error || "", /Please reconnect/);
      }
      assert.equal(fixture.rejectedOpens(), 0, "an unresolved handle must never be reused");
    });
  }
}

for (const direction of ["download", "upload"]) {
  test(`TERM-SSHD active ${direction} error awaits CLOSE before releasing an alias`, async (t) => {
    const fixture = await createSequentialTransferFixture(t);
    const method = direction === "upload" ? "write" : "read";
    const originalIo = fixture.sftp[method];
    let rejectFirst = true;
    fixture.sftp[method] = (...args) => {
      if (rejectFirst) {
        rejectFirst = false;
        setTimeout(() => args.at(-1)(new Error("Permission denied")), 5);
      } else originalIo(...args);
    };
    const originalClose = fixture.sftp.close;
    fixture.sftp.close = (handle, callback) => setTimeout(() => originalClose(handle, callback), 100);
    const first = fixture.start(direction);
    const deadline = Date.now() + 1_000;
    while (fixture.handles.size === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const next = fixture.start("download", "alias");
    const [failed, download] = await Promise.all([first, next]);
    assert.match(failed.result.error || "", /Permission denied/);
    assert.equal(download.result.error, undefined);
    assert.deepEqual(await fs.readFile(download.targetPath), fixture.payload);
    assert.equal(fixture.rejectedOpens(), 0);
  });
}


for (const direction of ["download", "copy"]) {
  test(`TERM-SSHD resumed ${direction} source fingerprint waits behind an active alias`, { timeout: 5_000 }, async (t) => {
    const fixture = await createSequentialTransferFixture(t);
    const first = fixture.start("download");
    const deadline = Date.now() + 1_000;
    while (fixture.handles.size === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const sourceFingerprint = `sha256:p${fixture.payload.length}:${crypto.createHash("sha256").update(fixture.payload).digest("hex")}`;
    const resumed = fixture.start(direction, "alias", { sourceFingerprint, checkpointBytes: 32768, downloadCheckpointBytes: 32768 });
    for (const transfer of await Promise.all([first, resumed])) {
      assert.equal(transfer.result.error, undefined);
      assert.deepEqual(transfer.direction === "copy" ? fixture.files.get(transfer.targetPath)
        : await fs.readFile(transfer.targetPath), fixture.payload);
    }
    assert.equal(fixture.rejectedOpens(), 0);
  });
}

for (const mode of ["download", "copy-download", "copy-upload"]) {
  test(`TERM-SSHD ${mode} checkpoint verification waits for an alias admitted after fingerprint`, { timeout: 5_000 }, async (t) => {
    const fixture = await createSequentialTransferFixture(t);
    const sourceFingerprint = `sha256:p${fixture.payload.length}:${crypto.createHash("sha256").update(fixture.payload).digest("hex")}`;
    const originalClose = fixture.sftp.close;
    let competing;
    fixture.sftp.close = (handle, callback) => {
      originalClose(handle, callback);
      // The first close completes the full-source fingerprint. Admit an alias
      // before the later checkpoint-prefix proof asks for another handle.
      if (!competing) competing = fixture.start("download", "first");
    };
    const result = await fixture.start(mode === "download" ? "download" : "copy", "alias", {
      sourceFingerprint,
      checkpointBytes: 32768, downloadCheckpointBytes: 32768,
      ...(mode === "copy-upload" ? { resumeStage: "upload", uploadCheckpointBytes: 32768 } : {}),
    });
    const other = await competing;
    assert.equal(result.result.error, undefined);
    assert.equal(other.result.error, undefined);
    assert.deepEqual(result.direction === "copy" ? fixture.files.get(result.targetPath)
      : await fs.readFile(result.targetPath), fixture.payload);
    assert.deepEqual(await fs.readFile(other.targetPath), fixture.payload);
    assert.equal(fixture.rejectedOpens(), 0);
  });
}

for (const phase of ["fingerprint", "checkpoint"]) {
  test(`TERM-SSHD queued ${phase} verification cancels without opening another handle`, { timeout: 5_000 }, async (t) => {
    const fixture = await createSequentialTransferFixture(t);
    const sourceFingerprint = `sha256:p${fixture.payload.length}:${crypto.createHash("sha256").update(fixture.payload).digest("hex")}`;
    let competing;
    if (phase === "checkpoint") {
      const originalClose = fixture.sftp.close;
      fixture.sftp.close = (handle, callback) => {
        originalClose(handle, callback);
        if (!competing) competing = fixture.start("download", "first");
      };
    } else {
      competing = fixture.start("download", "first");
      const deadline = Date.now() + 1_000;
      while (fixture.handles.size === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    const transferId = crypto.randomUUID();
    const resumed = fixture.start("download", "alias", { transferId, sourceFingerprint, checkpointBytes: 32768 });
    const deadline = Date.now() + 1_000;
    while ((!competing || transferBridge._getSessionFastDownloadWaiterCountForTests(fixture.sftp) === 0) && Date.now() < deadline) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(transferBridge._getSessionFastDownloadWaiterCountForTests(fixture.sftp), 1);
    await transferBridge.cancelTransfer(null, { transferId });
    assert.match((await resumed).result.error || "", /cancelled/i);
    const other = await competing;
    assert.equal(other.result.error, undefined);
    assert.deepEqual(await fs.readFile(other.targetPath), fixture.payload);
    assert.equal(fixture.rejectedOpens(), 0);
    assert.equal(transferBridge._getSessionFastDownloadWaiterCountForTests(fixture.sftp), 0);
  });
}


test("TERM-SSHD remote-copy upload checkpoint locks its target rather than its distinct source", { timeout: 5_000 }, async (t) => {
  const source = await createSequentialTransferFixture(t);
  const target = await createSequentialTransferFixture(t);
  transferBridge.init({ sftpClients: new Map([
    ...source.clients,
    ["target-first", target.clients.get("first")],
    ["target-alias", target.clients.get("alias")],
  ]) });
  const competing = target.start("download", "target-first");
  const deadline = Date.now() + 1_000;
  while (target.handles.size === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const transferId = crypto.randomUUID();
  const targetPath = `/uploaded-${transferId}.bin`;
  target.files.set(`/.${path.basename(targetPath)}.netcatty-${transferId}.part`, source.payload.subarray(0, 32768));
  const sourceFingerprint = `sha256:p${source.payload.length}:${crypto.createHash("sha256").update(source.payload).digest("hex")}`;
  const copy = source.start("copy", "first", {
    transferId, targetSftpId: "target-alias", sourceFingerprint,
    resumeStage: "upload", uploadCheckpointBytes: 32768,
  });
  const [copied, other] = await Promise.all([copy, competing]);
  assert.equal(copied.result.error, undefined);
  assert.equal(other.result.error, undefined);
  assert.deepEqual(target.files.get(copied.targetPath), source.payload);
  assert.deepEqual(await fs.readFile(other.targetPath), target.payload);
  assert.equal(source.rejectedOpens(), 0);
  assert.equal(target.rejectedOpens(), 0);
});
