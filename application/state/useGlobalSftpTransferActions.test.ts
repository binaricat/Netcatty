import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { TransferTask } from "../../domain/models";
import { netcattyBridge } from "../../infrastructure/services/netcattyBridge";
import { sftpTransferCenterStore as store } from "./sftpTransferCenterStore";
import { useGlobalSftpTransferActions } from "./useGlobalSftpTransferActions";
import { isTransferOrRootCancelled, resetTransferCancelLatchesForTests } from "./sftp/transferCancelLatch";
import { resetTransferRuntimeRunsForTests, transferRuntime } from "./sftp/transferRuntime";
import { resetTransferWalkRegistryForTests } from "./sftp/transferWalkRegistry";

test("Cancel all releases a skipped late failure so one Retry executes while the old walk unwinds", async (t) => {
  const previousAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const originalGet = netcattyBridge.get;
  const tasks: TransferTask[] = Array.from({ length: 33 }, (_, index) => ({
    id: `late-failure-${index}`, fileName: `${index}.bin`,
    sourcePath: `/source/${index}`, targetPath: `/target/${index}`,
    sourceConnectionId: "local", targetConnectionId: "remote", targetHostId: "host",
    direction: "upload", status: "transferring", totalBytes: 8, transferredBytes: 0,
    speed: 0, startTime: Date.now() + index, isDirectory: false, resumable: true,
  }));
  const later = tasks[32];
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let renderer: ReactTestRenderer | undefined;
  let actions: ReturnType<typeof useGlobalSftpTransferActions> | undefined;
  function Probe() {
    actions = useGlobalSftpTransferActions(store.getSnapshot().tasks);
    return null;
  }
  store.publishOwner("closed-panel", tasks);
  const walking = transferRuntime.runWalk(later.id, async () => { await held; });
  t.after(async () => {
    release();
    await walking;
    await act(async () => { renderer?.unmount(); });
    store.setDedicatedResumeHandler(null);
    for (const task of tasks) store.dismiss(task.id);
    netcattyBridge.get = originalGet;
    resetTransferCancelLatchesForTests();
    resetTransferWalkRegistryForTests();
    resetTransferRuntimeRunsForTests();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: previousAct });
  });
  const cancellations: string[] = [];
  netcattyBridge.get = () => ({
    cancelTransfer: async (id: string) => {
      cancellations.push(id);
      if (id === tasks[0].id) store.patchTask(later.id, { status: "failed", error: "Connection lost" });
      return { success: true };
    },
    resumeTransfer: async () => ({ success: false, reason: "Transfer is no longer active" }),
    clearPendingTransferCancel: async () => {}, cleanupTransferArtifacts: async () => {},
  } as unknown as ReturnType<typeof netcattyBridge.get>);
  let retries = 0;
  store.setDedicatedResumeHandler(async () => { retries += 1; return { success: true }; });
  await act(async () => { renderer = create(React.createElement(Probe)); });
  await act(async () => { await actions!.cancelAll(); });
  assert.equal(cancellations.length, 32, "the late failure must be skipped by the second batch");
  assert.equal(store.getTask(later.id)?.status, "failed");
  assert.equal(store.getTask(later.id)?.error, "Connection lost");
  assert.equal(transferRuntime.isWalkInFlight(later.id), true);

  await store.retry(later.id);

  assert.equal(retries, 1, "one Retry must reach recovery instead of being swallowed by the pre-latch");
  assert.equal(store.getTask(later.id)?.status, "completed");
  assert.equal(isTransferOrRootCancelled(later.id), false);
});
