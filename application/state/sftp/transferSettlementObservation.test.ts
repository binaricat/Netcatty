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
