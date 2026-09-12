/**
 * Drive the shipped downloadSftpToLocal / uploadLocalToSftp SCP branches with
 * AbortSignal — the AI/MCP transfer path must cancel mid-flight, not only
 * throwIfAborted before/after.
 */
"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const sftpBridge = require("../sftpBridge.cjs");
const { createScpBackend } = require("./scpBackend.cjs");

function createMockStream() {
  const ee = new EventEmitter();
  ee.writable = true;
  ee.readable = true;
  ee.stderr = new EventEmitter();
  ee.write = (buf, cb) => {
    if (typeof cb === "function") cb();
    return true;
  };
  ee.end = (cb) => { if (typeof cb === "function") cb(); };
  ee.close = () => {
    ee.closed = true;
    ee.destroyed = true;
    ee.emit("close");
  };
  ee.destroy = () => ee.close();
  return ee;
}

describe("AI/MCP SCP transfer abort on shipped download/upload entry points", () => {
  let tmpDir;
  let sftpClients;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-scp-ai-abort-"));
    sftpClients = new Map();
    sftpBridge.init({
      electronModule: {},
      sessions: new Map(),
      sftpClients,
    });
  });

  afterEach(async () => {
    // Aborted SCP transfers can still open the fixture briefly after the test
    // assertion settles. Drain that work before removing the temp directory so
    // Node does not promote a late ENOENT into a file-level failure.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 25));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function registerScpClient(id, { hangOnStream = true } = {}) {
    const backend = createScpBackend({
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
      execStream: async () => {
        const stream = createMockStream();
        if (!hangOnStream) {
          // ready ACK immediately for success paths (not used in abort tests)
          setImmediate(() => stream.emit("data", Buffer.from([0])));
        }
        // hang: never ACK so waitForAck blocks until cancel
        return stream;
      },
    });
    backend.stat = async () => ({ type: "file", isDirectory: false, size: 256 });
    const client = {
      client: { exec: () => {} },
      sftp: null,
      __netcattyFileProtocol: "scp",
      __netcattyScpBackend: backend,
      async end() {},
    };
    sftpClients.set(id, client);
    return client;
  }

  it("downloadSftpToLocal rejects when AbortSignal fires mid-SCP download", async () => {
    registerScpClient("scp-dl");
    const controller = new AbortController();
    const localPath = path.join(tmpDir, "out.bin");
    const original = Buffer.from("existing-local-content");
    fs.writeFileSync(localPath, original);
    const promise = sftpBridge.downloadSftpToLocal(null, {
      sftpId: "scp-dl",
      remotePath: "/remote/file.bin",
      localPath,
      abortSignal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 40));
    controller.abort();
    await assert.rejects(() => promise, /cancel|abort/i);
    assert.deepEqual(fs.readFileSync(localPath), original);
  });

  it("downloadSftpToLocal settles when abort closes SCP before parser listeners attach", async () => {
    const controller = new AbortController();
    const backend = createScpBackend({
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
      execStream: async (_command, options = {}) => {
        const stream = createMockStream();
        options.signal?.addEventListener?.("abort", () => stream.close(), { once: true });
        // Reproduce the transition race deterministically: the unified abort
        // listener marks the transfer cancelled and this stream closes before
        // downloadToWritable can attach its parser close/error listeners.
        controller.abort();
        return stream;
      },
    });
    backend.stat = async () => ({ type: "file", isDirectory: false, size: 256 });
    sftpClients.set("scp-transition-abort", {
      __netcattyFileProtocol: "scp",
      __netcattyScpBackend: backend,
    });

    const localPath = path.join(tmpDir, "transition-abort.bin");
    const original = Buffer.from("existing-local-content");
    fs.writeFileSync(localPath, original);
    const download = sftpBridge.downloadSftpToLocal(null, {
      sftpId: "scp-transition-abort",
      remotePath: "/remote/file.bin",
      localPath,
      abortSignal: controller.signal,
    });

    await assert.rejects(
      () => Promise.race([
        download,
        new Promise((_, reject) => setTimeout(() => reject(new Error("cancel timed out")), 500)),
      ]),
      /cancel|abort/i,
    );
    assert.deepEqual(fs.readFileSync(localPath), original);
  });

  it("downloadSftpToLocal rejects when SCP closes before parser listeners attach", async () => {
    const backend = createScpBackend({
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
      execStream: async () => {
        const stream = createMockStream();
        stream.close();
        return stream;
      },
    });
    backend.stat = async () => ({ type: "file", isDirectory: false, size: 256 });
    sftpClients.set("scp-transition-close", {
      __netcattyFileProtocol: "scp",
      __netcattyScpBackend: backend,
    });

    const localPath = path.join(tmpDir, "transition-close.bin");
    const original = Buffer.from("existing-local-content");
    fs.writeFileSync(localPath, original);
    const download = sftpBridge.downloadSftpToLocal(null, {
      sftpId: "scp-transition-close",
      remotePath: "/remote/file.bin",
      localPath,
    });

    await assert.rejects(
      () => Promise.race([
        download,
        new Promise((_, reject) => setTimeout(() => reject(new Error("close timed out")), 500)),
      ]),
      /closed|protocol|channel/i,
    );
    assert.deepEqual(fs.readFileSync(localPath), original);
  });

  it("readSftpBinary reports AbortSignal-only SCP cancellation as cancelled", async () => {
    const controller = new AbortController();
    const backend = createScpBackend({
      exec: async () => ({ stdout: "", stderr: "", code: 0 }),
      execStream: async (_command, options = {}) => {
        const stream = createMockStream();
        options.signal?.addEventListener?.("abort", () => stream.close(), { once: true });
        return stream;
      },
    });
    sftpClients.set("scp-read-signal", {
      __netcattyFileProtocol: "scp",
      __netcattyScpBackend: backend,
    });

    const read = sftpBridge.readSftpBinary(null, {
      sftpId: "scp-read-signal",
      path: "/remote/file.bin",
      abortSignal: controller.signal,
    });
    setImmediate(() => controller.abort());

    await assert.rejects(
      () => Promise.race([
        read,
        new Promise((_, reject) => setTimeout(() => reject(new Error("cancel timed out")), 500)),
      ]),
      /cancel|abort/i,
    );
  });

  it("downloadSftpToLocal preserves the destination when cancellation arrives after SCP download", async () => {
    const controller = new AbortController();
    const downloaded = Buffer.from("new-downloaded-content");
    const backend = {
      async stat() {
        return { type: "file", isDirectory: false, size: downloaded.length };
      },
      async downloadFile(_remotePath, localPath) {
        await fs.promises.writeFile(localPath, downloaded);
        controller.abort();
      },
    };
    sftpClients.set("scp-late-abort", {
      __netcattyFileProtocol: "scp",
      __netcattyScpBackend: backend,
    });
    const localPath = path.join(tmpDir, "late-abort.bin");
    const original = Buffer.from("existing-local-content");
    fs.writeFileSync(localPath, original);

    await assert.rejects(
      () => sftpBridge.downloadSftpToLocal(null, {
        sftpId: "scp-late-abort",
        remotePath: "/remote/file.bin",
        localPath,
        abortSignal: controller.signal,
      }),
      /cancel|abort/i,
    );
    assert.deepEqual(fs.readFileSync(localPath), original);
  });

  it("downloadSftpToLocal uses the SCP header size when downloading through a symlink", async () => {
    const downloaded = Buffer.from("target-content-is-longer-than-link");
    const backend = {
      async stat() {
        return { type: "symlink", isSymbolicLink: true, size: 4 };
      },
      async downloadFile(_remotePath, localPath) {
        await fs.promises.writeFile(localPath, downloaded);
        return { fileSize: downloaded.length, transferred: downloaded.length };
      },
    };
    sftpClients.set("scp-symlink-download", {
      __netcattyFileProtocol: "scp",
      __netcattyScpBackend: backend,
    });
    const localPath = path.join(tmpDir, "symlink-download.bin");

    const result = await sftpBridge.downloadSftpToLocal(null, {
      sftpId: "scp-symlink-download",
      remotePath: "/remote/link",
      localPath,
    });

    assert.equal(result.success, true);
    assert.deepEqual(fs.readFileSync(localPath), downloaded);
  });

  it("downloadSftpToLocal preserves a local destination symlink", {
    skip: process.platform === "win32",
  }, async () => {
    const downloaded = Buffer.from("replacement-through-local-link");
    const backend = {
      async stat() {
        return { type: "file", isDirectory: false, size: downloaded.length };
      },
      async downloadFile(_remotePath, localPath) {
        await fs.promises.writeFile(localPath, downloaded);
        return { fileSize: downloaded.length, transferred: downloaded.length };
      },
    };
    sftpClients.set("scp-local-symlink", {
      __netcattyFileProtocol: "scp",
      __netcattyScpBackend: backend,
    });
    const referentPath = path.join(tmpDir, "symlink-target.bin");
    const localPath = path.join(tmpDir, "download-link.bin");
    await fs.promises.writeFile(referentPath, Buffer.from("old-target-content"));
    await fs.promises.symlink(path.basename(referentPath), localPath);

    const result = await sftpBridge.downloadSftpToLocal(null, {
      sftpId: "scp-local-symlink",
      remotePath: "/remote/file.bin",
      localPath,
    });

    assert.equal(result.success, true);
    assert.equal((await fs.promises.lstat(localPath)).isSymbolicLink(), true);
    assert.equal(await fs.promises.readlink(localPath), path.basename(referentPath));
    assert.deepEqual(await fs.promises.readFile(referentPath), downloaded);
  });

  it("downloadSftpToLocal preserves a multi-level broken local symlink chain", {
    skip: process.platform === "win32",
  }, async () => {
    const downloaded = Buffer.from("replacement-through-broken-link-chain");
    const backend = {
      async stat() {
        return { type: "file", isDirectory: false, size: downloaded.length };
      },
      async downloadFile(_remotePath, localPath) {
        await fs.promises.writeFile(localPath, downloaded);
        return { fileSize: downloaded.length, transferred: downloaded.length };
      },
    };
    sftpClients.set("scp-broken-link-chain", {
      __netcattyFileProtocol: "scp",
      __netcattyScpBackend: backend,
    });
    const finalPath = path.join(tmpDir, "missing-final.bin");
    const intermediatePath = path.join(tmpDir, "intermediate-link.bin");
    const localPath = path.join(tmpDir, "download-link-chain.bin");
    await fs.promises.symlink(path.basename(finalPath), intermediatePath);
    await fs.promises.symlink(path.basename(intermediatePath), localPath);

    const result = await sftpBridge.downloadSftpToLocal(null, {
      sftpId: "scp-broken-link-chain",
      remotePath: "/remote/file.bin",
      localPath,
    });

    assert.equal(result.success, true);
    assert.equal((await fs.promises.lstat(localPath)).isSymbolicLink(), true);
    assert.equal((await fs.promises.lstat(intermediatePath)).isSymbolicLink(), true);
    assert.deepEqual(await fs.promises.readFile(finalPath), downloaded);
  });

  it("downloadSftpToLocal refuses a local symlink that points to a directory", {
    skip: process.platform === "win32",
  }, async () => {
    const downloaded = Buffer.from("must-not-replace-a-directory");
    const backend = {
      async stat() {
        return { type: "file", isDirectory: false, size: downloaded.length };
      },
      async downloadFile(_remotePath, localPath) {
        await fs.promises.writeFile(localPath, downloaded);
        return { fileSize: downloaded.length, transferred: downloaded.length };
      },
    };
    sftpClients.set("scp-directory-link", {
      __netcattyFileProtocol: "scp",
      __netcattyScpBackend: backend,
    });
    const directoryPath = path.join(tmpDir, "preserved-directory");
    const preservedPath = path.join(directoryPath, "keep.txt");
    const localPath = path.join(tmpDir, "directory-link");
    await fs.promises.mkdir(directoryPath);
    await fs.promises.writeFile(preservedPath, Buffer.from("keep-me"));
    await fs.promises.symlink(path.basename(directoryPath), localPath);

    await assert.rejects(
      () => sftpBridge.downloadSftpToLocal(null, {
        sftpId: "scp-directory-link",
        remotePath: "/remote/file.bin",
        localPath,
      }),
      /not a regular file/i,
    );
    assert.equal((await fs.promises.lstat(localPath)).isSymbolicLink(), true);
    assert.equal((await fs.promises.stat(directoryPath)).isDirectory(), true);
    assert.deepEqual(await fs.promises.readFile(preservedPath), Buffer.from("keep-me"));
  });

  it("downloadSftpToLocal refuses an existing local directory", async () => {
    const downloaded = Buffer.from("must-not-replace-a-directory");
    const backend = {
      async stat() {
        return { type: "file", isDirectory: false, size: downloaded.length };
      },
      async downloadFile(_remotePath, localPath) {
        await fs.promises.writeFile(localPath, downloaded);
        return { fileSize: downloaded.length, transferred: downloaded.length };
      },
    };
    sftpClients.set("scp-direct-directory", {
      __netcattyFileProtocol: "scp",
      __netcattyScpBackend: backend,
    });
    const directoryPath = path.join(tmpDir, "direct-preserved-directory");
    const preservedPath = path.join(directoryPath, "keep.txt");
    await fs.promises.mkdir(directoryPath);
    await fs.promises.writeFile(preservedPath, Buffer.from("keep-me"));

    await assert.rejects(
      () => sftpBridge.downloadSftpToLocal(null, {
        sftpId: "scp-direct-directory",
        remotePath: "/remote/file.bin",
        localPath: directoryPath,
      }),
      /not a regular file/i,
    );
    assert.equal((await fs.promises.stat(directoryPath)).isDirectory(), true);
    assert.deepEqual(await fs.promises.readFile(preservedPath), Buffer.from("keep-me"));
  });

  it("downloadSftpToLocal refuses a local symbolic-link loop", {
    skip: process.platform === "win32",
  }, async () => {
    const downloaded = Buffer.from("must-not-enter-a-link-loop");
    const backend = {
      async stat() {
        return { type: "file", isDirectory: false, size: downloaded.length };
      },
      async downloadFile(_remotePath, localPath) {
        await fs.promises.writeFile(localPath, downloaded);
        return { fileSize: downloaded.length, transferred: downloaded.length };
      },
    };
    sftpClients.set("scp-link-loop", {
      __netcattyFileProtocol: "scp",
      __netcattyScpBackend: backend,
    });
    const firstLink = path.join(tmpDir, "first-loop-link");
    const secondLink = path.join(tmpDir, "second-loop-link");
    await fs.promises.symlink(path.basename(secondLink), firstLink);
    await fs.promises.symlink(path.basename(firstLink), secondLink);

    await assert.rejects(
      () => sftpBridge.downloadSftpToLocal(null, {
        sftpId: "scp-link-loop",
        remotePath: "/remote/file.bin",
        localPath: firstLink,
      }),
      /symbolic-link loop/i,
    );
    assert.equal((await fs.promises.lstat(firstLink)).isSymbolicLink(), true);
    assert.equal((await fs.promises.lstat(secondLink)).isSymbolicLink(), true);
  });

  it("downloadSftpToLocal allows a valid path to revisit one symlink", {
    skip: process.platform === "win32",
  }, async () => {
    const downloaded = Buffer.from("valid-repeated-link-path");
    const backend = {
      async stat() {
        return { type: "file", isDirectory: false, size: downloaded.length };
      },
      async downloadFile(_remotePath, localPath) {
        await fs.promises.writeFile(localPath, downloaded);
        return { fileSize: downloaded.length, transferred: downloaded.length };
      },
    };
    sftpClients.set("scp-repeated-link", {
      __netcattyFileProtocol: "scp",
      __netcattyScpBackend: backend,
    });
    const nestedDir = path.join(tmpDir, "repeated-link-dir");
    const upLink = path.join(nestedDir, "up");
    await fs.promises.mkdir(nestedDir);
    await fs.promises.symlink("..", upLink);
    const localPath = path.join(upLink, path.basename(nestedDir), "up", "repeated-final.bin");

    const result = await sftpBridge.downloadSftpToLocal(null, {
      sftpId: "scp-repeated-link",
      remotePath: "/remote/file.bin",
      localPath,
    });

    assert.equal(result.success, true);
    assert.deepEqual(await fs.promises.readFile(path.join(tmpDir, "repeated-final.bin")), downloaded);
    assert.equal((await fs.promises.lstat(upLink)).isSymbolicLink(), true);
  });

  it("downloadSftpToLocal preserves the existing local file mode", {
    skip: process.platform === "win32",
  }, async () => {
    const downloaded = Buffer.from("replacement-with-private-mode");
    const backend = {
      async stat() {
        return { type: "file", isDirectory: false, size: downloaded.length };
      },
      async downloadFile(_remotePath, localPath) {
        await fs.promises.writeFile(localPath, downloaded, { mode: 0o644 });
        return { fileSize: downloaded.length, transferred: downloaded.length };
      },
    };
    sftpClients.set("scp-local-mode", {
      __netcattyFileProtocol: "scp",
      __netcattyScpBackend: backend,
    });
    const localPath = path.join(tmpDir, "private-download.bin");
    await fs.promises.writeFile(localPath, Buffer.from("private-old-content"), { mode: 0o600 });
    await fs.promises.chmod(localPath, 0o600);

    const result = await sftpBridge.downloadSftpToLocal(null, {
      sftpId: "scp-local-mode",
      remotePath: "/remote/file.bin",
      localPath,
    });

    assert.equal(result.success, true);
    assert.deepEqual(await fs.promises.readFile(localPath), downloaded);
    assert.equal((await fs.promises.stat(localPath)).mode & 0o777, 0o600);
  });

  it("downloadSftpToLocal stops when a parent symlink changes before promotion", {
    skip: process.platform === "win32",
  }, async (t) => {
    const downloaded = Buffer.from("must-not-follow-the-new-parent");
    const backend = {
      async stat() {
        return { type: "file", isDirectory: false, size: downloaded.length };
      },
      async downloadFile(_remotePath, localPath) {
        await fs.promises.writeFile(localPath, downloaded);
        return { fileSize: downloaded.length, transferred: downloaded.length };
      },
    };
    sftpClients.set("scp-parent-link-change", {
      __netcattyFileProtocol: "scp",
      __netcattyScpBackend: backend,
    });
    const firstDir = path.join(tmpDir, "first-parent");
    const secondDir = path.join(tmpDir, "second-parent");
    const parentLink = path.join(tmpDir, "parent-link");
    const localPath = path.join(parentLink, "target.bin");
    const firstOriginal = Buffer.from("first-original");
    const secondOriginal = Buffer.from("second-original");
    await fs.promises.mkdir(firstDir);
    await fs.promises.mkdir(secondDir);
    await fs.promises.writeFile(path.join(firstDir, "target.bin"), firstOriginal);
    await fs.promises.writeFile(path.join(secondDir, "target.bin"), secondOriginal);
    await fs.promises.symlink(path.basename(firstDir), parentLink);

    const originalRename = fs.promises.rename;
    let renameCalls = 0;
    fs.promises.rename = async (...args) => {
      await originalRename(...args);
      renameCalls += 1;
      if (renameCalls === 1) {
        await fs.promises.unlink(parentLink);
        await fs.promises.symlink(path.basename(secondDir), parentLink);
      }
    };
    t.after(() => { fs.promises.rename = originalRename; });

    await assert.rejects(
      () => sftpBridge.downloadSftpToLocal(null, {
        sftpId: "scp-parent-link-change",
        remotePath: "/remote/file.bin",
        localPath,
      }),
      /target changed before replacement/i,
    );
    assert.equal(await fs.promises.readlink(parentLink), path.basename(secondDir));
    assert.deepEqual(await fs.promises.readFile(path.join(firstDir, "target.bin")), firstOriginal);
    assert.deepEqual(await fs.promises.readFile(path.join(secondDir, "target.bin")), secondOriginal);
    const leftovers = (await fs.promises.readdir(secondDir))
      .filter((name) => name.includes(".netcatty-") || name.includes(".backup"));
    assert.deepEqual(leftovers, []);
  });

  it("downloadSftpToLocal leaves the original untouched when mode setup fails", {
    skip: process.platform === "win32",
  }, async (t) => {
    const downloaded = Buffer.from("replacement-that-must-not-publish");
    const backend = {
      async stat() {
        return { type: "file", isDirectory: false, size: downloaded.length };
      },
      async downloadFile(_remotePath, localPath) {
        await fs.promises.writeFile(localPath, downloaded, { mode: 0o644 });
        return { fileSize: downloaded.length, transferred: downloaded.length };
      },
    };
    sftpClients.set("scp-mode-setup-failure", {
      __netcattyFileProtocol: "scp",
      __netcattyScpBackend: backend,
    });
    const localPath = path.join(tmpDir, "mode-setup-failure.bin");
    const original = Buffer.from("private-original");
    await fs.promises.writeFile(localPath, original, { mode: 0o600 });
    await fs.promises.chmod(localPath, 0o600);

    const originalChmod = fs.promises.chmod;
    fs.promises.chmod = async (filePath, mode) => {
      if (String(filePath).includes(".netcatty-") && String(filePath).endsWith(".ready")) {
        const error = new Error("injected chmod failure");
        error.code = "EPERM";
        throw error;
      }
      return originalChmod(filePath, mode);
    };
    t.after(() => { fs.promises.chmod = originalChmod; });

    await assert.rejects(
      () => sftpBridge.downloadSftpToLocal(null, {
        sftpId: "scp-mode-setup-failure",
        remotePath: "/remote/file.bin",
        localPath,
      }),
      /chmod failure/i,
    );
    assert.deepEqual(await fs.promises.readFile(localPath), original);
    assert.equal((await fs.promises.stat(localPath)).mode & 0o777, 0o600);
    const leftovers = (await fs.promises.readdir(tmpDir))
      .filter((name) => name.includes("mode-setup-failure.bin.netcatty-"));
    assert.deepEqual(leftovers, []);
  });

  it("downloadSftpToLocal rechecks the target after mode setup", {
    skip: process.platform === "win32",
  }, async (t) => {
    const downloaded = Buffer.from("must-not-replace-late-directory");
    const backend = {
      async stat() {
        return { type: "file", isDirectory: false, size: downloaded.length };
      },
      async downloadFile(_remotePath, localPath) {
        await fs.promises.writeFile(localPath, downloaded, { mode: 0o644 });
        return { fileSize: downloaded.length, transferred: downloaded.length };
      },
    };
    sftpClients.set("scp-late-directory", {
      __netcattyFileProtocol: "scp",
      __netcattyScpBackend: backend,
    });
    const localPath = path.join(tmpDir, "late-directory-target");
    const savedOriginalPath = path.join(tmpDir, "saved-late-original.bin");
    const original = Buffer.from("original-before-late-change");
    await fs.promises.writeFile(localPath, original, { mode: 0o600 });

    const originalChmod = fs.promises.chmod;
    let releaseChmod;
    let markChmodStarted;
    const chmodStarted = new Promise((resolve) => { markChmodStarted = resolve; });
    fs.promises.chmod = async (filePath, mode) => {
      if (String(filePath).includes(".netcatty-") && String(filePath).endsWith(".ready")) {
        markChmodStarted();
        await new Promise((resolve) => { releaseChmod = resolve; });
      }
      return originalChmod(filePath, mode);
    };
    t.after(() => { fs.promises.chmod = originalChmod; });

    const running = sftpBridge.downloadSftpToLocal(null, {
      sftpId: "scp-late-directory",
      remotePath: "/remote/file.bin",
      localPath,
    });
    await chmodStarted;
    await fs.promises.rename(localPath, savedOriginalPath);
    await fs.promises.mkdir(localPath);
    releaseChmod();

    await assert.rejects(() => running, /not a regular file/i);
    assert.equal((await fs.promises.stat(localPath)).isDirectory(), true);
    assert.deepEqual(await fs.promises.readFile(savedOriginalPath), original);
    const leftovers = (await fs.promises.readdir(tmpDir))
      .filter((name) => name.includes("late-directory-target.netcatty-"));
    assert.deepEqual(leftovers, []);
  });

  it("downloadSftpToLocal does not overwrite a same-mode file that appears during mode setup", {
    skip: process.platform === "win32",
  }, async (t) => {
    const downloaded = Buffer.from("must-not-replace-a-new-owner-file");
    const backend = {
      async stat() {
        return { type: "file", isDirectory: false, size: downloaded.length };
      },
      async downloadFile(_remotePath, localPath) {
        await fs.promises.writeFile(localPath, downloaded, { mode: 0o644 });
        return { fileSize: downloaded.length, transferred: downloaded.length };
      },
    };
    sftpClients.set("scp-same-mode-replacement", {
      __netcattyFileProtocol: "scp",
      __netcattyScpBackend: backend,
    });
    const localPath = path.join(tmpDir, "same-mode-replacement.bin");
    const savedOriginalPath = path.join(tmpDir, "saved-same-mode-original.bin");
    const original = Buffer.from("original-before-replacement");
    const newOwnerContent = Buffer.from("new-owner-content");
    await fs.promises.writeFile(localPath, original, { mode: 0o600 });
    await fs.promises.chmod(localPath, 0o600);

    const originalChmod = fs.promises.chmod;
    let releaseChmod;
    let markChmodStarted;
    const chmodStarted = new Promise((resolve) => { markChmodStarted = resolve; });
    fs.promises.chmod = async (filePath, mode) => {
      if (String(filePath).includes(".netcatty-") && String(filePath).endsWith(".ready")) {
        markChmodStarted();
        await new Promise((resolve) => { releaseChmod = resolve; });
      }
      return originalChmod(filePath, mode);
    };
    t.after(() => { fs.promises.chmod = originalChmod; });

    const running = sftpBridge.downloadSftpToLocal(null, {
      sftpId: "scp-same-mode-replacement",
      remotePath: "/remote/file.bin",
      localPath,
    });
    await chmodStarted;
    await fs.promises.rename(localPath, savedOriginalPath);
    await fs.promises.writeFile(localPath, newOwnerContent, { mode: 0o600 });
    await fs.promises.chmod(localPath, 0o600);
    releaseChmod();

    await assert.rejects(() => running, /target changed before replacement/i);
    assert.deepEqual(await fs.promises.readFile(localPath), newOwnerContent);
    assert.deepEqual(await fs.promises.readFile(savedOriginalPath), original);
    assert.equal((await fs.promises.stat(localPath)).mode & 0o777, 0o600);
    const leftovers = (await fs.promises.readdir(tmpDir))
      .filter((name) => name.includes("same-mode-replacement.bin.netcatty-"));
    assert.deepEqual(leftovers, []);
  });

  it("downloadSftpToLocal restores the destination when cancellation arrives during promotion", async (t) => {
    const controller = new AbortController();
    const downloaded = Buffer.from("new-downloaded-content");
    const backend = {
      async stat() {
        return { type: "file", isDirectory: false, size: downloaded.length };
      },
      async downloadFile(_remotePath, localPath) {
        await fs.promises.writeFile(localPath, downloaded);
      },
    };
    sftpClients.set("scp-promotion-abort", {
      __netcattyFileProtocol: "scp",
      __netcattyScpBackend: backend,
    });
    const localPath = path.join(tmpDir, "promotion-abort.bin");
    const original = Buffer.from("existing-local-content");
    fs.writeFileSync(localPath, original);

    const originalRename = fs.promises.rename;
    let renameCalls = 0;
    fs.promises.rename = async (...args) => {
      await originalRename(...args);
      renameCalls += 1;
      if (renameCalls === 2) controller.abort();
    };
    t.after(() => { fs.promises.rename = originalRename; });

    await assert.rejects(
      () => sftpBridge.downloadSftpToLocal(null, {
        sftpId: "scp-promotion-abort",
        remotePath: "/remote/file.bin",
        localPath,
        abortSignal: controller.signal,
      }),
      /cancel|abort/i,
    );
    assert.deepEqual(fs.readFileSync(localPath), original);
  });

  it("downloadSftpToLocal keeps the committed download when cancellation arrives after publication", async (t) => {
    const controller = new AbortController();
    const downloaded = Buffer.from("new-downloaded-content");
    const backend = {
      async stat() {
        return { type: "file", isDirectory: false, size: downloaded.length };
      },
      async downloadFile(_remotePath, localPath) {
        await fs.promises.writeFile(localPath, downloaded);
      },
    };
    sftpClients.set("scp-final-rename-abort", {
      __netcattyFileProtocol: "scp",
      __netcattyScpBackend: backend,
    });
    const localPath = path.join(tmpDir, "final-rename-abort.bin");
    const original = Buffer.from("existing-local-content");
    fs.writeFileSync(localPath, original);

    const originalLink = fs.promises.link;
    let published = false;
    fs.promises.link = async (...args) => {
      await originalLink(...args);
      if (path.basename(args[1]) === path.basename(localPath) && String(args[0]).endsWith(".ready")) {
        published = true;
        controller.abort();
      }
    };
    t.after(() => { fs.promises.link = originalLink; });

    await assert.doesNotReject(
      () => sftpBridge.downloadSftpToLocal(null, {
        sftpId: "scp-final-rename-abort",
        remotePath: "/remote/file.bin",
        localPath,
        abortSignal: controller.signal,
      }),
    );
    assert.equal(published, true);
    assert.deepEqual(fs.readFileSync(localPath), downloaded);
  });

  it("downloadSftpToLocal reports and preserves the backup when cancellation rollback fails", async (t) => {
    const controller = new AbortController();
    const downloaded = Buffer.from("new-downloaded-content");
    const backend = {
      async stat() {
        return { type: "file", isDirectory: false, size: downloaded.length };
      },
      async downloadFile(_remotePath, localPath) {
        await fs.promises.writeFile(localPath, downloaded);
      },
    };
    sftpClients.set("scp-rollback-failure", {
      __netcattyFileProtocol: "scp",
      __netcattyScpBackend: backend,
    });
    const localPath = path.join(tmpDir, "rollback-failure.bin");
    const original = Buffer.from("existing-local-content");
    fs.writeFileSync(localPath, original);

    const originalRename = fs.promises.rename;
    const originalLink = fs.promises.link;
    let backupPath = null;
    fs.promises.rename = async (...args) => {
      await originalRename(...args);
      if (path.basename(args[0]) === path.basename(localPath) && String(args[1]).endsWith(".backup")) {
        backupPath = args[1];
        controller.abort();
      }
    };
    fs.promises.link = async (...args) => {
      if (String(args[0]).endsWith(".backup")) throw Object.assign(new Error("injected restore failure"), { code: "EIO" });
      return originalLink(...args);
    };
    t.after(() => { fs.promises.rename = originalRename; fs.promises.link = originalLink; });

    await assert.rejects(
      () => sftpBridge.downloadSftpToLocal(null, {
        sftpId: "scp-rollback-failure",
        remotePath: "/remote/file.bin",
        localPath,
        abortSignal: controller.signal,
      }),
      (error) => {
        assert.match(error.message, /Recovery files preserved/);
        assert.match(error.message, /Backup:/);
        assert.doesNotMatch(error.message, /^Transfer cancelled$/);
        return true;
      },
    );
    assert.ok(backupPath);
    assert.deepEqual(fs.readFileSync(backupPath), original);
  });

  it("downloadSftpToLocal reports both recovery files when pre-publish restoration fails", async (t) => {
    const controller = new AbortController();
    const downloaded = Buffer.from("new-downloaded-content");
    const backend = {
      async stat() {
        return { type: "file", isDirectory: false, size: downloaded.length };
      },
      async downloadFile(_remotePath, localPath) {
        await fs.promises.writeFile(localPath, downloaded);
      },
    };
    sftpClients.set("scp-pre-publish-rollback-failure", {
      __netcattyFileProtocol: "scp",
      __netcattyScpBackend: backend,
    });
    const localPath = path.join(tmpDir, "pre-publish-rollback-failure.bin");
    fs.writeFileSync(localPath, Buffer.from("existing-local-content"));

    const originalRename = fs.promises.rename;
    let renameCalls = 0;
    let readyPath = null;
    let backupPath = null;
    fs.promises.rename = async (...args) => {
      renameCalls += 1;
      await originalRename(...args);
      if (renameCalls === 1) readyPath = args[1];
      if (renameCalls === 2) {
        backupPath = args[1];
        controller.abort();
      }
    };
    const originalLink = fs.promises.link;
    fs.promises.link = async (...args) => {
      if (String(args[0]).endsWith(".backup")) throw Object.assign(new Error("injected restore failure"), { code: "EIO" });
      return originalLink(...args);
    };
    t.after(() => { fs.promises.rename = originalRename; fs.promises.link = originalLink; });

    await assert.rejects(
      () => sftpBridge.downloadSftpToLocal(null, {
        sftpId: "scp-pre-publish-rollback-failure",
        remotePath: "/remote/file.bin",
        localPath,
        abortSignal: controller.signal,
      }),
      (error) => {
        assert.match(error.message, /Recovery files preserved/);
        assert.match(error.message, new RegExp(readyPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.match(error.message, new RegExp(backupPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      },
    );
    assert.equal(fs.existsSync(readyPath), true);
    assert.equal(fs.existsSync(backupPath), true);
  });

  it("uploadLocalToSftp rejects when AbortSignal fires mid-SCP upload", async () => {
    registerScpClient("scp-up");
    const localPath = path.join(tmpDir, "in.bin");
    fs.writeFileSync(localPath, Buffer.alloc(256, 9));
    const controller = new AbortController();
    const promise = sftpBridge.uploadLocalToSftp(null, {
      sftpId: "scp-up",
      localPath,
      remotePath: "/remote/in.bin",
      abortSignal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 40));
    controller.abort();
    await assert.rejects(() => promise, /cancel|abort/i);
  });

  it("uploadLocalToSftp aborts while SCP target inspection is still pending", async () => {
    let uploadCalls = 0;
    const backend = {
      async stat(_remotePath, options = {}) {
        await new Promise((resolve, reject) => {
          if (options.signal?.aborted) {
            reject(new Error("Transfer cancelled"));
            return;
          }
          options.signal?.addEventListener(
            "abort",
            () => reject(new Error("Transfer cancelled")),
            { once: true },
          );
        });
      },
      async uploadFile() {
        uploadCalls += 1;
      },
    };
    sftpClients.set("scp-setup-abort", {
      __netcattyFileProtocol: "scp",
      __netcattyScpBackend: backend,
    });
    const localPath = path.join(tmpDir, "setup.bin");
    fs.writeFileSync(localPath, Buffer.alloc(16, 1));
    const controller = new AbortController();
    const startedAt = Date.now();
    const promise = sftpBridge.uploadLocalToSftp(null, {
      sftpId: "scp-setup-abort",
      localPath,
      remotePath: "/remote/setup.bin",
      abortSignal: controller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(() => promise, /cancel|abort/i);
    assert.equal(uploadCalls, 0);
    assert.ok(Date.now() - startedAt < 1000);
    // Keep the fixture alive until any in-flight open from the aborted setup
    // path has a chance to settle against the still-present file.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("legacy entry points delegate cancellation to the unified transfer engine", () => {
    const src = fs.readFileSync(path.join(__dirname, "../sftpBridge.cjs"), "utf8");
    assert.doesNotMatch(src, /cancelledFlag/);
    assert.match(
      src,
      /async function downloadSftpToLocal\(_event, payload\) \{\s*return runUnifiedSftpTransfer\(payload, "download"\);\s*\}/,
    );
    assert.match(
      src,
      /async function uploadLocalToSftp\(_event, payload\) \{\s*return runUnifiedSftpTransfer\(payload, "upload"\);\s*\}/,
    );
    const unifiedIdx = src.indexOf("async function runUnifiedSftpTransfer");
    const unifiedBlock = src.slice(unifiedIdx, src.indexOf("async function downloadSftpToLocal", unifiedIdx));
    assert.match(unifiedBlock, /transferBridge\.startTransfer/);
    assert.match(unifiedBlock, /transferBridge\.cancelTransfer/);
  });
});
