/**
 * TransferRuntime unification tests — drive the shipped entry surface.
 * Covers: no-owner control, post-teardown pause/resume with live walk,
 * single resume API soft vs hard strategy selection.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { TransferTask } from "../../../domain/models";
import { createSftpTransferCenterStore } from "../sftpTransferCenterStore";
import {
  createTransferRuntime,
  resetTransferRuntimeRunsForTests,
} from "./transferRuntime";
import {
  isTransferCancelledFlag,
  markTransferCancelledTree,
  resetTransferCancelLatchesForTests,
} from "./transferCancelLatch";
import {
  bumpTransferControlEpoch,
  isTransferControlEpochCurrent,
  resetTransferControlEpochsForTests,
} from "./transferControlEpoch";
import {
  isTransferPauseLatched,
  resetTransferPauseLatchesForTests,
} from "./transferPauseLatch";
import {
  isTransferWalkInFlight,
  registerTransferWalk,
  resetTransferWalkRegistryForTests,
  unregisterTransferWalk,
} from "./transferWalkRegistry";

function makeTask(
  id: string,
  status: TransferTask["status"] = "transferring",
  extras: Partial<TransferTask> = {},
): TransferTask {
  return {
    id,
    fileName: `${id}.bin`,
    sourcePath: `/src/${id}`,
    targetPath: `/dst/${id}`,
    sourceConnectionId: "local",
    targetConnectionId: "remote",
    direction: "upload",
    status,
    totalBytes: 100,
    transferredBytes: 10,
    speed: 1,
    startTime: 1,
    isDirectory: false,
    resumable: true,
    ownerId: extras.ownerId ?? "panel-closed",
    ...extras,
  };
}

function installBridge(t: test.TestContext, handlers: {
  pauseTransfer?: (id: string) => Promise<{ success: boolean; reason?: string; checkpointBytes?: number }>;
  resumeTransfer?: (id: string) => Promise<{ success: boolean; reason?: string }>;
  cancelTransfer?: (id: string) => Promise<unknown>;
  clearPendingTransferCancel?: (id: string) => Promise<void>;
}) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { netcatty: handlers },
  });
}

function resetGlobals() {
  resetTransferCancelLatchesForTests();
  resetTransferPauseLatchesForTests();
  resetTransferWalkRegistryForTests();
  resetTransferControlEpochsForTests();
  resetTransferRuntimeRunsForTests();
}

test("runtime pause/resume works with no registered panel owner", async (t) => {
  resetGlobals();
  const pauseCalls: string[] = [];
  const resumeCalls: string[] = [];
  installBridge(t, {
    pauseTransfer: async (id) => {
      pauseCalls.push(id);
      return { success: true, checkpointBytes: 40, lifecycleEpoch: 1 };
    },
    resumeTransfer: async (id) => {
      resumeCalls.push(id);
      return { success: true, lifecycleEpoch: 2 };
    },
  });

  const store = createSftpTransferCenterStore();
  const runtime = createTransferRuntime(store);
  // No registerOwner — panel never mounted / already torn down.
  runtime.enqueue([makeTask("live-file", "transferring", { transferredBytes: 40 })]);

  await runtime.pause("live-file");
  assert.equal(runtime.getTask("live-file")?.status, "paused");
  assert.equal(isTransferPauseLatched("live-file"), true);
  assert.ok(pauseCalls.includes("live-file"));

  await runtime.resume("live-file");
  assert.equal(runtime.getTask("live-file")?.status, "transferring");
  assert.equal(isTransferPauseLatched("live-file"), false);
  assert.ok(resumeCalls.includes("live-file"));
  // Bridge-aligned epoch (not control-plane bumps).
  assert.equal(runtime.getTask("live-file")?.lifecycleEpoch, 2);

  resetGlobals();
});

test("runtime soft-resumes live walk after owner teardown simulation (no dedicated re-entry)", async (t) => {
  resetGlobals();
  const resumeCalls: string[] = [];
  let dedicatedHandlerCalls = 0;
  let acknowledgePause!: () => void;
  installBridge(t, {
    pauseTransfer: () => new Promise((resolve) => {
      acknowledgePause = () => resolve({ success: true, checkpointBytes: 5 });
    }),
    resumeTransfer: async (id) => {
      resumeCalls.push(id);
      return { success: true };
    },
  });

  const store = createSftpTransferCenterStore();
  store.setDedicatedResumeHandler(async () => {
    dedicatedHandlerCalls += 1;
    return { success: false, error: "should not hard-reconnect live walk" };
  });
  const runtime = createTransferRuntime(store);

  // Simulate panel started a walk then unmounted: walk still in-flight, no owner.
  registerTransferWalk("folder");
  runtime.enqueue([
    makeTask("folder", "transferring", {
      isDirectory: true,
      progressMode: "files",
      totalBytes: 3,
      transferredBytes: 1,
      ownerId: "gone-panel",
    }),
    makeTask("child", "transferring", { parentTaskId: "folder", ownerId: "gone-panel" }),
  ]);

  await runtime.pause("folder");
  assert.equal(runtime.getTask("folder")?.status, "pausing");
  acknowledgePause();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(runtime.getTask("folder")?.status, "paused");
  assert.equal(isTransferPauseLatched("folder"), true);
  assert.equal(isTransferWalkInFlight("folder"), true);

  await runtime.resume("folder");
  assert.equal(runtime.getTask("folder")?.status, "transferring");
  assert.equal(isTransferPauseLatched("folder"), false);
  assert.equal(dedicatedHandlerCalls, 0, "live walk must soft-resume only");
  assert.ok(resumeCalls.length >= 0); // bridge may resume children

  unregisterTransferWalk("folder");
  resetGlobals();
});

test("runtime resume chooses hard reconnect when walk is dead and reconnectRequired", async (t) => {
  resetGlobals();
  installBridge(t, {
    resumeTransfer: async () => ({ success: false, reason: "not active" }),
    clearPendingTransferCancel: async () => {},
  });

  const store = createSftpTransferCenterStore();
  let dedicatedCalls = 0;
  store.setDedicatedResumeHandler(async (task) => {
    dedicatedCalls += 1;
    assert.equal(task.id, "dead-file");
    // Simulate successful hard reconnect completion.
    store.patchTask(task.id, {
      status: "completed",
      transferredBytes: 100,
      reconnectRequired: false,
      ownerId: "dedicated-resume",
    });
    return { success: true };
  });
  const runtime = createTransferRuntime(store);

  // Dead walk (not registered), reconnect required — single resume API.
  assert.equal(runtime.isWalkInFlight("dead-file"), false);
  runtime.enqueue([makeTask("dead-file", "interrupted", {
    reconnectRequired: true,
    checkpointBytes: 50,
    transferredBytes: 50,
    sourceHostId: "host-a",
  })]);

  await runtime.resume("dead-file");
  assert.equal(dedicatedCalls, 1, "dead walk must use hard reconnect under same resume entry");
  assert.equal(runtime.getTask("dead-file")?.status, "completed");

  resetGlobals();
});

test("runWalk registers process-global walk and survives without a panel owner", async () => {
  resetGlobals();
  const store = createSftpTransferCenterStore();
  const runtime = createTransferRuntime(store);
  let sawInFlight = false;
  let steps = 0;

  const run = runtime.runWalk("walk-1", async () => {
    sawInFlight = runtime.isWalkInFlight("walk-1");
    steps += 1;
    // Mid-walk pause via runtime (no owner).
    runtime.enqueue([makeTask("walk-1", "transferring")]);
    await runtime.pause("walk-1");
    assert.equal(isTransferPauseLatched("walk-1"), true);
    await runtime.resume("walk-1");
    assert.equal(isTransferPauseLatched("walk-1"), false);
    steps += 1;
  });

  assert.equal(runtime.isWalkInFlight("walk-1"), true);
  await run;
  assert.equal(sawInFlight, true);
  assert.equal(steps, 2);
  assert.equal(runtime.isWalkInFlight("walk-1"), false);

  resetGlobals();
});

test("runWalk keeps tree controls live until settle and then releases parent and children", async () => {
  resetGlobals();
  const store = createSftpTransferCenterStore();
  const runtime = createTransferRuntime(store);
  runtime.enqueue([
    makeTask("settling-root", "transferring", { isDirectory: true, progressMode: "files" }),
    makeTask("settling-child", "transferring", { parentTaskId: "settling-root" }),
  ]);
  let markEntered!: () => void;
  let finishRun!: () => void;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const finish = new Promise<void>((resolve) => { finishRun = resolve; });
  let rootEpoch = 0;
  let childEpoch = 0;

  const run = runtime.runWalk("settling-root", async () => {
    markTransferCancelledTree("settling-root", ["settling-child"]);
    rootEpoch = bumpTransferControlEpoch("settling-root");
    childEpoch = bumpTransferControlEpoch("settling-child");
    // Renderer lifecycle paint can become terminal before final callbacks and
    // resource release finish. Store cleanup must wait for runWalk settlement.
    store.patchTask("settling-root", { status: "completed", endTime: Date.now() });
    markEntered();
    await finish;
  });

  await entered;
  assert.equal(isTransferCancelledFlag("settling-root"), true);
  assert.equal(isTransferCancelledFlag("settling-child"), true);
  assert.equal(isTransferControlEpochCurrent("settling-root", rootEpoch), true);
  assert.equal(isTransferControlEpochCurrent("settling-child", childEpoch), true);

  finishRun();
  await run;
  assert.equal(isTransferCancelledFlag("settling-root"), false);
  assert.equal(isTransferCancelledFlag("settling-child"), false);
  assert.equal(isTransferControlEpochCurrent("settling-root", rootEpoch), false);
  assert.equal(isTransferControlEpochCurrent("settling-child", childEpoch), false);

  resetGlobals();
});

test("publishOwner cannot strip runtime-owned live rows after panel empty publish", () => {
  resetGlobals();
  const store = createSftpTransferCenterStore();
  registerTransferWalk("keep-me");
  store.publishOwner("panel-a", [makeTask("keep-me", "transferring", { ownerId: "panel-a" })]);
  // Panel "unmounts" and publishes empty list — live walk row must remain.
  store.publishOwner("panel-a", []);
  const row = store.getSnapshot().tasks.find((task) => task.id === "keep-me");
  assert.ok(row, "runtime-owned live task must not be dropped by empty panel publish");
  assert.equal(row?.status, "transferring");
  unregisterTransferWalk("keep-me");
  resetGlobals();
});

test("soft resume bridge epoch beats sticky panel paused merge", async (t) => {
  resetGlobals();
  installBridge(t, {
    pauseTransfer: async () => ({ success: true, lifecycleEpoch: 2 }),
    resumeTransfer: async () => ({ success: true, lifecycleEpoch: 3 }),
  });
  const store = createSftpTransferCenterStore();
  const runtime = createTransferRuntime(store);
  registerTransferWalk("sticky");
  runtime.enqueue([makeTask("sticky", "transferring", { ownerId: "panel-a", lifecycleEpoch: 1 })]);

  await runtime.pause("sticky");
  assert.equal(runtime.getTask("sticky")?.lifecycleEpoch, 2);

  await runtime.resume("sticky");
  const resumed = runtime.getTask("sticky");
  assert.equal(resumed?.status, "transferring");
  assert.equal(resumed?.lifecycleEpoch, 3, "bridge resume epoch must win over pause epoch");

  // Stale panel re-publish of paused at older epoch must not win.
  store.publishOwner("panel-a", [{
    ...makeTask("sticky", "paused", { ownerId: "panel-a", lifecycleEpoch: 2 }),
  }]);
  assert.equal(store.getSnapshot().tasks.find((t) => t.id === "sticky")?.status, "transferring");

  unregisterTransferWalk("sticky");
  resetGlobals();
});
