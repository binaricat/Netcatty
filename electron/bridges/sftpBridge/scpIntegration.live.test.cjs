/**
 * Real OpenSSH SCP integration tests against a live host.
 *
 * Gated by env (or defaults for local interactive IT runs):
 *   NETCATTY_SCP_IT_HOST, NETCATTY_SCP_IT_USER, NETCATTY_SCP_IT_PASSWORD
 *   NETCATTY_SCP_IT_PORT (optional, default 22)
 *   NETCATTY_SCP_IT=1 to force-enable when password is set
 *
 * When host/password are unset, the suite skips (CI-safe).
 * When set, failures fail the suite — do not soft-skip mid-run.
 *
 * Credentials must NOT be hard-coded here; pass via env for the run.
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client: SSHClient } = require("ssh2");
const {
  createScpBackend,
  createSshExecAdapters,
} = require("./scpBackend.cjs");

const HOST = process.env.NETCATTY_SCP_IT_HOST || "";
const USER = process.env.NETCATTY_SCP_IT_USER || "root";
const PASSWORD = process.env.NETCATTY_SCP_IT_PASSWORD || "";
const PORT = Number(process.env.NETCATTY_SCP_IT_PORT || 22);
const ENABLED = process.env.NETCATTY_SCP_IT === "1"
  || (HOST && PASSWORD);

const remotePrefix = `/tmp/netcatty-scp-it-${Date.now()}-${process.pid}`;

function connectSsh() {
  return new Promise((resolve, reject) => {
    const client = new SSHClient();
    const timer = setTimeout(() => {
      try { client.end(); } catch { /* ignore */ }
      reject(new Error(`SSH connect timeout to ${HOST}:${PORT}`));
    }, 20000);
    client
      .on("ready", () => {
        clearTimeout(timer);
        resolve(client);
      })
      .on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      })
      .connect({
        host: HOST,
        port: PORT,
        username: USER,
        password: PASSWORD,
        readyTimeout: 15000,
        tryKeyboard: true,
        // Accept first-time host keys for IT environments
        hostVerifier: () => true,
      });
    client.on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
      finish(prompts.map(() => PASSWORD));
    });
  });
}

const suite = ENABLED ? describe : describe.skip;

suite("real OpenSSH SCP integration (shipped scpBackend)", () => {
  let ssh;
  let backend;
  let localTmp;

  before(async () => {
    assert.ok(HOST, "NETCATTY_SCP_IT_HOST required");
    assert.ok(PASSWORD, "NETCATTY_SCP_IT_PASSWORD required");
    localTmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-scp-it-local-"));
    ssh = await connectSsh();
    const adapters = createSshExecAdapters(ssh);
    backend = createScpBackend(adapters);
    await backend.mkdir(remotePrefix, { recursive: true });
  });

  after(async () => {
    try {
      if (backend) await backend.remove(remotePrefix, { recursive: true });
    } catch (err) {
      console.warn("[scp-it] cleanup remove failed:", err.message);
    }
    try {
      if (ssh) ssh.end();
    } catch { /* ignore */ }
    try {
      if (localTmp) fs.rmSync(localTmp, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  it("homeDir returns a non-empty path", async () => {
    const home = await backend.homeDir();
    assert.ok(home && home.length > 0, `homeDir empty: ${home}`);
    console.log("[scp-it] homeDir=", home);
  });

  it("mkdir + list shows created directory", async () => {
    const sub = `${remotePrefix}/subdir`;
    await backend.mkdir(sub, { recursive: true });
    const entries = await backend.list(remotePrefix);
    const names = entries.map((e) => e.name);
    console.log("[scp-it] list after mkdir:", names);
    assert.ok(names.includes("subdir"), `expected subdir in ${JSON.stringify(names)}`);
    const dir = entries.find((e) => e.name === "subdir");
    assert.equal(dir.type, "directory");
  });

  it("upload then download is byte-identical for binary payload", async () => {
    const payload = crypto.randomBytes(64 * 1024 + 17); // not power-of-two edge
    const localUp = path.join(localTmp, "payload.bin");
    const localDown = path.join(localTmp, "payload.down.bin");
    fs.writeFileSync(localUp, payload);
    const remoteFile = `${remotePrefix}/payload.bin`;

    const progress = [];
    await backend.uploadFile(localUp, remoteFile, {
      onProgress: (t, total) => progress.push([t, total]),
    });
    assert.ok(progress.length > 0, "expected upload progress callbacks");

    const entries = await backend.list(remotePrefix);
    assert.ok(entries.some((e) => e.name === "payload.bin"), "list missing uploaded file");

    await backend.downloadFile(remoteFile, localDown, {
      fileSize: payload.length,
    });
    const down = fs.readFileSync(localDown);
    const upHash = crypto.createHash("sha256").update(payload).digest("hex");
    const downHash = crypto.createHash("sha256").update(down).digest("hex");
    console.log("[scp-it] upload/download sha256", upHash, downHash, "bytes", down.length);
    assert.equal(down.length, payload.length);
    assert.equal(downHash, upHash);
  });

  it("uploadBuffer write path works for small text", async () => {
    const remoteFile = `${remotePrefix}/note.txt`;
    const body = Buffer.from("hello-scp-integration\nline2\n", "utf8");
    await backend.writeFile(remoteFile, body, { mode: 0o0644 });
    const read = await backend.readFile(remoteFile);
    assert.equal(read.toString("utf8"), body.toString("utf8"));
  });

  it("rename then delete leaves expected tree", async () => {
    const a = `${remotePrefix}/rename-a.txt`;
    const b = `${remotePrefix}/rename-b.txt`;
    await backend.writeFile(a, Buffer.from("rename-me\n"));
    await backend.rename(a, b);
    let entries = await backend.list(remotePrefix);
    let names = entries.map((e) => e.name);
    assert.ok(names.includes("rename-b.txt"), `after rename: ${JSON.stringify(names)}`);
    assert.ok(!names.includes("rename-a.txt"), `old name still present: ${JSON.stringify(names)}`);

    await backend.remove(b, { recursive: false });
    entries = await backend.list(remotePrefix);
    names = entries.map((e) => e.name);
    assert.ok(!names.includes("rename-b.txt"), `delete failed: ${JSON.stringify(names)}`);
    console.log("[scp-it] final names after rename/delete:", names);
  });

  it("stat reports size for uploaded file", async () => {
    const remoteFile = `${remotePrefix}/payload.bin`;
    // may already exist from earlier test; recreate if needed
    try {
      const st = await backend.stat(remoteFile);
      assert.ok(st.size > 0, `stat size ${st.size}`);
      assert.equal(st.isDirectory, false);
      console.log("[scp-it] stat", st);
    } catch {
      const localUp = path.join(localTmp, "stat.bin");
      fs.writeFileSync(localUp, Buffer.from("stat-payload"));
      await backend.uploadFile(localUp, remoteFile);
      const st = await backend.stat(remoteFile);
      assert.equal(st.size, 12);
    }
  });

  it("handles spaces in remote path for mkdir/upload/list/download/delete", async () => {
    const dir = `${remotePrefix}/dir with spaces`;
    const remoteFile = `${dir}/file with spaces.bin`;
    const payload = Buffer.from("space-path-payload-ok");
    const localUp = path.join(localTmp, "spaces-up.bin");
    const localDown = path.join(localTmp, "spaces-down.bin");
    fs.writeFileSync(localUp, payload);

    await backend.mkdir(dir, { recursive: true });
    await backend.uploadFile(localUp, remoteFile);
    const entries = await backend.list(dir);
    const names = entries.map((e) => e.name);
    console.log("[scp-it] space path list:", names);
    assert.ok(names.includes("file with spaces.bin"), `list: ${JSON.stringify(names)}`);

    await backend.downloadFile(remoteFile, localDown);
    assert.equal(fs.readFileSync(localDown).toString(), payload.toString());

    await backend.remove(remoteFile);
    const after = (await backend.list(dir)).map((e) => e.name);
    assert.ok(!after.includes("file with spaces.bin"), `still present: ${JSON.stringify(after)}`);
  });

  it("empty file upload/download round-trips", async () => {
    const remoteFile = `${remotePrefix}/empty.dat`;
    const localUp = path.join(localTmp, "empty.dat");
    const localDown = path.join(localTmp, "empty.down.dat");
    fs.writeFileSync(localUp, Buffer.alloc(0));
    await backend.uploadFile(localUp, remoteFile);
    await backend.downloadFile(remoteFile, localDown, { fileSize: 0 });
    assert.equal(fs.readFileSync(localDown).length, 0);
    const st = await backend.stat(remoteFile);
    assert.equal(st.size, 0);
  });

  it("directory symlink linkTarget is directory when target is a dir", async () => {
    const realDir = `${remotePrefix}/real-target-dir`;
    const linkPath = `${remotePrefix}/link-to-dir`;
    await backend.mkdir(realDir, { recursive: true });
    // Create symlink via shell (not part of SCP wire, but list must resolve it)
    const { exec } = createSshExecAdapters(ssh);
    const { shellQuote } = require("./scpShell.cjs");
    const ln = await exec(`ln -sfn ${shellQuote(realDir)} ${shellQuote(linkPath)}`);
    assert.equal(ln.code, 0, `ln failed: ${ln.stderr}`);
    const entries = await backend.list(remotePrefix);
    const link = entries.find((e) => e.name === "link-to-dir");
    console.log("[scp-it] symlink entry:", link);
    assert.ok(link, "symlink missing from list");
    assert.equal(link.type, "symlink");
    assert.equal(link.linkTarget, "directory");
  });
});
