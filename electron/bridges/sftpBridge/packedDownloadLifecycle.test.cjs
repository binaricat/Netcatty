"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createPackedDownloadLifecycle } = require("./packedDownloadLifecycle.cjs");

function sender(id) {
  return Object.assign(new EventEmitter(), { id, sent: [], isDestroyed: () => false,
    send(channel, payload) { this.sent.push({ channel, payload }); } });
}
function fixture(cancel = async () => {}) {
  const windows = [sender(1), sender(2)];
  const lifecycle = createPackedDownloadLifecycle({ cancel, broadcast(update) {
    for (const window of windows) window.send("netcatty:sftp:global-transfer", update);
  } });
  const event = { sender: windows[1] };
  const metadata = { transferId: "pack", fileName: "2 items", sourcePath: "/srv", targetPath: "/downloads",
    sourceConnectionId: "ssh-2", sourceHostId: "host", packedTargetPaths: ["/downloads/a", "/downloads/b"] };
  const request = { transferId: "pack", sftpId: "sftp-2", remoteDirectory: "/srv", names: ["a", "b"], localDirectory: "/downloads" };
  const events = (window) => window.sent.filter(x => x.channel === "netcatty:sftp:global-transfer").map(x => x.payload);
  return { windows, event, metadata, request, lifecycle, events };
}

test("detached packed queue, progress and completion reach every window with safe task metadata", async () => {
  const f = fixture();
  assert.deepEqual(f.lifecycle.register(f.event, f.metadata), { success: true });
  await f.lifecycle.run(f.event, f.request, async (event) => {
    event.sender.send("netcatty:sftp:packedProgress", { transferId: "pack", phase: "receiving", bytes: 7 });
    event.sender.send("netcatty:sftp:packedProgress", { transferId: "pack", phase: "extracting", bytes: 7 });
    return { status: "completed" };
  });
  assert.deepEqual(f.events(f.windows[0]), f.events(f.windows[1]));
  const events = f.events(f.windows[0]);
  assert.deepEqual(events.map(x => x.type), ["queued", "started", "progress", "progress", "completed"]);
  assert.equal(events.at(-1).totalBytes, 7);
  for (const event of events) {
    assert.equal(event.controlKind, "packed-download");
    assert.equal(event.resumable, false);
    assert.equal(event.retryable, false);
    assert.equal(event.sourceConnectionId, "ssh-2");
    assert.deepEqual(event.packedTargetPaths, ["/downloads/a", "/downloads/b"]);
  }
  assert.equal(f.lifecycle.has("pack"), false);
  assert.equal(f.windows[1].listenerCount("destroyed"), 0);
  // The renderer finally cleanup cannot turn a real completion into cancel.
  f.lifecycle.finish(f.event, { transferId: "pack", status: "cancelled" });
  assert.equal(f.events(f.windows[0]).at(-1).type, "completed");
});

test("cross-window cancellation of queued packed work prevents its later callback from starting", async () => {
  let cancels = 0, starts = 0;
  const f = fixture(async () => { cancels += 1; });
  f.lifecycle.register(f.event, f.metadata);
  assert.deepEqual(await f.lifecycle.cancel("pack"), { success: true });
  const result = await f.lifecycle.run(f.event, f.request, async () => { starts += 1; });
  assert.deepEqual(result, { status: "cancelled" });
  assert.equal(starts, 0);
  assert.equal(cancels, 0);
  assert.deepEqual(f.events(f.windows[0]).map(x => x.type), ["queued", "cancelled"]);
  assert.equal(f.lifecycle.has("pack"), false);
});

test("cross-window running cancel uses original owner and settles after the real stream", async () => {
  let finish, cancelledOwner;
  const f = fixture(async (event, id) => {
    cancelledOwner = event.sender.id;
    assert.equal(id, "pack");
    finish({ status: "cancelled" });
  });
  f.lifecycle.register(f.event, f.metadata);
  const running = f.lifecycle.run(f.event, f.request, () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  assert.deepEqual(await f.lifecycle.cancel("pack"), { success: true });
  await running;
  assert.equal(cancelledOwner, 2);
  assert.equal(f.events(f.windows[0]).at(-1).type, "cancelled");
});

test("completion wins a concurrent cancel after publishing and fallback dismisses all windows", async () => {
  let finish;
  const f = fixture(async () => finish({ status: "completed" }));
  f.lifecycle.register(f.event, f.metadata);
  const running = f.lifecycle.run(f.event, f.request, () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  await f.lifecycle.cancel("pack");
  await running;
  assert.equal(f.events(f.windows[0]).at(-1).type, "completed");
  f.lifecycle.register(f.event, { ...f.metadata, transferId: "fallback" });
  await f.lifecycle.run(f.event, { ...f.request, transferId: "fallback" }, async () => ({ status: "fallback", reason: "unsupported" }));
  assert.equal(f.events(f.windows[0]).at(-1).type, "dismissed");
  assert.equal(f.events(f.windows[1]).at(-1).type, "dismissed");
});

test("owner loss cancels queued and running packed jobs while preserving other owners", async () => {
  let finish, cancelledOwner;
  const f = fixture(async (event) => { cancelledOwner = event.sender.id; finish({ status: "cancelled" }); });
  f.lifecycle.register(f.event, f.metadata);
  f.lifecycle.register(f.event, { ...f.metadata, transferId: "queued" });
  f.lifecycle.register({ sender: f.windows[0] }, { ...f.metadata, transferId: "other" });
  const running = f.lifecycle.run(f.event, f.request, () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  f.windows[1].emit("render-process-gone");
  await running;
  assert.equal(cancelledOwner, 2);
  assert.equal(f.lifecycle.has("pack"), false);
  assert.equal(f.lifecycle.has("queued"), false);
  assert.equal(f.lifecycle.has("other"), true);
  assert.deepEqual(f.events(f.windows[0]).filter(x => x.type === "cancelled").map(x => x.transferId), ["queued", "pack"]);
});

test("committed publication wins owner loss and a reloaded owner keeps independent lifecycle listeners", async () => {
  let finish;
  const f = fixture(async () => finish({ status: "completed" }));
  f.lifecycle.register(f.event, f.metadata);
  const running = f.lifecycle.run(f.event, f.request, () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve();
  f.windows[1].emit("render-process-gone");
  assert.equal(f.events(f.windows[0]).at(-1).type, "started", "owner loss must wait for the committed result");
  f.lifecycle.register(f.event, { ...f.metadata, transferId: "after-reload" });
  await running;
  assert.equal(f.events(f.windows[0]).at(-1).type, "completed");
  assert.equal(f.lifecycle.has("pack"), false);
  assert.equal(f.lifecycle.has("after-reload"), true);
  assert.equal(f.windows[1].listenerCount("destroyed"), 1, "settling old work must not detach the new renderer's listeners");
  f.windows[1].emit("destroyed");
  assert.equal(f.events(f.windows[0]).at(-1).transferId, "after-reload");
  assert.equal(f.events(f.windows[0]).at(-1).type, "cancelled");
  assert.equal(f.lifecycle.has("after-reload"), false);
});

test("pre-start failures settle globally and worker exit cannot revive queued jobs", async () => {
  const f = fixture();
  f.lifecycle.register(f.event, f.metadata);
  assert.throws(() => f.lifecycle.finish({ sender: f.windows[0] }, { transferId: "pack", status: "failed" }), /another window/);
  f.lifecycle.finish(f.event, { transferId: "pack", status: "failed", error: "Lease failed" });
  assert.equal(f.events(f.windows[0]).at(-1).error, "Lease failed");
  f.lifecycle.register(f.event, f.metadata);
  f.lifecycle.workerExited(new Error("Worker stopped"));
  assert.deepEqual(await f.lifecycle.run(f.event, f.request, () => assert.fail("must not start")), { status: "cancelled" });
  assert.equal(f.events(f.windows[0]).at(-1).type, "failed");
  assert.equal(f.lifecycle.has("pack"), false);
});
