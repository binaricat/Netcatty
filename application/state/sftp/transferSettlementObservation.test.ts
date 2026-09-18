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

for (const compactNewOwner of [false, true]) {
  test(`superseded waiter rejects a changed identity even after new owner compaction: ${compactNewOwner}`, async (t) => {
    const { sftpTransferCenterStore: store } = await import("../sftpTransferCenterStore");
    const { runTransferAndWaitForOwner } = await import("./waitForTransferOwner");
    const task = { ...child(), id: `changed-owner-${compactNewOwner}`, parentTaskId: `changed-root-${compactNewOwner}` };
    store.upsertTasks([{ ...task, id: task.parentTaskId, parentTaskId: undefined, isDirectory: true }, task]);
    let abort = false;
    const running = runTransferAndWaitForOwner(task, async () => {
      const changed = { ...task, directoryEntryIdentity: "b".repeat(64) };
      assert.equal(store.admitTaskRun(changed), "ready");
      if (compactNewOwner) {
        store.patchTask(changed.id, { status: "completed" });
        assert.equal(store.getTask(changed.id), undefined);
      }
      return { superseded: true };
    }, () => abort);
    const settled = running.then(() => "completed", (error: Error) => error.message);
    t.after(async () => {
      abort = true;
      await settled;
      store.patchTask(task.parentTaskId, { status: "completed" });
      store.dismiss(task.parentTaskId);
    });
    assert.match(String(await Promise.race([
      settled, new Promise((resolve) => setTimeout(() => resolve("still-waiting"), 450)),
    ])), /identity changed/i);
  });
}

test("destination rebuild restarts only the captured completion and preserves newer controls", async (t) => {
  const { latchTransferPause, resetTransferPauseLatchesForTests } = await import("./transferPauseLatch");
  const store = createSftpTransferCenterStore();
  const task = { ...child(), parentTaskId: undefined, status: "completed" as const, checkpointBytes: 10 };
  store.upsertTasks([task]);
  const captured = store.getTask(task.id)!;
  const restart = { ...task, status: "transferring" as const, checkpointBytes: 0, transferredBytes: 0 };
  latchTransferPause(task.id);
  t.after(resetTransferPauseLatchesForTests);
  assert.equal(store.admitTaskRun(restart, undefined, captured), "paused");
  resetTransferPauseLatchesForTests();
  assert.equal(store.admitTaskRun(restart, undefined, captured), "ready");
  assert.equal(store.getTask(task.id)?.checkpointBytes, 0);
  store.patchTask(task.id, { status: "completed" });
  assert.equal(store.admitTaskRun(restart, undefined, captured), "completed", "new completion must not be restarted");
  store.patchTask(task.id, { status: "cancelled" });
  assert.equal(store.admitTaskRun(restart, undefined, captured), "cancelled");
});

test("destination rebuild waiting on pause reuses a newer compacted completion", async (t) => {
  const { sftpTransferCenterStore: store } = await import("../sftpTransferCenterStore");
  const { runTransferAndWaitForOwner } = await import("./waitForTransferOwner");
  const { latchTransferPause, resetTransferPauseLatchesForTests } = await import("./transferPauseLatch");
  const task = { ...child(), id: "restart-wait-child", parentTaskId: "restart-wait-root", directoryEntryIndex: 1 };
  const root = { ...task, id: task.parentTaskId, parentTaskId: undefined, isDirectory: true };
  store.upsertTasks([root, { ...task, status: "completed" }]);
  const captured = store.getTask(task.id)!;
  latchTransferPause(task.id);
  let starts = 0;
  let abort = false;
  const running = runTransferAndWaitForOwner(task, async () => { starts += 1; return {}; }, () => abort, undefined, captured);
  const settled = running.then(() => "completed", (error: Error) => error.message);
  t.after(async () => {
    abort = true;
    resetTransferPauseLatchesForTests();
    await settled;
    store.patchTask(root.id, { status: "completed" });
    store.dismiss(root.id);
  });
  // An unrelated lifecycle emit must not pin the old completion in the observation.
  store.patchTask(root.id, { reconnectRequired: true });
  assert.equal(await Promise.race([
    settled, new Promise((resolve) => setTimeout(() => resolve("still-waiting"), 230)),
  ]), "still-waiting", "old completion cannot finish recovery while a new transfer is still needed");
  assert.equal(starts, 0);
  resetTransferPauseLatchesForTests();
  store.patchTask(task.id, { status: "transferring", lifecycleEpoch: 1 });
  store.upsertTasks([{ ...task, id: "restart-wait-first", directoryEntryIndex: 0, status: "completed" }]);
  store.patchTask(task.id, { status: "completed", lifecycleEpoch: 2 });
  assert.equal(store.getTask(task.id), undefined);
  assert.equal(await settled, "completed");
  assert.equal(starts, 0, "new completion after stage rebuild must be reused even when its row was compacted");
});

test("paused admission cannot reclaim an identity replaced while it waited", async (t) => {
  const { sftpTransferCenterStore: store } = await import("../sftpTransferCenterStore");
  const { runTransferAndWaitForOwner } = await import("./waitForTransferOwner");
  const task = { ...child(), id: "paused-displaced", parentTaskId: undefined };
  store.upsertTasks([{ ...task, status: "paused" }]);
  let starts = 0;
  let abort = false;
  const running = runTransferAndWaitForOwner(task, async () => { starts += 1; return {}; }, () => abort);
  const settled = running.then(() => "completed", (error: Error) => error.message);
  t.after(async () => {
    abort = true;
    await settled;
    store.patchTask(task.id, { status: "completed" });
    store.dismiss(task.id);
  });
  store.upsertTasks([{ ...task, status: "transferring", directoryEntryIdentity: "b".repeat(64), lifecycleEpoch: 1 }]);
  assert.match(await settled, /identity changed/i);
  assert.equal(starts, 0);
  assert.equal(store.getTask(task.id)?.directoryEntryIdentity, "b".repeat(64));
});

for (const identityChangesDuringWait of [false, true]) {
  test(`paused recovery distinguishes initial stale identity from later ownership: changed=${identityChangesDuringWait}`, async (t) => {
    const { sftpTransferCenterStore: store } = await import("../sftpTransferCenterStore");
    const { runTransferAndWaitForOwner } = await import("./waitForTransferOwner");
    const { latchTransferPause, resetTransferPauseLatchesForTests } = await import("./transferPauseLatch");
    const task = { ...child(), id: `paused-origin-${identityChangesDuringWait}`, parentTaskId: `paused-origin-root-${identityChangesDuringWait}` };
    const root = { ...task, id: task.parentTaskId, parentTaskId: undefined, isDirectory: true };
    store.upsertTasks([root, {
      ...task, status: identityChangesDuringWait ? "failed" : "paused",
      directoryEntryIdentity: identityChangesDuringWait ? task.directoryEntryIdentity : "b".repeat(64),
    }]);
    const initialPause = store.getTask(task.id)!;
    latchTransferPause(task.id);
    let starts = 0;
    let abort = false;
    let conflicts = 0;
    const running = runTransferAndWaitForOwner(task, async () => { starts += 1; return {}; }, () => abort,
      identityChangesDuringWait ? undefined : initialPause, undefined, () => { conflicts += 1; });
    const settled = running.then(() => "completed", (error: Error) => error.message);
    t.after(async () => {
      abort = true;
      resetTransferPauseLatchesForTests();
      await settled;
      store.patchTask(root.id, { status: "completed" });
      store.dismiss(root.id);
    });
    // This captures the prior failed result, or republishes the unchanged
    // initial old identity. Neither is evidence of a replacement by itself.
    store.patchTask(root.id, { reconnectRequired: true });
    resetTransferPauseLatchesForTests();
    if (identityChangesDuringWait) {
      store.patchTask(task.id, { status: "transferring", directoryEntryIdentity: "b".repeat(64), lifecycleEpoch: 1 });
    }
    const outcome = await settled;
    if (identityChangesDuringWait) {
      assert.match(outcome, /identity changed/i);
      assert.equal(starts, 0);
      assert.equal(conflicts, 1);
      assert.equal(store.getTask(task.id)?.directoryEntryIdentity, "b".repeat(64));
    } else {
      assert.equal(outcome, "completed");
      assert.equal(starts, 1);
      assert.equal(conflicts, 0);
    }
  });
}

test("paused retry observes newer same-identity completion after an old failure", async (t) => {
  const { sftpTransferCenterStore: store } = await import("../sftpTransferCenterStore");
  const { runTransferAndWaitForOwner } = await import("./waitForTransferOwner");
  const { latchTransferPause, resetTransferPauseLatchesForTests } = await import("./transferPauseLatch");
  const task = { ...child(), id: "failed-then-completed", parentTaskId: "failed-then-completed-root" };
  const root = { ...task, id: task.parentTaskId, parentTaskId: undefined, isDirectory: true };
  store.upsertTasks([root, { ...task, status: "failed" }]);
  latchTransferPause(task.id);
  let starts = 0;
  let abort = false;
  const running = runTransferAndWaitForOwner(task, async () => { starts += 1; return {}; }, () => abort);
  const settled = running.then(() => "completed", (error: Error) => error.message);
  t.after(async () => {
    abort = true;
    resetTransferPauseLatchesForTests();
    await settled;
    store.patchTask(root.id, { status: "completed" });
    store.dismiss(root.id);
  });
  store.patchTask(root.id, { reconnectRequired: true });
  resetTransferPauseLatchesForTests();
  store.patchTask(task.id, { status: "transferring", lifecycleEpoch: 1 });
  store.patchTask(task.id, { status: "completed", lifecycleEpoch: 2 });
  assert.equal(store.getTask(task.id), undefined);
  assert.equal(await settled, "completed");
  assert.equal(starts, 0, "a newer completed attempt must replace the captured old failure");
});

test("an unchanged owner retains its original transport rejection", async (t) => {
  const { sftpTransferCenterStore: store } = await import("../sftpTransferCenterStore");
  const { runTransferAndWaitForOwner } = await import("./waitForTransferOwner");
  const task = { ...child(), id: "unchanged-rejected-owner", parentTaskId: undefined };
  store.upsertTasks([task]);
  t.after(() => { store.patchTask(task.id, { status: "completed" }); store.dismiss(task.id); });
  const error = new Error("original transport failure");
  await assert.rejects(runTransferAndWaitForOwner(task, async () => { throw error; }, () => false),
    (actual) => actual === error);
});

for (const activation of ["patch", "progress", "owner"] as const) {
test(`initial stale identity exemption ends when another owner activates that row: ${activation}`, async (t) => {
  const { sftpTransferCenterStore: store } = await import("../sftpTransferCenterStore");
  const { runTransferAndWaitForOwner } = await import("./waitForTransferOwner");
  const { latchTransferPause, resetTransferPauseLatchesForTests } = await import("./transferPauseLatch");
  const task = { ...child(), id: "activated-initial-identity", parentTaskId: undefined };
  store.upsertTasks([{ ...task, status: "paused", directoryEntryIdentity: "b".repeat(64), lifecycleEpoch: 1 }]);
  const initial = store.getTask(task.id)!;
  latchTransferPause(task.id);
  let starts = 0;
  let abort = false;
  const running = runTransferAndWaitForOwner(task, async () => { starts += 1; return {}; }, () => abort, initial);
  const settled = running.then(() => "completed", (error: Error) => error.message);
  t.after(async () => {
    abort = true;
    resetTransferPauseLatchesForTests();
    await settled;
    store.patchTask(task.id, { status: "completed" });
    store.dismiss(task.id);
  });
  resetTransferPauseLatchesForTests();
  if (activation === "progress") {
    store.ingestBackgroundEvent({ type: "progress", transferId: task.id,
      transferred: 1, lifecycleEpoch: 2, lifecycleState: "transferring" });
  } else if (activation === "owner") store.patchTask(task.id, { ownerId: "replacement-owner" });
  else store.patchTask(task.id, { status: "transferring", lifecycleEpoch: 2 });
  assert.match(String(await Promise.race([
    settled, new Promise((resolve) => setTimeout(() => resolve("still-waiting"), 450)),
  ])), /identity changed/i);
  assert.equal(starts, 0);
  assert.equal(store.getTask(task.id)?.directoryEntryIdentity, "b".repeat(64));
});

}

test("already active different identity is rejected before first admission", async (t) => {
  const { sftpTransferCenterStore: store } = await import("../sftpTransferCenterStore");
  const { runTransferAndWaitForOwner } = await import("./waitForTransferOwner");
  const task = { ...child(), id: "already-active-identity", parentTaskId: undefined };
  store.upsertTasks([{ ...task, directoryEntryIdentity: "b".repeat(64), lifecycleEpoch: 1 }]);
  t.after(() => { store.patchTask(task.id, { status: "completed" }); store.dismiss(task.id); });
  let starts = 0;
  let conflicts = 0;
  await assert.rejects(runTransferAndWaitForOwner(task, async () => { starts += 1; return {}; }, () => false,
    undefined, undefined, () => { conflicts += 1; }), /identity changed/i);
  assert.equal(starts, 0);
  assert.equal(conflicts, 1);
  assert.equal(store.getTask(task.id)?.directoryEntryIdentity, "b".repeat(64));
});

for (const replacementStatus of ["transferring", "completed"] as const) {
  for (const oldStatus of ["completed", "failed"] as const) {
    test(`deferred ${oldStatus} cannot overwrite a ${replacementStatus} replacement after waiter exit`, async () => {
      const { sftpTransferCenterStore: store } = await import("../sftpTransferCenterStore");
      const { runTransferAndWaitForOwner } = await import("./waitForTransferOwner");
      const { createDedicatedResumeChildUpdateBatcher } = await import("../../app/dedicatedResumeProgress");
      const task = child();
      const root = { ...task, id: task.parentTaskId!, parentTaskId: undefined, isDirectory: true };
      const batcher = createDedicatedResumeChildUpdateBatcher({
        getTaskCount: () => 4096, hasTask: () => true,
        upsertTasks: (updates) => store.upsertTasks(updates),
      });
      store.upsertTasks([root, task]);
      let observation: ReturnType<typeof store.observeTaskSettlement> | undefined;
      try {
        await runTransferAndWaitForOwner(task, async () => {
          store.patchTask(task.id, { status: oldStatus });
          return {};
        }, () => false, undefined, undefined, () => batcher.discard(task.id), (value) => {
          observation = value;
          return true;
        });
        assert.ok(observation);
        batcher.push({ ...task, status: oldStatus }, observation);
        store.upsertTasks([{ ...task, directoryEntryIdentity: "b".repeat(64), status: replacementStatus }]);
        const replacement = store.getTask(task.id);
        batcher.flush();
        assert.equal(store.getTask(task.id), replacement);
        if (replacementStatus === "transferring") assert.equal(replacement?.directoryEntryIdentity, "b".repeat(64));
        else assert.equal(replacement, undefined, "the replacement remains compacted");
        assert.equal(observation.read(), undefined, "the retained observation is disposed");
      } finally {
        batcher.flush();
        observation?.dispose();
        store.patchTask(root.id, { status: "completed" });
        store.dismiss(root.id);
      }
    });
  }
}
