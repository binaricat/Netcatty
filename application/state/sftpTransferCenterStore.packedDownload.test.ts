import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import type { TransferTask } from "../../domain/models";
import { findActivePathConflict } from "../../domain/sftpTransferConflicts";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";
import { createSftpTransferCenterStore } from "./sftpTransferCenterStore";
import { createTransferRuntime } from "./sftp/transferRuntime";
import { isTransferPauseLatched } from "./sftp/transferPauseLatch";
import { isTransferCancelledFlag } from "./sftp/transferCancelLatch";
import { globalSftpTransferScheduler } from "./sftp/globalTransferScheduler";

const require = createRequire(import.meta.url);
const { createPackedDownloadLifecycle } = require("../../electron/bridges/sftpBridge/packedDownloadLifecycle.cjs");

const makePackedTask = (id: string, status: TransferTask["status"] = "transferring"): TransferTask => ({
  id, fileName: "2 selected", sourcePath: "/srv", targetPath: "/downloads",
  sourceConnectionId: "captured-session", targetConnectionId: "local", sourceHostId: "host",
  packedTargetPaths: ["/downloads/compose", "/downloads/README.md"],
  direction: "download", status, totalBytes: 0, transferredBytes: 0, speed: 0,
  startTime: 1, isDirectory: true, controlKind: "packed-download", resumable: false, retryable: false,
});

test("pause then packed completion then resume cannot replay the common parent", async () => {
  const store = createSftpTransferCenterStore();
  const runtime = createTransferRuntime(store);
  const task = makePackedTask("packed-completion-race");
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => { finish = resolve; });
  let dedicatedCalls = 0;
  store.setDedicatedResumeHandler(async () => { dedicatedCalls++; return { success: true }; });
  runtime.enqueue([task]);
  const running = runtime.runWalk(task.id, async () => {
    await completed;
    runtime.patchTask(task.id, { status: "completed", transferredBytes: 128, totalBytes: 128, endTime: Date.now() });
  });
  try {
    await store.pause(task.id);
    assert.equal(store.getTask(task.id)?.status, "transferring");
    assert.equal(isTransferPauseLatched(task.id), false);
    finish();
    await running;
    assert.equal(runtime.isWalkInFlight(task.id), false);
    await store.resume(task.id);
    await store.retry(task.id);
    assert.equal(store.getTask(task.id)?.status, "completed");
    assert.equal(store.getTask(task.id)?.transferredBytes, 128);
    assert.equal(dedicatedCalls, 0, "the display-only /srv parent must never be resumed recursively");
    assert.equal(store.isResuming(task.id), false);
  } finally {
    finish();
    await running;
    store.dismiss(task.id);
  }
});

for (const status of ["queued", "transferring", "paused", "interrupted", "attention", "failed", "cancelled"] as const) {
  test(`programmatic controls cannot pause/resume/retry a ${status} packed task`, async (t) => {
    const store = createSftpTransferCenterStore();
    const task = { ...makePackedTask(`packed-${status}`, status), resumable: true, retryable: true };
    store.upsertTasks([task]);
    store.setDedicatedResumeHandler(async () => { assert.fail("dedicated replay is not supported"); });
    store.registerOwner("packed-owner", {
      pause: async () => { assert.fail("owner pause is not supported"); },
      resume: async () => { assert.fail("owner resume is not supported"); },
      retry: async () => { assert.fail("owner retry is not supported"); },
      cancel: async () => {}, prioritize: async () => {}, dismiss: () => {},
    });
    store.patchTask(task.id, { ownerId: "packed-owner" });
    t.mock.method(netcattyBridge, "get", () => ({
      clearPendingTransferCancel: async () => { assert.fail("controls must not mutate backend cancellation"); },
      cleanupTransferArtifacts: async () => { assert.fail("generic retry must not clean a packed destination"); },
    }));
    await store.pause(task.id);
    await store.resume(task.id);
    await store.retry(task.id);
    assert.equal(store.getTask(task.id)?.status, status);
    assert.equal(isTransferPauseLatched(task.id), false);
    assert.equal(store.isResuming(task.id), false);
  });
}

const queuedEvent = (id: string) => ({
  type: "queued" as const, transferId: id, controlKind: "packed-download" as const,
  fileName: "2 selected", direction: "download" as const, isDirectory: true,
  sourcePath: "/srv", targetPath: "/downloads", sourceConnectionId: "captured-session",
  sourceHostId: "host", sourceHostLabel: "Server", origin: "manual" as const,
  packedTargetPaths: ["/downloads/compose", "/downloads/README.md"],
});

test("other windows preserve packed selection metadata, progress and terminal state", async () => {
  const store = createSftpTransferCenterStore();
  const event = queuedEvent("packed-other-window");
  store.ingestBackgroundEvent(event);
  const queued = store.getTask(event.transferId)!;
  assert.equal(queued.ownerId, "background-transfer");
  assert.equal(queued.sourceConnectionId, "captured-session");
  assert.equal(queued.sourceHostLabel, "Server");
  assert.equal(queued.origin, "manual");
  assert.equal(queued.progressMode, "bytes");
  assert.equal(queued.resumable, false);
  assert.equal(queued.retryable, false);
  assert.deepEqual(queued.packedTargetPaths, event.packedTargetPaths);
  assert.equal(findActivePathConflict([queued], { id: "other", targetConnectionId: "local", targetPath: "/downloads/compose/config" })?.id, queued.id);
  assert.equal(findActivePathConflict([queued], { id: "other", targetConnectionId: "local", targetPath: "/downloads/unselected" }), undefined);
  store.ingestBackgroundEvent({ ...event, type: "started" });
  store.ingestBackgroundEvent({ ...event, type: "progress", phase: "extracting", transferred: 256 });
  assert.equal(store.getTask(queued.id)?.phase, "extracting");
  assert.equal(store.getTask(queued.id)?.transferredBytes, 256);
  await store.pause(queued.id);
  assert.equal(store.getTask(queued.id)?.status, "transferring");
  store.ingestBackgroundEvent({ ...event, type: "completed", transferred: 256, totalBytes: 256 });
  assert.equal(store.getTask(queued.id)?.status, "completed");
  assert.equal(store.getTask(queued.id)?.phase, undefined);
});

test("packed event echo preserves the local owner and fallback dismisses all reservations", () => {
  const store = createSftpTransferCenterStore();
  const task = { ...makePackedTask("packed-local-echo", "queued"), ownerId: "original-panel" };
  store.upsertTasks([task]);
  store.ingestBackgroundEvent(queuedEvent(task.id));
  assert.equal(store.getTask(task.id)?.ownerId, "original-panel");
  store.ingestBackgroundEvent({ type: "dismissed", transferId: task.id });
  assert.equal(store.getTask(task.id), undefined);
});

for (const terminal of ["cancelled", "failed"] as const) {
  test(`a globally ${terminal} queued packed job cannot start`, async () => {
    const store = createSftpTransferCenterStore();
    const runtime = createTransferRuntime(store);
    const task = makePackedTask(`packed-queued-${terminal}`, "queued");
    const resource = `packed-queued-${terminal}-resource`;
    let unblock!: () => void;
    let started!: () => void;
    const blockerStarted = new Promise<void>((resolve) => { started = resolve; });
    const blocker = globalSftpTransferScheduler.run("blocker", "packed-blocker", [resource], () => 1, async () => {
      started();
      await new Promise<void>((resolve) => { unblock = resolve; });
    });
    await blockerStarted;
    runtime.enqueue([task]);
    let backendCalls = 0;
    const running = runtime.runWalk(task.id, async () => {
      await assert.rejects(globalSftpTransferScheduler.run("owner", task.id, [resource], () => 1, async () => {
        backendCalls++;
      }), /Transfer cancelled/);
      assert.equal(isTransferCancelledFlag(task.id), true, "owner keeps cancellation until its walk settles");
    });
    try {
      store.ingestBackgroundEvent({ type: terminal, transferId: task.id, controlKind: "packed-download", error: terminal === "failed" ? "Worker exited" : undefined });
      await running;
      assert.equal(store.getTask(task.id)?.status, terminal);
      if (terminal === "failed") assert.equal(store.getTask(task.id)?.error, "Worker exited");
      assert.equal(backendCalls, 0);
      assert.equal(isTransferCancelledFlag(task.id), false, "settled walks release their cancellation flag");
    } finally {
      unblock();
      await blocker;
      await running;
    }
  });
}

test("a mirrored transfer-center Cancel reaches the original window's packed stream", async (t) => {
  const ownerStore = createSftpTransferCenterStore();
  const otherWindowStore = createSftpTransferCenterStore();
  const runtime = createTransferRuntime(ownerStore);
  const task = { ...makePackedTask("packed-mirror-cancel", "queued"), ownerId: "detached-pane" };
  const sender = Object.assign(new EventEmitter(), { id: 41, isDestroyed: () => false, send() {} });
  const ownerEvent = { sender };
  let started!: () => void;
  const streamStarted = new Promise<void>((resolve) => { started = resolve; });
  let finish!: (value: { status: "cancelled" }) => void;
  const stream = new Promise<{ status: "cancelled" }>((resolve) => { finish = resolve; });
  const routedTo: number[] = [];
  const lifecycle = createPackedDownloadLifecycle({
    broadcast(event: Parameters<typeof ownerStore.ingestBackgroundEvent>[0]) {
      ownerStore.ingestBackgroundEvent(event);
      otherWindowStore.ingestBackgroundEvent(event);
    },
    async cancel(event: { sender: { id: number } }, id: string) {
      assert.equal(id, task.id);
      routedTo.push(event.sender.id);
      finish({ status: "cancelled" });
      return { success: true };
    },
  });
  t.mock.method(netcattyBridge, "get", () => ({
    cancelTransfer: (id: string) => lifecycle.cancel(id),
    cleanupTransferArtifacts: async () => { assert.fail("packed cancellation must not run generic destination cleanup"); },
  }));
  runtime.enqueue([task]);
  lifecycle.register(ownerEvent, { ...queuedEvent(task.id) });
  const running = runtime.runWalk(task.id, async () => {
    const result = await lifecycle.run(ownerEvent, {
      transferId: task.id, names: ["compose", "README.md"], remoteDirectory: "/srv", localDirectory: "/downloads",
    }, async () => { started(); return stream; });
    assert.equal(result.status, "cancelled");
  });
  try {
    await streamStarted;
    assert.equal(otherWindowStore.getTask(task.id)?.ownerId, "background-transfer");
    await otherWindowStore.cancel(task.id);
    await running;
    assert.deepEqual(routedTo, [41], "main routes the mirrored cancel to the captured owner");
    assert.equal(ownerStore.getTask(task.id)?.status, "cancelled");
    assert.equal(otherWindowStore.getTask(task.id)?.status, "cancelled");
    assert.equal(lifecycle.has(task.id), false);
    assert.equal(sender.listenerCount("destroyed"), 0);
  } finally {
    finish({ status: "cancelled" });
    await running;
  }
});
