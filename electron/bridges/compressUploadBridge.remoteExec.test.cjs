const assert = require("node:assert/strict");
const { execFileSync, spawn, spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  _createBoundedUtf8CollectorForTests: createBoundedUtf8Collector,
  _buildAtomicRemoteExtractionCommandForTests: buildAtomicRemoteExtractionCommand,
  _buildInteractiveExtractCommandForTests: buildInteractiveExtractCommand,
  _runRemoteExecForTests: runRemoteExec,
} = require("./compressUploadBridge.cjs");

function createHungStream() {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.closedByTest = false;
  stream.close = () => { stream.closedByTest = true; };
  stream.end = () => { stream.closedByTest = true; };
  stream.destroy = () => { stream.closedByTest = true; };
  return stream;
}

test("remote exec timeout closes a hung SSH channel", async () => {
  const stream = createHungStream();
  const sshClient = { exec: (_command, callback) => callback(null, stream) };

  await assert.rejects(
    runRemoteExec(sshClient, "tar --version", { timeoutMs: 5 }),
    /timed out/i,
  );
  assert.equal(stream.closedByTest, true);
});

test("remote exec cancellation closes a hung SSH channel", async () => {
  const stream = createHungStream();
  const sshClient = { exec: (_command, callback) => callback(null, stream) };
  const controller = new AbortController();
  const running = runRemoteExec(sshClient, "tar --version", {
    timeoutMs: 1_000,
    signal: controller.signal,
  });

  controller.abort(new Error("Upload cancelled"));
  await assert.rejects(running, /cancel/i);
  assert.equal(stream.closedByTest, true);
});

test("a late SSH exec callback after timeout closes its stream", async () => {
  let callback;
  let invalidations = 0;
  const sshClient = {
    exec: (_command, next) => { callback = next; },
    destroy: () => { invalidations += 1; },
  };
  const running = runRemoteExec(sshClient, "tar --version", { timeoutMs: 5 });
  await assert.rejects(running, /timed out/i);
  assert.equal(invalidations, 1);

  const stream = createHungStream();
  callback(null, stream);
  assert.equal(stream.closedByTest, true);
});

test("local tar diagnostics stay bounded for very large stderr output", () => {
  const collector = createBoundedUtf8Collector(64 * 1_024);
  for (let index = 0; index < 100; index += 1) {
    collector.append("x".repeat(4_096));
  }
  const value = collector.end();
  assert.equal(value.length, 64 * 1_024);
});

test("remote exec preserves split UTF-8 stderr", async () => {
  const stream = createHungStream();
  const sshClient = { exec: (_command, callback) => callback(null, stream) };
  const running = runRemoteExec(sshClient, "failing command", { timeoutMs: 1_000 });
  const bytes = Buffer.from("中文错误", "utf8");
  stream.stderr.emit("data", bytes.subarray(0, 2));
  stream.stderr.emit("data", bytes.subarray(2));
  stream.emit("close", 1);

  assert.deepEqual(await running, { code: 1, hasOutput: false, stderr: "中文错误" });
});

test("bounded UTF-8 diagnostics omit a character cut by the byte cap", () => {
  const collector = createBoundedUtf8Collector(2);
  collector.append(Buffer.from("中", "utf8"));
  const value = collector.end();
  assert.equal(value, "");
  assert.doesNotMatch(value, /�/u);
});

test("a timed-out local tar probe escalates from TERM to KILL", async (t) => {
  const bridgePath = require.resolve("./compressUploadBridge.cjs");
  const originalLoad = Module._load;
  const originalSetTimeout = globalThis.setTimeout;
  const signals = [];
  const tar = new EventEmitter();
  tar.kill = (signal) => {
    signals.push(signal);
    return true;
  };

  Module._load = function load(request, parent, isMain) {
    if (request === "node:child_process") {
      return { spawn: () => tar };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[bridgePath];
  const isolatedBridge = require("./compressUploadBridge.cjs");
  Module._load = originalLoad;
  t.after(() => {
    Module._load = originalLoad;
    globalThis.setTimeout = originalSetTimeout;
    delete require.cache[bridgePath];
  });

  // Keep the behavioral timeout test fast without exposing timer knobs in the
  // production API: only the two known probe deadlines are shortened.
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(
    callback,
    delay === 10_000 || delay === 750 ? 5 : delay,
    ...args,
  );
  const handlers = new Map();
  isolatedBridge.init({
    sftpClients: new Map(),
    transferBridge: {
      acquireTransferSessionLeases(_leaseId, payload) { return [payload.targetSftpId]; },
      releaseTransferSessionLeases() {},
      broadcastGlobalTransferEvent() {},
    },
  });
  isolatedBridge.registerHandlers({
    handle(channel, handler) { handlers.set(channel, handler); },
  });
  await handlers.get("netcatty:compress:start")({ sender: { id: 1, send() {} } }, {
    compressionId: "hung-local-probe",
    folderPath: "/unused",
    targetPath: "/unused",
    sftpId: "unused",
    folderName: "unused",
    totalBytes: 1,
  });
  await new Promise((resolve) => originalSetTimeout(resolve, 15));

  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("cancelling the real local compressor escalates TERM to KILL and releases its SFTP lease", async (t) => {
  const bridgePath = require.resolve("./compressUploadBridge.cjs");
  const originalLoad = Module._load;
  const originalSetTimeout = globalThis.setTimeout;
  const signals = [];
  let spawnCount = 0;
  let compressor;
  const makeChild = (probe) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (signal) => {
      signals.push(signal);
      if (!probe && signal === "SIGKILL") process.nextTick(() => child.emit("close", null));
      return true;
    };
    if (probe) process.nextTick(() => child.emit("close", 0));
    else compressor = child;
    return child;
  };

  Module._load = function load(request, parent, isMain) {
    if (request === "node:child_process") {
      return { spawn: () => makeChild(++spawnCount === 1) };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[bridgePath];
  const isolatedBridge = require("./compressUploadBridge.cjs");
  Module._load = originalLoad;
  t.after(() => {
    Module._load = originalLoad;
    globalThis.setTimeout = originalSetTimeout;
    delete require.cache[bridgePath];
  });
  globalThis.setTimeout = (callback, delay, ...args) => originalSetTimeout(
    callback,
    delay === 750 ? 5 : delay,
    ...args,
  );

  const remoteStream = new EventEmitter();
  remoteStream.stderr = new EventEmitter();
  remoteStream.close = () => {};
  remoteStream.end = () => {};
  remoteStream.destroy = () => {};
  let released = 0;
  isolatedBridge.init({
    sftpClients: new Map([["sftp-real-compressor", {
      __netcattyEndpointKey: "endpoint:real-compressor",
      client: {
        exec(_command, callback) {
          callback(null, remoteStream);
          process.nextTick(() => {
            remoteStream.emit("data", Buffer.from("tar"));
            remoteStream.emit("close", 0);
          });
        },
      },
    }]]),
    transferBridge: {
      acquireTransferSessionLeases() { return ["sftp-real-compressor"]; },
      releaseTransferSessionLeases() { released += 1; },
      broadcastGlobalTransferEvent() {},
      async cancelTransfer() { return { success: true }; },
    },
  });
  const handlers = new Map();
  isolatedBridge.registerHandlers({ handle(channel, handler) { handlers.set(channel, handler); } });
  const sender = { id: 1, send() {} };
  const starting = handlers.get("netcatty:compress:start")({ sender }, {
    compressionId: "real-compressor-cancel",
    folderPath: "/unused",
    targetPath: "/unused",
    sftpId: "sftp-real-compressor",
    folderName: "unused",
    totalBytes: 1,
  });
  while (!compressor) await new Promise((resolve) => originalSetTimeout(resolve, 1));
  await handlers.get("netcatty:compress:cancel")({ sender }, {
    compressionId: "real-compressor-cancel",
  });
  try {
    await new Promise((resolve) => originalSetTimeout(resolve, 20));
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    await starting;
    assert.equal(released, 1);
    assert.equal(isolatedBridge._getActiveCompressionCountForTests(), 0);
  } finally {
    compressor.emit("close", null);
    await starting.catch(() => {});
  }
});

test("failed compressed extraction leaves the existing final directory untouched", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-compress-atomic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "target");
  const finalDir = path.join(target, "folder");
  fs.mkdirSync(finalDir, { recursive: true });
  fs.writeFileSync(path.join(finalDir, "old.txt"), "old");

  const archive = path.join(target, "missing-folder.tar.gz");

  const command = buildAtomicRemoteExtractionCommand({
    compressionId: "atomic-failure",
    archivePath: archive,
    targetDir: target,
    folderName: "folder",
  });
  assert.throws(() => execFileSync("/bin/sh", ["-c", command], { stdio: "pipe" }));

  assert.equal(fs.readFileSync(path.join(finalDir, "old.txt"), "utf8"), "old");
  assert.equal(fs.existsSync(path.join(finalDir, "new-first.txt")), false);
  assert.equal(
    fs.readdirSync(target).some((name) => name.includes(".netcatty-compress-")),
    false,
  );
});

test("successful compressed extraction atomically merges and removes staging artifacts", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-compress-commit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "target");
  const finalDir = path.join(target, "folder");
  const source = path.join(root, "source");
  fs.mkdirSync(finalDir, { recursive: true });
  fs.mkdirSync(path.join(source, "folder"), { recursive: true });
  fs.writeFileSync(path.join(finalDir, "old.txt"), "old");
  fs.writeFileSync(path.join(source, "folder", "new.txt"), "new");

  const archive = path.join(target, "folder.tar.gz");
  const created = spawnSync("tar", ["-czf", archive, "-C", source, "folder"]);
  assert.equal(created.status, 0, created.stderr?.toString());
  const command = buildAtomicRemoteExtractionCommand({
    compressionId: "atomic-success",
    archivePath: archive,
    targetDir: target,
    folderName: "folder",
  });
  execFileSync("/bin/sh", ["-c", command], { stdio: "pipe" });

  assert.equal(fs.readFileSync(path.join(finalDir, "old.txt"), "utf8"), "old");
  assert.equal(fs.readFileSync(path.join(finalDir, "new.txt"), "utf8"), "new");
  assert.equal(fs.existsSync(archive), false);
  assert.equal(
    fs.readdirSync(target).some((name) => name.includes(".netcatty-compress-")),
    false,
  );
});

test("compressed replacement uses one stable recovery backup across operation ids", () => {
  const first = buildAtomicRemoteExtractionCommand({
    compressionId: "operation-one",
    archivePath: "/target/.folder-one.tar.gz",
    targetDir: "/target",
    folderName: "folder",
  });
  const second = buildAtomicRemoteExtractionCommand({
    compressionId: "operation-two",
    archivePath: "/target/.folder-two.tar.gz",
    targetDir: "/target",
    folderName: "folder",
  });
  const valueFor = (command, name) => command.split("\n").find((line) => line.startsWith(`${name}=`));

  assert.equal(valueFor(first, "backup"), valueFor(second, "backup"));
  assert.equal(valueFor(first, "stage"), valueFor(second, "stage"));
  assert.notEqual(valueFor(first, "archive"), valueFor(second, "archive"));
});

test("compressed promotion can clean a read-only old directory instead of leaking its backup", (t) => {
  if (process.platform === "win32") return t.skip("POSIX mode test");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-compress-protected-backup-"));
  t.after(() => {
    try { execFileSync("chmod", ["-R", "u+w", root]); } catch { /* cleanup */ }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const target = path.join(root, "target");
  const finalDir = path.join(target, "folder");
  const source = path.join(root, "source");
  fs.mkdirSync(path.join(finalDir, "locked"), { recursive: true });
  fs.mkdirSync(path.join(source, "folder"), { recursive: true });
  fs.writeFileSync(path.join(finalDir, "locked", "old.txt"), "old");
  fs.writeFileSync(path.join(source, "folder", "new.txt"), "new");
  fs.chmodSync(path.join(finalDir, "locked"), 0o500);
  const archive = path.join(target, ".folder-operation.tar.gz");
  assert.equal(spawnSync("tar", ["-czf", archive, "-C", source, "folder"]).status, 0);

  const command = buildAtomicRemoteExtractionCommand({
    compressionId: "protected-cleanup",
    archivePath: archive,
    targetDir: target,
    folderName: "folder",
  });
  execFileSync("/bin/sh", ["-c", command], { stdio: "pipe" });

  assert.equal(fs.readFileSync(path.join(finalDir, "new.txt"), "utf8"), "new");
  assert.equal(
    fs.readdirSync(target).some((name) => name.includes(".netcatty-compress-")),
    false,
  );
});

test("failed single-channel compressed extraction leaves the existing folder untouched", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-compress-interactive-fail-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "target");
  const finalDir = path.join(target, "folder");
  fs.mkdirSync(finalDir, { recursive: true });
  fs.writeFileSync(path.join(finalDir, "old.txt"), "old");
  const archive = path.join(target, "truncated.tar.gz");
  fs.writeFileSync(archive, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00]));

  const command = buildInteractiveExtractCommand(archive, target, "folder");
  assert.throws(() => execFileSync("/bin/sh", ["-c", command], { stdio: "pipe" }));
  assert.equal(fs.readFileSync(path.join(finalDir, "old.txt"), "utf8"), "old");
  assert.equal(fs.readdirSync(target).some((name) => name.includes(".netcatty-compress-")), false);
});

test("cancelled single-channel compressed extraction leaves the existing folder untouched", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX fifo test");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-compress-interactive-cancel-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "target");
  const finalDir = path.join(target, "folder");
  fs.mkdirSync(finalDir, { recursive: true });
  fs.writeFileSync(path.join(finalDir, "old.txt"), "old");
  const archive = path.join(target, "blocked.tar.gz");
  assert.equal(spawnSync("mkfifo", [archive]).status, 0);

  const command = buildInteractiveExtractCommand(archive, target, "folder");
  const child = spawn("/bin/sh", ["-c", command], { detached: true, stdio: "ignore" });
  t.after(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
  });
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return predicate();
  };
  assert.equal(await waitFor(() => fs.readdirSync(target).some((name) => name.endsWith(".stage"))), true);
  process.kill(-child.pid, "SIGTERM");
  assert.equal(
    await waitFor(() => !fs.readdirSync(target).some((name) => name.includes(".netcatty-compress-"))),
    true,
  );
  assert.equal(fs.readFileSync(path.join(finalDir, "old.txt"), "utf8"), "old");
});
