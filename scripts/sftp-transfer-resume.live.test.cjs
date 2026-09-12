"use strict";

// Opt-in loopback SSH/SFTP fixture; never connects to a user's server.
// NETCATTY_SFTP_LIVE=1 SFTP_LIVE_MIB=128 SFTP_LIVE_FILES=12 node scripts/sftp-transfer-resume.live.test.cjs

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Server } = require("ssh2");
const SftpClient = require("ssh2-sftp-client");

async function main() {
  const tempBridgePath = require.resolve("../electron/bridges/tempDirBridge.cjs");
  const managedTempBridge = require(tempBridgePath);
  const root = fs.mkdtempSync(`${managedTempBridge.getTempFilePath("sftp-live")}-`);
  try {
    console.log("SFTP_LIVE_ROOT", root);
    // Keep the fixture visible to managed cleanup, but isolate its staging and
    // identity paths from the user's app. Reload only this process's cached
    // bridge after changing the environment; never delete the managed parent.
    for (const key of ["TMPDIR", "TMP", "TEMP", "HOME"]) process.env[key] = root;
    delete require.cache[tempBridgePath];
    await runFixture(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function runFixture(root) {
  let bridge;
  if (process.env.SFTP_LIVE_BASELINE_REF) {
    const Module = require("node:module");
    const filename = path.resolve(__dirname, "../electron/bridges/transferBridge.cjs");
    const baseline = new Module(filename, module);
    baseline.filename = filename;
    baseline.paths = Module._nodeModulePaths(path.dirname(filename));
    baseline._compile(require("node:child_process").execFileSync("git", ["show", `${process.env.SFTP_LIVE_BASELINE_REF}:electron/bridges/transferBridge.cjs`], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" }), filename);
    bridge = baseline.exports;
  } else {
    bridge = require("../electron/bridges/transferBridge.cjs");
  }
  const tempDirBridge = require("../electron/bridges/tempDirBridge.cjs");
  assert.equal(path.dirname(tempDirBridge.getTempDir()), root, "fixture staging must remain isolated");
  const bytes = Number(process.env.SFTP_LIVE_MIB || 8) * 1024 * 1024;
  const fileCount = Number(process.env.SFTP_LIVE_FILES || 1);
  const payload = Buffer.allocUnsafe(bytes);
  for (let i = 0; i < bytes; i += 1) payload[i] = i % 251;
  const digest = crypto.createHash("sha256").update(payload).digest("hex");
  const privateKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
  const connections = new Set();
  let reads = 0;
  let activeReads = 0;
  let peakReads = 0;
  const server = new Server({ hostKeys: [privateKey] }, (connection) => {
    connections.add(connection);
    connection.on("error", () => {});
    connection.on("close", () => connections.delete(connection));
    connection.on("authentication", (context) => context.username === "fixture" ? context.accept() : context.reject());
    connection.on("ready", () => connection.on("session", (accept) => {
      const session = accept();
      session.on("sftp", (acceptSftp) => {
        const sftp = acceptSftp();
        let nextHandle = 0;
        const attrs = { size: bytes, mode: 0o100644, uid: 1, gid: 1, atime: 1700000000, mtime: 1700000000 };
        sftp.on("error", () => {});
        sftp.on("REALPATH", (id) => sftp.name(id, [{ filename: "/", longname: "/", attrs }]));
        for (const operation of ["STAT", "LSTAT", "FSTAT"]) sftp.on(operation, (id) => sftp.attrs(id, attrs));
        sftp.on("OPEN", (id) => sftp.handle(id, Buffer.from(String(nextHandle++))));
        sftp.on("CLOSE", (id) => sftp.status(id, 0));
        sftp.on("READ", (id, _handle, position, length) => {
          reads += 1;
          activeReads += 1;
          peakReads = Math.max(peakReads, activeReads);
          setTimeout(() => {
            activeReads -= 1;
            if (sftp.destroyed) return;
            if (position >= bytes) sftp.status(id, 1);
            else sftp.data(id, payload.subarray(position, Math.min(bytes, position + length)));
          }, Number(process.env.SFTP_LIVE_DELAY_MS || 5));
        });
      });
    }));
  });
  const client = new SftpClient();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    await client.connect({ host: "127.0.0.1", port: server.address().port, username: "fixture", password: "fixture" });
    bridge.init({ sftpClients: new Map([["source", client]]) });
    const runFile = async (index) => {
      const transferId = `live-${crypto.randomUUID()}`;
      const targetPath = path.join(root, `output-${index}.bin`);
      const stagePath = tempDirBridge.getTransferTempFilePath(transferId, path.basename(targetPath));
      const checkpoint = Math.floor(bytes / 4);
      fs.writeFileSync(stagePath, payload.subarray(0, checkpoint));
      let verificationStart = 0;
      let verificationMs = 0;
      let requestedPause = false;
      let pauseResult;
      const startedAt = performance.now();
      const running = bridge.startTransfer({ sender: { send(_channel, event) {
        if (event.phase === "verifying" && !verificationStart) verificationStart = performance.now();
        if (event.phase !== "verifying" && verificationStart) {
          verificationMs += performance.now() - verificationStart;
          verificationStart = 0;
        }
        if (!requestedPause && event.transferred > bytes / 2 && event.transferred < bytes && event.phase === "transferring") {
          requestedPause = true;
          const pauseStarted = performance.now();
          pauseResult = bridge.pauseTransfer(null, { transferId }).then(async (result) => {
            assert.equal(result.success, true, result.reason);
            const pauseMs = performance.now() - pauseStarted;
            const resumeStarted = performance.now();
            const resumed = await bridge.resumeTransfer(null, { transferId });
            assert.equal(resumed.success, true, resumed.reason);
            return { pauseMs: Math.round(pauseMs), resumeMs: Math.round(performance.now() - resumeStarted) };
          });
        }
      } } }, {
        transferId, sourcePath: "/source.bin", targetPath,
        sourceType: "sftp", targetType: "local", sourceSftpId: "source",
        totalBytes: bytes, resumable: true, checkpointBytes: checkpoint,
        sourceFingerprint: `sha256:p${bytes}:${digest}`,
      });
      const result = await running;
      assert.equal(result.error, undefined, result.error);
      const control = await pauseResult;
      const outputDigest = crypto.createHash("sha256");
      for await (const chunk of fs.createReadStream(targetPath)) outputDigest.update(chunk);
      assert.equal(outputDigest.digest("hex"), digest);
      fs.unlinkSync(targetPath);
      return { index, bytes, elapsedMs: Math.round(performance.now() - startedAt), verificationMs: Math.round(verificationMs), ...control };
    };
    const results = [];
    for (let index = 0; index < fileCount; index += 2) {
      results.push(...await Promise.all(Array.from({ length: Math.min(2, fileCount - index) }, (_, offset) => runFile(index + offset))));
    }
    console.log("SFTP_LIVE_PASS", JSON.stringify({ results, reads, peakReads }));
  } finally {
    await client.end().catch(() => {});
    for (const connection of connections) connection.end();
    await new Promise((resolve) => server.close(resolve));
  }
}

if (process.env.NETCATTY_SFTP_LIVE === "1") {
  const watchdog = setTimeout(() => { console.error("SFTP_LIVE_FAIL timeout"); process.exit(1); }, 120_000);
  main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
} else {
  const test = require("node:test");
  for (const existingParent of [false, true]) {
    test(`live SFTP fixture cleans setup failure with ${existingParent ? "existing" : "fresh"} managed parent`, (t) => {
      const tempDirBridge = require("../electron/bridges/tempDirBridge.cjs");
      const testRoot = fs.mkdtempSync(`${tempDirBridge.getTempFilePath("sftp-live-setup-test")}-`);
      t.after(() => fs.rmSync(testRoot, { recursive: true, force: true }));
      const managedParent = path.join(testRoot, "Netcatty");
      if (existingParent) fs.mkdirSync(managedParent, { mode: 0o700 });
      const result = require("node:child_process").spawnSync(process.execPath, [__filename], {
        env: {
          ...process.env,
          ...Object.fromEntries(["TMPDIR", "TMP", "TEMP", "HOME"].map((key) => [key, testRoot])),
          NETCATTY_SFTP_LIVE: "1", SFTP_LIVE_MIB: "-1", SFTP_LIVE_BASELINE_REF: "",
        },
        encoding: "utf8",
        timeout: 10_000,
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /RangeError/);
      const match = result.stdout.match(/^SFTP_LIVE_ROOT ([^\r\n]+)/m);
      assert.ok(match, result.stdout);
      const fixtureRoot = match[1];
      assert.match(path.basename(fixtureRoot), /sftp-live/);
      assert.equal(path.dirname(fixtureRoot), managedParent);
      assert.equal(fs.existsSync(fixtureRoot), false);
      assert.equal(fs.existsSync(path.dirname(fixtureRoot)), true, "must not delete the shared managed parent");
    });
  }
  test("large-file SFTP resume over a loopback SSH connection", {
    skip: "set NETCATTY_SFTP_LIVE=1 to run the real connection fixture",
  }, () => {});
}
