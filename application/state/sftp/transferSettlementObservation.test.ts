import assert from "node:assert/strict";
import test from "node:test";
import type { TransferTask } from "../../../domain/models";
import { createSftpTransferCenterStore } from "../sftpTransferCenterStore";

function child(): TransferTask {
  return {
    id: "child", parentTaskId: "root", directoryEntryIndex: 0, directoryEntryIdentity: "a".repeat(64),
    sourcePath: "/source/a", targetPath: "/target/a", fileName: "a",
    sourceConnectionId: "local", targetConnectionId: "remote", direction: "upload",
    totalBytes: 1, transferredBytes: 0, speed: 0, startTime: 0, isDirectory: false, status: "transferring",
  };
}

for (const status of ["completed", "failed", "cancelled"] as const) {
  test(`settlement observation retains exact ${status} before history pruning`, () => {
    const store = createSftpTransferCenterStore();
    const task = child();
    store.upsertTasks([{ ...task, id: "root", parentTaskId: undefined, isDirectory: true }, task]);
    const observation = store.observeTaskSettlement(task);
    store.patchTask(task.id, { status, error: status === "failed" ? "write failed" : undefined });
    assert.equal(observation.read()?.status, status);
    if (status === "completed") assert.equal(store.getTask(task.id), undefined);
    observation.dispose();
    assert.equal(observation.read(), undefined);
  });
}

test("another file reusing an id and index is not completion evidence", () => {
  const store = createSftpTransferCenterStore();
  const task = child();
  store.upsertTasks([task]);
  const observation = store.observeTaskSettlement(task);
  store.upsertTasks([{ ...task, directoryEntryIdentity: "b".repeat(64), status: "completed" }]);
  assert.equal(observation.read(), undefined);
  observation.dispose();
});

test("a disposed observer receives no later completion", () => {
  const store = createSftpTransferCenterStore();
  const task = child();
  store.upsertTasks([task]);
  const observation = store.observeTaskSettlement(task);
  observation.dispose();
  store.patchTask(task.id, { status: "completed" });
  assert.equal(observation.read(), undefined);
});

test("explicit dispatch refreshes failed identity without overwriting checkpoints", () => {
  const store = createSftpTransferCenterStore();
  const task = { ...child(), status: "failed" as const, checkpointBytes: 7 };
  store.upsertTasks([task]);
  const next = { ...task, directoryEntryIdentity: "b".repeat(64), checkpointBytes: 0 };
  assert.equal(store.admitTaskRun(next), "ready");
  assert.equal(store.getTask(task.id)?.status, "transferring");
  assert.equal(store.getTask(task.id)?.directoryEntryIdentity, next.directoryEntryIdentity);
  assert.equal(store.getTask(task.id)?.checkpointBytes, 7);
});

for (const status of ["cancelled", "completed", "paused", "pausing"] as const) {
  test(`dispatch cannot revive a retained ${status} row`, () => {
    const store = createSftpTransferCenterStore();
    const task = child();
    store.upsertTasks([
      { ...task, id: "root", parentTaskId: undefined },
      { ...task, status },
    ]);
    assert.equal(store.admitTaskRun(task), status === "pausing" ? "paused" : status);
    assert.equal(store.getTask(task.id)?.status, status);
  });
}

test("dispatch preserves active lifecycle guards and avoids replacing unchanged rows", () => {
  const store = createSftpTransferCenterStore();
  const task = { ...child(), lifecycleEpoch: 9 };
  store.upsertTasks([task]);
  const before = store.getTask(task.id);
  assert.equal(store.admitTaskRun(task), "ready");
  assert.equal(store.getTask(task.id), before);
  assert.equal(store.admitTaskRun({ ...task, directoryEntryIdentity: "b".repeat(64) }), "ready");
  assert.equal(store.getTask(task.id)?.lifecycleEpoch, 9);
});

test("dispatch rejects a later pause or cancellation before changing identity", async (t) => {
  const { latchTransferPause, resetTransferPauseLatchesForTests } = await import("./transferPauseLatch");
  const { markTransferCancelledTree, settleTransferCancelTree } = await import("./transferCancelLatch");
  const store = createSftpTransferCenterStore();
  const task = { ...child(), status: "failed" as const };
  store.upsertTasks([task]);
  t.after(() => { resetTransferPauseLatchesForTests(); settleTransferCancelTree("root", [task.id]); });
  latchTransferPause("root");
  assert.equal(store.admitTaskRun(task), "paused");
  resetTransferPauseLatchesForTests();
  markTransferCancelledTree("root", [task.id]);
  assert.equal(store.admitTaskRun(task), "cancelled");
  assert.equal(store.getTask(task.id)?.status, "failed");
});

for (const nextStatus of ["transferring", "completed", "cancelled"] as const) {
  test(`dispatch waits through a later pause until ${nextStatus}`, async (t) => {
    const { sftpTransferCenterStore: store } = await import("../sftpTransferCenterStore");
    const { runTransferAndWaitForOwner } = await import("./waitForTransferOwner");
    const task = { ...child(), id: `paused-admission-${nextStatus}`, parentTaskId: undefined };
    store.upsertTasks([{ ...task, status: "paused" }]);
    let starts = 0;
    let abort = false;
    const running = runTransferAndWaitForOwner(task, async () => { starts += 1; return {}; }, () => abort);
    // Attach rejection handling before the cancellation event is delivered.
    const settled = running.then(() => "completed", (error: Error) => error.message);
    t.after(async () => { abort = true; await settled; store.dismiss(task.id); });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(starts, 0);
    assert.equal(store.getTask(task.id)?.status, "paused");
    if (nextStatus !== "cancelled") store.patchTask(task.id, { status: "transferring", lifecycleEpoch: 1 });
    if (nextStatus === "cancelled") {
      const { markTransferCancelledTree, settleTransferCancelTree } = await import("./transferCancelLatch");
      markTransferCancelledTree(task.id, []);
      t.after(() => settleTransferCancelTree(task.id, []));
    } else store.patchTask(task.id, { status: nextStatus });
    const outcome = await Promise.race([settled, new Promise((resolve) => setTimeout(() => resolve("still-waiting"), 1000))]);
    assert.equal(outcome, nextStatus === "cancelled" ? "Transfer cancelled" : "completed");
    assert.equal(starts, nextStatus === "transferring" ? 1 : 0);
  });
}

test("completed dispatch consumes only exact identity and never restarts", async (t) => {
  const { sftpTransferCenterStore: store } = await import("../sftpTransferCenterStore");
  const { runTransferAndWaitForOwner } = await import("./waitForTransferOwner");
  const task = { ...child(), id: "completed-admission", parentTaskId: undefined };
  store.upsertTasks([{ ...task, status: "completed" }]);
  t.after(() => store.dismiss(task.id));
  const start = async () => { assert.fail("completed transfer must not restart"); };
  await runTransferAndWaitForOwner(task, start, () => false);
  await assert.rejects(runTransferAndWaitForOwner({ ...task, directoryEntryIdentity: "b".repeat(64) }, start, () => false), /identity changed/);
  assert.equal(store.getTask(task.id)?.status, "completed");
});

test("a resumed retry does not inherit failed settlement captured while admission was paused", async (t) => {
  const { sftpTransferCenterStore: store } = await import("../sftpTransferCenterStore");
  const { runTransferAndWaitForOwner } = await import("./waitForTransferOwner");
  const { latchTransferPause, resetTransferPauseLatchesForTests } = await import("./transferPauseLatch");
  const task = { ...child(), id: "failed-paused-admission", parentTaskId: undefined };
  store.upsertTasks([{ ...task, status: "failed", error: "previous attempt failed" }]);
  latchTransferPause(task.id);
  let abort = false;
  const running = runTransferAndWaitForOwner(task, async () => {
    store.patchTask(task.id, { status: "completed" });
    return { superseded: true };
  }, () => abort);
  const settled = running.then(() => "completed", (error: Error) => error.message);
  t.after(async () => { abort = true; resetTransferPauseLatchesForTests(); await settled; store.dismiss(task.id); });
  // An unrelated lifecycle publication captures the previous failed row while waiting.
  store.upsertTasks([{ ...child(), id: "unrelated-admission", parentTaskId: undefined }]);
  t.after(() => store.dismiss("unrelated-admission"));
  resetTransferPauseLatchesForTests();
  assert.equal(await Promise.race([settled, new Promise((resolve) => setTimeout(() => resolve("still-waiting"), 1000))]), "completed");
});

test("fresh directory recovery authorizes only an unchanged retained pause under an active parent", () => {
  const store = createSftpTransferCenterStore();
  const task = child();
  store.upsertTasks([{ ...task, id: "root", parentTaskId: undefined, isDirectory: true, status: "pending" }, { ...task, status: "paused", lifecycleEpoch: 4 }]);
  const paused = store.getTask(task.id)!;
  assert.equal(store.admitTaskRun(task), "paused", "ordinary live dispatch must respect cross-window pause");
  assert.equal(store.admitTaskRun(task, paused), "ready");
  store.patchTask(task.id, { status: "paused", lifecycleEpoch: 5 });
  assert.equal(store.admitTaskRun(task, paused), "paused", "newer child pause invalidates fresh recovery permission");
  const currentPause = store.getTask(task.id)!;
  store.patchTask("root", { status: "paused", lifecycleEpoch: 6 });
  assert.equal(store.admitTaskRun(task, currentPause), "paused", "parent pause still wins");
});
