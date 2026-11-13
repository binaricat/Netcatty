"use strict";

const assert = require("node:assert/strict");
const { createHash, generateKeyPairSync, randomBytes } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const test = require("node:test");
const { Client, Server, utils } = require("ssh2");
const { createFileOpsApi } = require("./fileOps.cjs");
const { _execRemoteShellCommandForTests: execRemoteShellCommand } = require("../sftpBridge.cjs");

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

/** A real encrypted loopback SSH transport; exec runs only inside our fixture. */
async function connectFixture(t) {
  const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
  const hostFingerprint = createHash("sha256").update(utils.parseKey(hostKey).getPublicSSH()).digest("hex");
  const password = randomBytes(16).toString("hex");
  const connections = new Set();
  const children = new Set();
  const fixture = { env: process.env, commands: 0 };
  const server = new Server({ hostKeys: [hostKey] }, (connection) => {
    connections.add(connection);
    connection.on("close", () => connections.delete(connection));
    connection.on("error", () => {});
    connection.on("authentication", (context) => {
      if (context.method === "password" && context.username === "archive-test" && context.password === password) context.accept();
      else context.reject();
    });
    connection.on("ready", () => connection.on("session", (accept) => {
      const session = accept();
      session.on("exec", (acceptExec, _reject, info) => {
        fixture.commands += 1;
        const channel = acceptExec();
        const child = spawn("/bin/sh", ["-c", info.command], { env: fixture.env, stdio: ["ignore", "pipe", "pipe"] });
        children.add(child);
        child.stdout.pipe(channel, { end: false });
        child.stderr.pipe(channel.stderr, { end: false });
        channel.on("error", () => {});
        child.on("error", (error) => {
          channel.stderr.write(error.message);
          channel.exit(127);
          channel.end(() => channel.close());
        });
        child.on("close", (code) => {
          children.delete(child);
          channel.exit(code ?? 1);
          channel.end(() => channel.close());
        });
        channel.on("close", () => { if (child.exitCode === null) child.kill("SIGKILL"); });
      });
    }));
  });
  const client = new Client();
  t.after(async () => {
    client.destroy();
    for (const child of children) child.kill("SIGKILL");
    for (const connection of connections) connection.end();
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) => {
    client.once("ready", resolve);
    client.once("error", reject);
    client.connect({
      host: "127.0.0.1",
      port: server.address().port,
      username: "archive-test",
      password,
      hostHash: "sha256",
      hostVerifier: (hash) => hash === hostFingerprint,
      readyTimeout: 5000,
    });
  });
  const api = createFileOpsApi({
    sftpClients: new Map([["loopback", { client }]]),
    resolveEncodingForRequest: () => "utf-8",
    throwIfAborted(signal) { if (signal?.aborted) throw new Error("Aborted"); },
    execRemoteShellCommand,
  });
  return { ...fixture, client, setEnv: (env) => { fixture.env = env; }, getCommandCount: () => fixture.commands, api };
}

test("archive creation traverses real SSH, preserves payloads, and handles conflict/replace/failure", {
  skip: process.platform === "win32",
  timeout: 30_000,
}, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-archive-ssh-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, "folder"));
  const binary = randomBytes(65_537);
  fs.writeFileSync(path.join(directory, "folder", "binary.bin"), binary);
  const sourceName = "\u4e2d\u6587 ' $(touch should-not-exist).txt";
  fs.writeFileSync(path.join(directory, sourceName), "before replacement");
  const { api, setEnv, getCommandCount } = await connectFixture(t);
  for (const format of ["tar.gz", "zip"]) {
    const archiveName = `transport.${format}`;
    const options = { directory, paths: [sourceName, "folder"], archiveName, format };
    const invoke = (patch = {}) => api.createSftpArchive(null, { sftpId: "loopback", options: { ...options, ...patch } });
    assert.deepEqual(await invoke(), { success: true });
    const archivePath = path.join(directory, archiveName);
    const firstDigest = sha256(archivePath);
    fs.writeFileSync(path.join(directory, sourceName), `after replacement ${format}`);
    assert.equal((await invoke()).code, "EEXIST");
    assert.equal(sha256(archivePath), firstDigest);
    assert.deepEqual(await invoke({ overwrite: true }), { success: true });
    assert.notEqual(sha256(archivePath), firstDigest);
    const unpacked = path.join(directory, `unpacked-${format}`);
    fs.mkdirSync(unpacked);
    const unpack = format === "zip"
      ? spawnSync("unzip", ["-q", archivePath, "-d", unpacked], { encoding: "utf8" })
      : spawnSync("tar", ["-xzf", archivePath, "-C", unpacked], { encoding: "utf8" });
    assert.equal(unpack.status, 0, unpack.stderr);
    assert.deepEqual(fs.readFileSync(path.join(unpacked, "folder", "binary.bin")), binary);
    assert.equal(fs.readFileSync(path.join(unpacked, sourceName), "utf8"), `after replacement ${format}`);
    assert.equal(fs.existsSync(path.join(directory, "should-not-exist")), false);
    const completedDigest = sha256(archivePath);
    await assert.rejects(() => invoke({ overwrite: true, paths: ["missing"] }), /source no longer exists/);
    assert.equal(sha256(archivePath), completedDigest);
    setEnv({ ...process.env, PATH: directory });
    await assert.rejects(() => invoke({ overwrite: true }), /is not installed on the remote host/);
    setEnv(process.env);
    assert.equal(sha256(archivePath), completedDigest);
    assert.deepEqual(fs.readdirSync(directory).filter((entry) => entry.startsWith(".netcatty-archive.")), []);
  }
  assert.equal(getCommandCount(), 10);
});

test("packed SSH download restores selected roots with gzip or plain tar, without creating a remote archive", {
  skip: process.platform === "win32", timeout: 30_000,
}, async (t) => {
  const { downloadPacked, cancelActive } = require("./packedDownload.cjs");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-download-ssh-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const remote = path.join(tmp, "remote"), tools = path.join(tmp, "tools");
  const dir = "compose '$(touch injected)", single = "notes.txt";
  fs.mkdirSync(path.join(remote, dir, "空目录"), { recursive: true });
  fs.writeFileSync(path.join(remote, dir, ".env"), "hidden");
  fs.writeFileSync(path.join(remote, single), randomBytes(12_345));
  fs.mkdirSync(tools);
  const { client, setEnv } = await connectFixture(t);
  const shell = { client };
  for (const mode of ["gzip", "tar", "unsupported", "cancelled", "conflict"]) {
    const localDirectory = path.join(tmp, mode);
    fs.mkdirSync(localDirectory);
    if (mode === "tar" || mode === "unsupported") {
      fs.writeFileSync(path.join(tools, "tar"), mode === "tar"
        ? '#!/bin/sh\ncase "$1" in *z*) exit 1 ;; esac\nexec /usr/bin/tar "$@"\n'
        : "#!/bin/sh\nexit 127\n", { mode: 0o700 });
      setEnv({ ...process.env, PATH: tools });
    } else setEnv(process.env);
    if (mode === "conflict") fs.writeFileSync(path.join(localDirectory, single), "original");
    const names = mode === "gzip" ? [dir] : [dir, single], phases = [];
    const result = await downloadPacked({
      client: shell, payload: { names, remoteDirectory: remote, localDirectory, sftpId: "s", transferId: mode },
      encoding: "utf-8", execProbe: execRemoteShellCommand,
      event: { sender: { isDestroyed: () => false, send(_channel, {phase}) {
        phases.push(phase);
        if (mode === "cancelled" && phase === "extracting") cancelActive(mode);
      } } },
    });
    if (mode === "gzip" || mode === "tar") {
      assert.deepEqual(result, { status: "completed" });
      assert.equal(fs.readFileSync(path.join(localDirectory, dir, ".env"), "utf8"), "hidden");
      assert.deepEqual(fs.readdirSync(path.join(localDirectory, dir, "空目录")), []);
      if (names.includes(single)) assert.equal(sha256(path.join(localDirectory, single)), sha256(path.join(remote, single)));
      assert.deepEqual(fs.readdirSync(localDirectory).sort(), [...names].sort());
      assert.ok(phases.includes("receiving") && phases.includes("extracting"));
    } else if (mode === "conflict") {
      assert.deepEqual(result, { status: "fallback", reason: "conflict" });
      assert.equal(fs.readFileSync(path.join(localDirectory, single), "utf8"), "original");
      assert.deepEqual(fs.readdirSync(localDirectory), [single]);
    } else {
      assert.deepEqual(result, mode === "cancelled" ? { status: "cancelled" } : { status: "fallback", reason: "unsupported" });
      assert.deepEqual(fs.readdirSync(localDirectory), []);
    }
    assert.deepEqual(fs.readdirSync(remote).sort(), [dir, single].sort());
  }
});
