"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { pack } = require("tar-stream");
const { downloadPacked, extractArchive, publish } = require("./packedDownload.cjs");
const tempDirBridge = require("../tempDirBridge.cjs");

async function fixture(t) {
  const dir = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "netcatty-pack-qa-")));
  const previousTempDir = tempDirBridge.getCustomTempDir();
  tempDirBridge.applyCustomTempDir(path.join(dir, "managed"));
  t.after(() => tempDirBridge.applyCustomTempDir(previousTempDir));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const stage = path.join(dir, "stage"), local = path.join(dir, "local"), file = path.join(dir, "archive");
  await fsp.mkdir(stage);
  await fsp.mkdir(local);
  return {
    dir, stage, local, file,
    async archive(items) {
      const archive = pack(), copying = pipeline(archive, fs.createWriteStream(file));
      for (const [header, contents] of items) archive.entry(header, contents ?? Buffer.alloc(0));
      archive.finalize();
      await copying;
    },
    extract(names) { return extractArchive(file, stage, false, names, new AbortController().signal); },
  };
}

test("hostile packed downloads reject traversal, malicious links, unexpected names, duplicate roots and special files", async t => {
  const directory = { name: "compose/", type: "directory" };
  for (const bad of [
    { name: "compose/../escape" }, { name: "/escape" }, { name: "other.txt" }, directory,
    { name: "compose/bad", type: "symlink", linkname: "../../escape" },
    { name: "compose/bad", type: "symlink", linkname: "/tmp" },
    { name: "compose/bad", type: "link", linkname: "compose/not-a-regular-file" },
    { name: "compose/bad", type: "fifo" },
  ]) {
    await t.test(bad.name + ":" + bad.type, async tt => {
      const f = await fixture(tt);
      await f.archive([[directory], [bad]]);
      await assert.rejects(f.extract(["compose"]), /archive|outside the downloaded selection|symbolic link|hard link|special file/i);
      assert.equal(fs.existsSync(path.join(f.dir, "escape")), false);
    });
  }
  await t.test("never follows a safe symlink for a later write", async tt => {
    const f = await fixture(tt);
    await f.archive([[directory], [{ name: "compose/real", type: "directory" }],
      [{ name: "compose/alias", type: "symlink", linkname: "real" }], [{ name: "compose/alias/injected" }, "oops"]]);
    await assert.rejects(f.extract(["compose"]), /unsafe parent/);
    assert.equal(fs.existsSync(path.join(f.stage, "compose", "real", "injected")), false);
  });
});

test("truncated archive with finished file data cannot publish", async t => {
  const f = await fixture(t);
  await f.archive([[{ name: "compose", type: "directory" }], [{ name: "compose/a" }, "data"]]);
  await fsp.truncate(f.file, (await fsp.stat(f.file)).size - 512);
  await assert.rejects(f.extract(["compose"]), /incomplete|unexpected end/i);
  assert.deepEqual(await fsp.readdir(f.local), []);
});

test("on default macOS volume, aliased names cannot overwrite independent files", { skip: process.platform !== "darwin" }, async t => {
  const f = await fixture(t);
  await fsp.writeFile(path.join(f.dir, "alias"), "");
  if (!fs.existsSync(path.join(f.dir, "ALIAS"))) { t.skip("case-sensitive volume"); return; }
  await f.archive([[{ name: "compose", type: "directory" }], [{ name: "compose/Config" }, "one"], [{ name: "compose/config" }, "two"]]);
  await assert.rejects(f.extract(["compose"]), {code: "EEXIST"});
  assert.equal(await fsp.readFile(path.join(f.stage, "compose", "Config"), "utf8"), "one");
});

test("rollback never deletes foreign files added to a concurrently published directory", async t => {
  const f = await fixture(t);
  await f.archive([[{ name: "a", type: "directory" }], [{ name: "a/owned" }, "app"], [{ name: "b", type: "directory" }]]);
  const manifest = await f.extract(["a", "b"]);
  const rename = fsp.rename.bind(fsp);
  t.mock.method(fsp, "rename", async (from, to) => {
    if (to === path.join(f.local, "b")) {
      await fsp.writeFile(path.join(f.local, "a", "other-app"), "external");
      await fsp.writeFile(path.join(f.local, "b", "other-app"), "external");
    }
    return rename(from, to);
  });
  assert.deepEqual(await publish(f.stage, f.local, ["a", "b"], new AbortController().signal, manifest), { status: "fallback", reason: "conflict" });
  for (const name of ["a", "b"]) {
    assert.deepEqual(await fsp.readdir(path.join(f.local, name)), ["other-app"]);
    assert.equal(await fsp.readFile(path.join(f.local, name, "other-app"), "utf8"), "external");
  }
});

test("SFTP-only and unrepresentable shell selections fall back before touching local or remote files", async t => {
  const f = await fixture(t);
  const requests = [["compose"], ["weird\nname"], Array.from({ length: 1001 }, (_, i) => String(i))];
  for (const names of requests) {
    const result = await downloadPacked({ client: { client: { exec: () => assert.fail("no archive command") } },
      payload: { sftpId: "s", names, remoteDirectory: "/srv", localDirectory: f.local, transferId: "restricted" },
      encoding: "utf-8", execProbe: async () => { throw new Error("Unable to exec"); } });
    assert.deepEqual(result, { status: "fallback", reason: "unsupported" });
  }
  assert.deepEqual(await fsp.readdir(f.local), []);
});

test("valid parent-relative links fall back only after complete archive validation and cleanup", { skip: process.platform === "win32" }, async t => {
  const { PassThrough } = require("node:stream");
  for (const variant of ["supported-fallback", "truncated", "traversal"]) {
    await t.test(variant, async tt => {
      const f = await fixture(tt);
      const items = [
        [{ name: "compose", type: "directory" }],
        [{ name: "compose/sub", type: "directory" }],
        [{ name: "compose/config" }, "settings"],
        [{ name: "compose/sub/link", type: "symlink", linkname: "../config" }],
      ];
      if (variant === "traversal") items.push([{ name: "compose/../../escape" }, "bad"]);
      await f.archive(items);
      let data = await fsp.readFile(f.file);
      if (variant === "truncated") data = data.subarray(0, data.length - 512);
      const client = { client: { exec(_command, callback) {
        const channel = new PassThrough();
        channel.stderr = new PassThrough();
        channel.close = () => channel.destroy();
        callback(null, channel);
        setImmediate(() => { channel.emit("exit", 0); channel.end(data); });
      } } };
      const download = downloadPacked({ client,
        payload: { sftpId: "s", names: ["compose"], remoteDirectory: "/srv", localDirectory: f.local, transferId: variant },
        encoding: "utf-8", execProbe: async () => ({ stdout: "NC_PACK_TAR" }),
      });
      if (variant === "supported-fallback") assert.deepEqual(await download, { status: "fallback", reason: "unsupported" });
      else await assert.rejects(download, /incomplete|unexpected end|archive path/i);
      assert.deepEqual(await fsp.readdir(f.local), [], "no staged files or partially published directory");
      assert.deepEqual(await fsp.readdir(tempDirBridge.getTempDir()), [".netcatty-managed-temp"], "fallback and errors clean managed scratch data");
    });
  }
});

test("packed lease owners clean up queued and active downloads when their renderer is gone", async t => {
  const { EventEmitter } = require("node:events");
  const { createRendererLeaseHandlers } = require("./packedDownload.cjs");
  for (const lifecycle of ["destroyed", "render-process-gone", "reload"]) {
    await t.test(lifecycle, async () => {
      const sender = new EventEmitter();
      sender.id = 7;
      sender.isDestroyed = () => false;
      const event = { sender }, retained = new Set(), cancelled = [], released = [];
      let finishRetain;
      const handlers = createRendererLeaseHandlers({
        retain: async (_event, payload) => {
          if (payload.leaseId === "queued") await new Promise(resolve => { finishRetain = resolve; });
          retained.add(payload.leaseId);
          return { success: true };
        },
        cancel: async (_event, payload) => { cancelled.push(payload.leaseId); },
        release: async (_event, payload) => { retained.delete(payload.leaseId); released.push(payload.leaseId); },
      });
      const payload = { sftpId: "s", leaseId: "active", cancelOnOwnerGone: true };
      assert.deepEqual(await handlers.retain(event, payload), { success: true });
      const pending = handlers.retain(event, { ...payload, leaseId: "queued" });
      await new Promise(resolve => setImmediate(resolve));
      sender.emit("did-start-navigation", {}, "app://netcatty/#/settings", true, true);
      sender.emit("did-start-navigation", {}, "https://example.test", false, false);
      assert.deepEqual(cancelled, [], "hash/iframe navigation keeps downloads running");
      if (lifecycle === "reload") sender.emit("did-start-navigation", {}, "app://netcatty/", false, true);
      else sender.emit(lifecycle);
      finishRetain();
      assert.equal((await pending).success, false, "a vanished renderer cannot launch the queued operation");
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual([...retained], []);
      assert.deepEqual(cancelled.sort(), ["active", "queued"]);
      assert.deepEqual(released.sort(), ["active", "queued"]);
      for (const name of ["destroyed", "render-process-gone", "did-start-navigation"]) assert.equal(sender.listenerCount(name), 0);
    });
  }
});

test("normal packed lease release detaches shared owner listeners and leaves ordinary leases unchanged", async () => {
  const { EventEmitter } = require("node:events");
  const { createRendererLeaseHandlers } = require("./packedDownload.cjs");
  const sender = new EventEmitter();
  sender.id = 8;
  const event = { sender }, cancelled = [], released = [];
  const handlers = createRendererLeaseHandlers({
    retain: async () => ({ success: true }),
    release: async (_event, payload) => { released.push(payload.leaseId); },
    cancel: async (_event, payload) => { cancelled.push(payload.leaseId); },
  });
  await handlers.retain(event, { sftpId: "s", leaseId: "ordinary" });
  assert.equal(sender.listenerCount("destroyed"), 0);
  for (let i = 0; i < 20; i++) await handlers.retain(event, { sftpId: "s", leaseId: String(i), cancelOnOwnerGone: true });
  assert.equal(sender.listenerCount("destroyed"), 1, "queued downloads share one renderer listener");
  for (let i = 0; i < 20; i++) await handlers.release(event, { sftpId: "s", leaseId: String(i) });
  assert.equal(sender.listenerCount("destroyed"), 0);
  sender.emit("destroyed");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(cancelled, []);
  assert.equal(released.length, 20);
});

test("worker-mode retained packed lease forwards owner cancellation and release to the owning worker", async () => {
  const { EventEmitter } = require("node:events");
  const bridge = require("../transferBridge.cjs");
  const handlers = new Map(), requests = [];
  bridge.registerHandlers({ handle(channel, fn) { handlers.set(channel, fn); } }, {
    terminalWorkerManager: { async request(channel, payload, options) {
      requests.push({ channel, payload, options });
      return { success: true };
    } },
  });
  const sender = new EventEmitter();
  sender.id = 71;
  await handlers.get("netcatty:transfer:retain-sftp-session")({ sender }, {
    sftpId: "s", leaseId: "packed", cancelOnOwnerGone: true,
  });
  sender.emit("destroyed");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests.map(r => r.channel), [
    "netcatty:transfer:retain-sftp-session", "netcatty:sftp:cancelPacked", "netcatty:transfer:release-sftp-session",
  ]);
  assert.deepEqual(requests[1].payload, { transferId: "packed" });
  assert.ok(requests.every(r => r.options.webContentsId === 71));
});

test("packed backend releases its session lease without waiting for a renderer finally block", async t => {
  const bridge = require("../sftpBridge.cjs");
  const transfers = require("../transferBridge.cjs");
  const packed = require("./packedDownload.cjs");
  const previousClients = bridge.getSftpClients();
  bridge.init({ sftpClients: new Map([["s", {}]]), sessions: new Map() });
  t.after(() => bridge.init({ sftpClients: previousClients }));
  const leases = [];
  t.mock.method(transfers, "retainSftpTransferSession", (_event, lease) => { leases.push(lease); return { success: true }; });
  t.mock.method(transfers, "releaseSftpTransferSession", (_event, lease) => { assert.deepEqual(leases.pop(), lease); });
  let fail = false;
  t.mock.method(packed, "downloadPacked", async () => {
    if (fail) throw new Error("archive rejected");
    return { status: "completed" };
  });
  const handlers = new Map();
  bridge.registerHandlers({ handle(channel, fn) { handlers.set(channel, fn); } });
  const run = () => handlers.get("netcatty:sftp:downloadPacked")({ sender: { id: 7 } }, { sftpId: "s", transferId: "p" });
  assert.deepEqual(await run(), { status: "completed" });
  assert.equal(leases.length, 0);
  fail = true;
  await assert.rejects(run(), /archive rejected/);
  assert.equal(leases.length, 0);
});


test("unsupported connections fall back before packed destination conflicts", async t => {
  const f = await fixture(t);
  await fsp.mkdir(path.join(f.local, "compose"));
  await fsp.writeFile(path.join(f.local, "compose", "keep"), "original");
  for (const kind of ["encoding", "single-channel", "sudo", "no-exec", "sftp-only", "no-tar"]) {
    let probes = 0;
    const ssh = { exec() { assert.fail("archive exec must not run"); } };
    const client = { client: kind === "no-exec" ? {} : ssh,
      __netcattySingleChannelSsh: kind === "single-channel", __netcattySudoMode: kind === "sudo" };
    const result = await downloadPacked({ client,
      payload: { sftpId: "s", names: ["compose"], remoteDirectory: "/srv", localDirectory: f.local, transferId: kind },
      encoding: kind === "encoding" ? "gbk" : "utf-8",
      execProbe: async () => { probes++; if (kind === "sftp-only") throw new Error("Unable to exec"); return { stdout: "" }; },
    });
    assert.deepEqual(result, { status: "fallback", reason: "unsupported" }, kind);
    assert.equal(probes, ["sftp-only", "no-tar"].includes(kind) ? 1 : 0);
  }
  assert.equal(await fsp.readFile(path.join(f.local, "compose", "keep"), "utf8"), "original");
  assert.deepEqual((await fsp.readdir(tempDirBridge.getTempDir())).filter(n => !n.startsWith(".netcatty")), []);
});

function simulateDifferentDisk(t, destination) {
  const stat = fsp.stat.bind(fsp);
  t.mock.method(fsp, "stat", async (file, ...args) => {
    const result = await stat(file, ...args);
    if (file === destination) result.dev += 1;
    return result;
  });
}

test("managed staging publishes validated content across filesystems without remote retransmission", async t => {
  const f = await fixture(t);
  await f.archive([
    [{ name: "compose", type: "directory" }],
    [{ name: "compose/empty", type: "directory" }],
    [{ name: "compose/.env", mode: 0o640 }, "hidden"],
    [{ name: "compose/config" }, Buffer.from([0, 255, 13, 10])],
    [{ name: "compose/alias", type: "symlink", linkname: "config" }],
    [{ name: "single" }, "sibling"],
  ]);
  const manifest = await f.extract(["compose", "single"]);
  simulateDifferentDisk(t, f.local);
  assert.deepEqual(await publish(f.stage, f.local, ["compose", "single"], new AbortController().signal, manifest), { status: "completed" });
  assert.deepEqual(await fsp.readdir(f.local), ["compose", "single"]);
  assert.deepEqual(await fsp.readdir(path.join(f.local, "compose", "empty")), []);
  assert.equal(await fsp.readFile(path.join(f.local, "compose", ".env"), "utf8"), "hidden");
  assert.deepEqual(await fsp.readFile(path.join(f.local, "compose", "config")), Buffer.from([0, 255, 13, 10]));
  assert.equal(await fsp.readlink(path.join(f.local, "compose", "alias")), "config");
  assert.equal(await fsp.readFile(path.join(f.local, "single"), "utf8"), "sibling");
});

test("cross-filesystem cancellation rolls back owned entries and preserves a concurrently added file", async t => {
  const f = await fixture(t);
  await f.archive([[{ name: "compose", type: "directory" }], [{ name: "compose/data" }, "payload"]]);
  const manifest = await f.extract(["compose"]);
  simulateDifferentDisk(t, f.local);
  const controller = new AbortController();
  const createReadStream = fs.createReadStream.bind(fs);
  t.mock.method(fs, "createReadStream", (file, options) => {
    if (file === path.join(f.stage, "compose", "data")) {
      fs.writeFileSync(path.join(f.local, "compose", "foreign"), "untouched");
      controller.abort();
    }
    return createReadStream(file, options);
  });
  await assert.rejects(publish(f.stage, f.local, ["compose"], controller.signal, manifest), /abort/i);
  assert.deepEqual(await fsp.readdir(path.join(f.local, "compose")), ["foreign"]);
  assert.equal(await fsp.readFile(path.join(f.local, "compose", "foreign"), "utf8"), "untouched");
});

test("cross-filesystem destination conflict never overwrites existing files", async t => {
  const f = await fixture(t);
  await f.archive([[{ name: "first" }, "download"], [{ name: "second", type: "directory" }]]);
  const manifest = await f.extract(["first", "second"]);
  await fsp.mkdir(path.join(f.local, "second"));
  await fsp.writeFile(path.join(f.local, "second", "keep"), "untouched");
  simulateDifferentDisk(t, f.local);
  assert.deepEqual(await publish(f.stage, f.local, ["first", "second"], new AbortController().signal, manifest), { status: "fallback", reason: "conflict" });
  assert.deepEqual(await fsp.readdir(f.local), ["second"]);
  assert.equal(await fsp.readFile(path.join(f.local, "second", "keep"), "utf8"), "untouched");
});


test("packed download uses managed staging and cleans it after completion or cancellation", { skip: process.platform === "win32" }, async t => {
  const { PassThrough } = require("node:stream");
  const { cancelActive } = require("./packedDownload.cjs");
  for (const cancel of [false, true]) {
    await t.test(cancel ? "cancel" : "complete", async tt => {
      const f = await fixture(tt);
      await f.archive([[{ name: "compose", type: "directory" }], [{ name: "compose/.env" }, "settings"]]);
      const data = await fsp.readFile(f.file);
      let channel, start;
      const started = new Promise(resolve => { start = resolve; });
      const client = { client: { exec(_command, callback) {
        channel = new PassThrough();
        channel.stderr = new PassThrough();
        channel.close = () => channel.destroy();
        callback(null, channel);
        start();
      } } };
      const transferId = cancel ? "managed-cancel" : "managed-complete";
      const download = downloadPacked({ client,
        payload: { transferId, names: ["compose"], remoteDirectory: "/srv", localDirectory: f.local },
        encoding: "utf-8", execProbe: async () => ({ stdout: "NC_PACK_TAR" }),
      });
      await started;
      const workspaces = (await fsp.readdir(tempDirBridge.getTempDir())).filter(name => name.includes("active-workspace"));
      assert.equal(workspaces.length, 1);
      assert.deepEqual(await fsp.readdir(f.local), [], "staging never appears alongside destination files");
      assert.deepEqual(await tempDirBridge.clearTempDir(), { deletedCount: 0, failedCount: 0 });
      if (cancel) cancelActive(transferId);
      else { channel.emit("exit", 0); channel.end(data); }
      assert.deepEqual(await download, { status: cancel ? "cancelled" : "completed" });
      assert.deepEqual(await fsp.readdir(tempDirBridge.getTempDir()), [".netcatty-managed-temp"]);
      if (!cancel) assert.equal(await fsp.readFile(path.join(f.local, "compose", ".env"), "utf8"), "settings");
    });
  }
});


test("cross-filesystem rollback distinguishes copied bytes from concurrent edits to the same inode", async t => {
  for (const variant of ["edit-before-write", "same-size-edit", "owned-partial-copy"]) {
    await t.test(variant, async tt => {
      const f = await fixture(tt);
      await f.archive([[{ name: "compose", type: "directory" }], [{ name: "compose/data" }, Buffer.alloc(128 * 1024, "d")]]);
      const manifest = await f.extract(["compose"]);
      simulateDifferentDisk(tt, f.local);
      const controller = new AbortController();
      const from = path.join(f.stage, "compose", "data"), to = path.join(f.local, "compose", "data");
      let edited;
      if (variant === "edit-before-write") {
        const createReadStream = fs.createReadStream.bind(fs);
        tt.mock.method(fs, "createReadStream", (file, options) => {
          if (file === from) { edited = "USER EDIT"; fs.writeFileSync(to, edited); controller.abort(); }
          return createReadStream(file, options);
        });
      } else {
        const open = fsp.open.bind(fsp);
        tt.mock.method(fsp, "open", async (file, flags, ...args) => {
          const handle = await open(file, flags, ...args);
          if (file === to && flags === "wx") {
            const write = handle.write.bind(handle);
            handle.write = async (...writeArgs) => {
              const result = await write(...writeArgs);
              if (variant === "same-size-edit") { edited = "U".repeat(result.bytesWritten); await fsp.writeFile(to, edited); }
              controller.abort();
              return result;
            };
          }
          return handle;
        });
      }
      await assert.rejects(publish(f.stage, f.local, ["compose"], controller.signal, manifest), /abort/i);
      if (edited) assert.equal(await fsp.readFile(to, "utf8"), edited, "never delete external edits to our reserved inode");
      else assert.deepEqual(await fsp.readdir(f.local), [], "an unchanged partial copy is still cleaned");
    });
  }
});

test("silent real SSH archive channels cancel promptly without closing the shared SSH connection", {
  skip: process.platform === "win32", timeout: 10_000,
}, async t => {
  const { Client, Server, utils } = require("ssh2");
  const { generateKeyPairSync, createHash, randomBytes } = require("node:crypto");
  const { cancelActive } = require("./packedDownload.cjs");
  const f = await fixture(t);
  await f.archive([[{ name: "compose", type: "directory" }], [{ name: "compose/.env" }, "settings"]]);
  const data = await fsp.readFile(f.file);
  const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
  const fingerprint = createHash("sha256").update(utils.parseKey(hostKey).getPublicSSH()).digest("hex");
  const password = randomBytes(16).toString("hex"), connections = new Set();
  let firstExec = true;
  const server = new Server({ hostKeys: [hostKey] }, connection => {
    connections.add(connection);
    connection.on("close", () => connections.delete(connection));
    connection.on("error", () => {});
    connection.on("authentication", context => {
      if (context.method === "password" && context.username === "packed-test" && context.password === password) context.accept();
      else context.reject();
    });
    connection.on("ready", () => connection.on("session", accept => {
      accept().on("exec", (acceptExec, _reject, info) => {
        const channel = acceptExec();
        channel.on("error", () => {});
        if (firstExec) { firstExec = false; return; } // No output, exit status or application-initiated close.
        channel.exit(0);
        channel.end(info.command === "still-connected" ? Buffer.from("ok") : data);
      });
    }));
  });
  const ssh = new Client();
  t.after(async () => {
    ssh.destroy();
    for (const connection of connections) connection.end();
    await new Promise(resolve => server.close(resolve));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  await new Promise((resolve, reject) => {
    ssh.once("ready", resolve);
    ssh.once("error", reject);
    ssh.connect({ host: "127.0.0.1", port: server.address().port, username: "packed-test", password,
      hostHash: "sha256", hostVerifier: hash => hash === fingerprint, readyTimeout: 3000 });
  });
  let opened;
  const channelOpened = new Promise(resolve => { opened = resolve; });
  const client = { client: { exec(command, callback) {
    ssh.exec(command, (error, channel) => { callback(error, channel); opened(); });
  } } };
  const request = transferId => downloadPacked({ client,
    payload: { transferId, names: ["compose"], remoteDirectory: "/srv", localDirectory: f.local },
    encoding: "utf-8", execProbe: async () => ({ stdout: "NC_PACK_TAR" }),
  });
  const pending = request("silent-channel");
  await channelOpened;
  assert.equal(cancelActive("silent-channel"), true);
  let timer;
  const result = await Promise.race([
    pending,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Cancellation waited for the silent SSH peer")), 1500); }),
  ]).finally(() => clearTimeout(timer));
  assert.deepEqual(result, { status: "cancelled" });
  assert.deepEqual(await fsp.readdir(f.local), []);
  assert.deepEqual(await fsp.readdir(tempDirBridge.getTempDir()), [".netcatty-managed-temp"]);
  const output = await new Promise((resolve, reject) => ssh.exec("still-connected", (error, channel) => {
    if (error) { reject(error); return; }
    let stdout = "";
    channel.on("data", chunk => { stdout += chunk; });
    channel.on("error", reject);
    channel.on("close", code => code === 0 ? resolve(stdout) : reject(new Error("Shared SSH connection failed")));
  }));
  assert.equal(output, "ok");
  assert.deepEqual(await request("next-download"), { status: "completed" });
  assert.equal(await fsp.readFile(path.join(f.local, "compose", ".env"), "utf8"), "settings");
  assert.deepEqual(await fsp.readdir(tempDirBridge.getTempDir()), [".netcatty-managed-temp"]);
});
