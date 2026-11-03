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

async function fixture(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "netcatty-pack-qa-"));
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

test("valid parent-relative links fall back only after complete archive validation and cleanup", async t => {
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
