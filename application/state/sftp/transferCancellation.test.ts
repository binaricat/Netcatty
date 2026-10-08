import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TransferTask } from "../../../domain/models";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { createSftpTransferCenterStore } from "../sftpTransferCenterStore";
import { globalSftpTransferScheduler } from "./globalTransferScheduler";
import { isTransferOrRootCancelled, resetTransferCancelLatchesForTests } from "./transferCancelLatch";
import { createTransferRuntime, resetTransferRuntimeRunsForTests } from "./transferRuntime";
import { resetTransferWalkRegistryForTests } from "./transferWalkRegistry";

const task = (id: string, extra: Partial<TransferTask> = {}): TransferTask => ({
  id, fileName: id, sourcePath: `/source/${id}`, targetPath: `/target/${id}`,
  sourceConnectionId: "local", targetConnectionId: "fixture", direction: "upload",
  status: "transferring", totalBytes: 8, transferredBytes: 0, speed: 0,
  startTime: 1, isDirectory: false, resumable: true, ...extra,
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("failed cancellation waits for the old walk, then Resume restores scheduler-rejected file bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "netcatty-cancel-"));
  const originalGet = netcattyBridge.get;
  t.after(async () => {
    netcattyBridge.get = originalGet;
    resetTransferCancelLatchesForTests();
    resetTransferWalkRegistryForTests();
    resetTransferRuntimeRunsForTests();
    await rm(root, { recursive: true, force: true });
  });
  const store = createSftpTransferCenterStore();
  const runtime = createTransferRuntime(store);
  const ids = ["active", "queued-1", "queued-2"];
  const expected = ids.map((id) => Buffer.from(`bytes-of-${id}`));
  const children = ids.map((id) => task(id, { parentTaskId: "folder", targetPath: join(root, id) }));
  store.publishOwner("closed-panel", [task("folder", { isDirectory: true, targetHostId: "fixture-host" }), ...children]);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  let softResumeCalls = 0;
  let pauseCalls = 0;
  netcattyBridge.get = () => ({
    cancelTransfer: async (id: string) => ({ success: id !== "active" }),
    pauseTransfer: async () => { pauseCalls += 1; return { success: true }; },
    clearPendingTransferCancel: async () => undefined,
    resumeTransfer: async () => { softResumeCalls += 1; return { success: true }; },
  } as unknown as ReturnType<typeof netcattyBridge.get>);
  let starts = 0;
  const walking = runtime.runWalk("folder", async () => {
    await Promise.all(children.map((child, index) => globalSftpTransferScheduler.run(
      "closed-panel", child.id, ["cancel-fixture"], () => 1, async () => {
        starts += 1;
        await held;
        await writeFile(child.targetPath, expected[index]);
        store.patchTask(child.id, { status: "completed" });
      },
    ).catch(() => store.patchTask(child.id, { status: "cancelled" }))));
    store.patchTask("folder", { status: "cancelled" });
  });
  await tick();
  assert.equal(starts, 1);
  let cancelSettled = false;
  const cancelling = store.cancel("folder").then(() => { cancelSettled = true; });
  const resuming = store.resume("folder");
  await tick();
  assert.equal(cancelSettled, true, "failed cancel must return promptly so the user can retry");
  assert.equal(store.getTask("folder")?.status, "attention");
  assert.equal(isTransferOrRootCancelled("folder"), true);
  assert.equal(softResumeCalls, 0, "must not unlatch the old walk");
  await store.pause("folder");
  assert.equal(pauseCalls, 0, "a late row-level Pause must not park the cancelling walk");
  let freshWalks = 0;
  store.setDedicatedResumeHandler(async () => {
    freshWalks += 1;
    assert.equal(runtime.isWalkInFlight("folder"), false);
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (store.getTask(child.id)?.status === "completed") continue;
      assert.equal(store.admitTaskRun(child), "ready");
      await writeFile(child.targetPath, expected[index]);
      store.patchTask(child.id, { status: "completed" });
    }
    return { success: true };
  });
  release();
  await Promise.all([walking, cancelling, resuming]);
  assert.equal(freshWalks, 1);
  assert.equal(starts, 1, "cancelled queue callbacks cannot silently count as transferred files");
  assert.equal(store.getTask("folder")?.status, "completed");
  for (let index = 0; index < children.length; index += 1) {
    assert.deepEqual(await readFile(children[index].targetPath), expected[index]);
  }
});

test("failed ownerless compression cancellation retries the same backend", async (t) => {
  const originalGet = netcattyBridge.get;
  t.after(() => { netcattyBridge.get = originalGet; resetTransferCancelLatchesForTests(); });
  const store = createSftpTransferCenterStore();
  const calls: string[] = [];
  netcattyBridge.get = () => ({
    cancelCompressedUpload: async (id: string) => {
      calls.push(`compressed:${id}`);
      return { success: calls.length > 1 };
    },
    cancelTransfer: async (id: string) => { calls.push(`stream:${id}`); return { success: true }; },
  } as unknown as ReturnType<typeof netcattyBridge.get>);
  store.publishOwner("closed-panel", [task("archive", { controlKind: "compressed-upload" })]);
  await store.cancel("archive");
  assert.equal(store.getTask("archive")?.status, "attention");
  await store.cancel("archive");
  assert.deepEqual(calls, ["compressed:archive", "compressed:archive"]);
  assert.equal(store.getTask("archive")?.status, "cancelled");
});

test("late completion survives cancellation, while an unrelated paused batch peer stays paused", async (t) => {
  const originalGet = netcattyBridge.get;
  t.after(() => { netcattyBridge.get = originalGet; resetTransferCancelLatchesForTests(); });
  const store = createSftpTransferCenterStore();
  const calls: string[] = [];
  store.publishOwner("gone", [task("selected", { batchId: "batch" }), task("peer", { batchId: "batch", status: "paused" })]);
  netcattyBridge.get = () => ({
    cancelTransfer: async (id: string) => {
      calls.push(id);
      store.patchTask(id, { status: "completed" });
      return { success: true };
    },
  } as unknown as ReturnType<typeof netcattyBridge.get>);
  await store.cancel("selected");
  assert.deepEqual(calls, ["selected"]);
  assert.equal(store.getTask("selected")?.status, "completed");
  assert.equal(store.getTask("peer")?.status, "paused");
});


test("Resume cannot revive a tree pre-latched by an upcoming Cancel all batch", async (t) => {
  const { markTransferCancelledTree } = await import("./transferCancelLatch");
  t.after(resetTransferCancelLatchesForTests);
  const store = createSftpTransferCenterStore();
  store.publishOwner("gone", [task("waiting-cancel-batch", { status: "paused", isDirectory: true })]);
  markTransferCancelledTree("waiting-cancel-batch");
  await store.resume("waiting-cancel-batch");
  assert.equal(store.getTask("waiting-cancel-batch")?.status, "paused");
  assert.equal(isTransferOrRootCancelled("waiting-cancel-batch"), true);
});


test("failed cancel can be retried while its old walk is still running", async (t) => {
  const originalGet = netcattyBridge.get;
  t.after(() => { netcattyBridge.get = originalGet; resetTransferCancelLatchesForTests(); });
  const store = createSftpTransferCenterStore();
  const runtime = createTransferRuntime(store);
  store.publishOwner("gone", [task("retry-live-cancel", { isDirectory: true })]);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  const walking = runtime.runWalk("retry-live-cancel", async () => { await held; });
  let attempts = 0;
  netcattyBridge.get = () => ({
    cancelTransfer: async () => {
      attempts += 1;
      if (attempts === 1) return { success: false };
      release();
      return { success: true };
    },
    cleanupTransferArtifacts: async () => undefined,
  } as unknown as ReturnType<typeof netcattyBridge.get>);
  await store.cancel("retry-live-cancel");
  assert.equal(runtime.isWalkInFlight("retry-live-cancel"), true);
  assert.equal(store.getTask("retry-live-cancel")?.status, "attention");
  const resume = store.resume("retry-live-cancel");
  await store.cancel("retry-live-cancel");
  await Promise.all([walking, resume]);
  assert.equal(attempts, 2, "second cancel must reach the backend before natural completion");
  assert.equal(store.getTask("retry-live-cancel")?.status, "cancelled", "new successful cancel owns final outcome");
});


test("large orphan recovery clears pending cancellations in bounded concurrent batches", async (t) => {
  const originalGet = netcattyBridge.get;
  t.after(() => { netcattyBridge.get = originalGet; resetTransferCancelLatchesForTests(); });
  const store = createSftpTransferCenterStore();
  store.publishOwner("gone", [task("cleanup-root", { isDirectory: true }),
    ...Array.from({ length: 2200 }, (_, index) => task(`cleanup-${index}`, { parentTaskId: "cleanup-root" }))]);
  let active = 0;
  let peak = 0;
  let cleared = 0;
  netcattyBridge.get = () => ({
    cancelTransfer: async (id: string) => ({ success: id !== "cleanup-0" }),
    clearPendingTransferCancel: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      cleared += 1;
    },
  } as unknown as ReturnType<typeof netcattyBridge.get>);
  await store.cancel("cleanup-root");
  assert.equal(cleared, 2201);
  assert.ok(peak > 1, "recovery must not serialize one IPC per row");
  assert.ok(peak <= 32, "recovery uses the cancellation batch bound");
});

for (const completeDuring of ["backend-cancel", "walk-settlement"] as const) {
  test(`failed cancellation preserves compacted completion during ${completeDuring} on dedicated resume`, async (t) => {
    const { sftpTransferCenterStore: store } = await import("../sftpTransferCenterStore");
    const { createDirectoryEntryIdentity } = await import("../../../domain/sftpDirectoryCheckpoint");
    const { resumeTransferWithDedicatedSession, resetDedicatedSessionOpenGateForTests } =
      await import("./dedicatedTransferResume");
    const originalGet = netcattyBridge.get;
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    });
    const parent = task(`compacted-cancel-${completeDuring}`, {
      sourcePath: "/source/folder", targetPath: "/target/folder", targetHostId: "fixture-host",
      isDirectory: true, progressMode: "files", totalBytes: 3,
    });
    const children = ["completed", "cancelled", "cancel-failed"].map((name, index) => {
      const child = task(`${parent.id}-${name}`, {
        parentTaskId: parent.id, fileName: name,
        sourcePath: `${parent.sourcePath}/${name}`, targetPath: `${parent.targetPath}/${name}`,
        sourceLastModified: 1, directoryEntryIndex: index,
      });
      return { ...child, directoryEntryIdentity: createDirectoryEntryIdentity({
        sourcePath: child.sourcePath, targetPath: child.targetPath, size: child.totalBytes, lastModified: 1,
      }) };
    });
    // Match the sorted traversal order so dedicated resume validates the actual checkpoint.
    children.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
    children.forEach((child, index) => { child.directoryEntryIndex = index; });
    const completed = children.find((child) => child.fileName === "completed")!;
    const cancelled = children.find((child) => child.fileName === "cancelled")!;
    const failed = children.find((child) => child.fileName === "cancel-failed")!;
    const runtime = createTransferRuntime(store);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let walking: Promise<unknown> | undefined;
    t.after(async () => {
      release();
      await walking;
      store.setDedicatedResumeHandler(null);
      store.patchTask(parent.id, { status: "completed" });
      store.dismiss(parent.id);
      netcattyBridge.get = originalGet;
      resetTransferCancelLatchesForTests();
      resetTransferWalkRegistryForTests();
      resetTransferRuntimeRunsForTests();
      resetDedicatedSessionOpenGateForTests();
      if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
      else Reflect.deleteProperty(globalThis, "localStorage");
    });
    const uploads: string[] = [];
    const progress: number[] = [];
    netcattyBridge.get = () => ({
      cancelTransfer: async (id: string) => {
        if (completeDuring === "backend-cancel" && id === completed.id) {
          store.ingestBackgroundEvent({ type: "completed", transferId: id, transferred: 8, totalBytes: 8 });
        }
        return { success: id !== failed.id };
      },
      clearPendingTransferCancel: async () => undefined,
      openSftp: async () => "reconnected-sftp", closeSftp: async () => {},
      listLocalTree: async () => children.map((child) => ({
        localPath: child.sourcePath, relativePath: child.fileName,
        type: "file", size: 8, lastModified: 1,
      })),
      mkdirSftp: async () => {},
      statLocal: async () => ({ size: 8, lastModified: 1 }),
      startStreamTransfer: async (options: { sourcePath: string; checkpointBytes: number }) => {
        if (options.sourcePath === cancelled.sourcePath) assert.equal(options.checkpointBytes, 4);
        uploads.push(options.sourcePath);
        return {};
      },
    } as unknown as ReturnType<typeof netcattyBridge.get>);
    store.publishOwner("closed-panel", [parent, ...children]);
    walking = runtime.runWalk(parent.id, async () => {
      await held;
      if (completeDuring === "walk-settlement") {
        store.ingestBackgroundEvent({ type: "completed", transferId: completed.id, transferred: 8, totalBytes: 8 });
      }
      store.patchTask(cancelled.id, { status: "cancelled", checkpointBytes: 4 });
      store.patchTask(parent.id, { status: "cancelled" });
    });
    await store.cancel(parent.id);
    assert.equal(runtime.isWalkInFlight(parent.id), true);
    store.setDedicatedResumeHandler(async (root) => {
      assert.equal(root.directoryResumeCheckpoint?.completedEntries, 1);
      assert.equal(store.getTask(completed.id), undefined, "the finished child stays compacted");
      assert.equal(store.getTask(cancelled.id)?.status, "interrupted");
      assert.equal(store.getTask(failed.id)?.status, "attention");
      return resumeTransferWithDedicatedSession(root, {
        hosts: [{ id: "fixture-host", label: "fixture", hostname: "fixture", port: 22,
          username: "test", authMethod: "password", protocol: "ssh", tags: [], os: "linux" }],
        keys: [], identities: [],
      }, (value) => { progress.push(value.transferred); }, {
        children: store.getSnapshot().tasks.filter((child) => child.parentTaskId === parent.id),
        onChildUpdate: (child) => { store.upsertTasks([child]); },
        onDirectoryCheckpointUpdate: (checkpoint) => store.patchTask(parent.id, { directoryResumeCheckpoint: checkpoint }),
      });
    });
    const resuming = store.resume(parent.id);
    release();
    await Promise.all([walking, resuming]);
    assert.deepEqual(uploads.sort(), [cancelled.sourcePath, failed.sourcePath].sort(),
      "only cancelled and failed-to-cancel children should upload again");
    assert.equal(store.getTask(parent.id)?.status, "completed");
    assert.ok(progress.every((count) => count <= 3), "compacted completion must count exactly once");
    assert.equal(progress.at(-1), 3);
  });
}
