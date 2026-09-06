import assert from "node:assert/strict";
import test from "node:test";

import type { TransferTask } from "../../../domain/models";
import {
  softPauseTransfer,
  softResumeTransfer,
  type TransferControlHost,
} from "./globalSftpTransferControl";
import {
  isTransferPauseLatched,
  resetTransferPauseLatchesForTests,
} from "./transferPauseLatch";
import {
  registerTransferWalk,
  resetTransferWalkRegistryForTests,
  unregisterTransferWalk,
} from "./transferWalkRegistry";

function makeTask(id: string, status: TransferTask["status"] = "transferring"): TransferTask {
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
  };
}

function createHost(initial: TransferTask[], bridge?: TransferControlHost["getBridge"]): {
  host: TransferControlHost;
  getTasks: () => TransferTask[];
} {
  let tasks = initial.map((t) => ({ ...t }));
  return {
    getTasks: () => tasks,
    host: {
      getTasks: () => tasks,
      setTasks: (next) => { tasks = next; },
      getBridge: bridge ?? (() => undefined),
    },
  };
}

test("an older pause response must not resume a newer pause", async (t) => {
  t.after(resetTransferPauseLatchesForTests);
  let finishFirstPause!: (value: { success: boolean; lifecycleEpoch: number }) => void;
  let calls = 0;
  let backendPaused = true;
  const { host, getTasks } = createHost([makeTask("overlapping-pause")], () => ({
    pauseTransfer: async () => {
      backendPaused = true;
      if (++calls === 1) return new Promise((resolve) => { finishFirstPause = resolve; });
      return { success: true, lifecycleEpoch: 2 };
    },
    resumeTransfer: async () => {
      backendPaused = false;
      return { success: true, lifecycleEpoch: 3 };
    },
  }));
  const first = softPauseTransfer(host, "overlapping-pause");
  await softPauseTransfer(host, "overlapping-pause");
  finishFirstPause({ success: true, lifecycleEpoch: 1 });
  await first;
  assert.equal(getTasks()[0].status, "paused");
  assert.equal(backendPaused, true, "late pause acknowledgement must not restart file writes");
});

test("a delayed resume response must not repaint a newer pause", async (t) => {
  t.after(resetTransferPauseLatchesForTests);
  let finishResume!: (value: { success: boolean; lifecycleEpoch: number }) => void;
  const { host, getTasks } = createHost([makeTask("resume-then-pause", "paused")], () => ({
    resumeTransfer: () => new Promise((resolve) => { finishResume = resolve; }),
    pauseTransfer: async () => ({ success: true, lifecycleEpoch: 3 }),
  }));
  const resume = softResumeTransfer(host, "resume-then-pause");
  await softPauseTransfer(host, "resume-then-pause");
  finishResume({ success: true, lifecycleEpoch: 2 });
  await resume;
  assert.equal(isTransferPauseLatched("resume-then-pause"), true);
  assert.equal(getTasks()[0].status, "paused", "latest user intent must win over an older response");
  assert.equal(getTasks()[0].lifecycleEpoch, 3);
});

test("softPauseTransfer latches and paints paused for a live directory walk without a panel", async () => {
  resetTransferPauseLatchesForTests();
  resetTransferWalkRegistryForTests();
  registerTransferWalk("dir");
  const { host, getTasks } = createHost([
    { ...makeTask("dir"), isDirectory: true, progressMode: "files", totalBytes: 5, transferredBytes: 1 },
    { ...makeTask("c1"), parentTaskId: "dir" },
  ]);

  const outcome = await softPauseTransfer(host, "dir");
  assert.equal(outcome, "paused");
  assert.equal(getTasks().find((t) => t.id === "dir")?.status, "paused");
  assert.equal(isTransferPauseLatched("dir"), true);

  unregisterTransferWalk("dir");
  resetTransferPauseLatchesForTests();
  resetTransferWalkRegistryForTests();
});

test("softResumeTransfer with live walk paints transferring without requiring bridge success", async () => {
  resetTransferPauseLatchesForTests();
  resetTransferWalkRegistryForTests();
  registerTransferWalk("dir");
  const { host, getTasks } = createHost([
    { ...makeTask("dir", "paused"), isDirectory: true, progressMode: "files", totalBytes: 5, transferredBytes: 1, speed: 0 },
  ]);

  const handled = await softResumeTransfer(host, "dir");
  assert.equal(handled.handled, true);
  assert.equal(getTasks().find((t) => t.id === "dir")?.status, "transferring");
  assert.equal(isTransferPauseLatched("dir"), false);

  unregisterTransferWalk("dir");
  resetTransferPauseLatchesForTests();
  resetTransferWalkRegistryForTests();
});

test("single-file softResume with live walk + bridge resume fail returns false (no false transferring)", async () => {
  resetTransferPauseLatchesForTests();
  resetTransferWalkRegistryForTests();
  registerTransferWalk("file-1");
  const { host, getTasks } = createHost(
    [{ ...makeTask("file-1", "paused"), transferredBytes: 10, speed: 0 }],
    () => ({
      resumeTransfer: async () => ({ success: false, reason: "not active" }),
      pauseTransfer: async () => ({ success: true, checkpointBytes: 10, lifecycleEpoch: 1 }),
    }),
  );

  const handled = await softResumeTransfer(host, "file-1");
  assert.equal(handled.handled, false, "must not soft-succeed when every bridge resume fails");
  assert.match(handled.reason || "", /not active/i);
  // Must not paint transferring — hard reconnect path must remain available.
  assert.notEqual(getTasks().find((t) => t.id === "file-1")?.status, "transferring");

  unregisterTransferWalk("file-1");
  resetTransferPauseLatchesForTests();
  resetTransferWalkRegistryForTests();
});

test("directory softResume with live walk and no bridge success still rejoins", async () => {
  resetTransferPauseLatchesForTests();
  resetTransferWalkRegistryForTests();
  registerTransferWalk("dir-2");
  const { host, getTasks } = createHost(
    [{ ...makeTask("dir-2", "paused"), isDirectory: true, progressMode: "files", totalBytes: 3, transferredBytes: 1, speed: 0 }],
    () => ({
      resumeTransfer: async () => ({ success: false, reason: "not active" }),
    }),
  );

  const handled = await softResumeTransfer(host, "dir-2");
  assert.equal(handled.handled, true);
  assert.equal(getTasks().find((t) => t.id === "dir-2")?.status, "transferring");
  // lifecycleEpoch cleared so child stream progress is accepted
  assert.equal(getTasks().find((t) => t.id === "dir-2")?.lifecycleEpoch, undefined);

  unregisterTransferWalk("dir-2");
  resetTransferPauseLatchesForTests();
  resetTransferWalkRegistryForTests();
});

test("single-file softPause demotes dead streams instead of painting paused", async () => {
  resetTransferPauseLatchesForTests();
  resetTransferWalkRegistryForTests();
  const { host, getTasks } = createHost(
    [makeTask("dead-file", "transferring")],
    () => ({
      pauseTransfer: async () => ({ success: false, reason: "Transfer is no longer active" }),
    }),
  );

  const outcome = await softPauseTransfer(host, "dead-file");
  assert.equal(outcome, "interrupted");
  const row = getTasks().find((t) => t.id === "dead-file");
  assert.equal(row?.status, "interrupted");
  assert.equal(row?.reconnectRequired, true);
  assert.match(row?.error || "", /no longer active/i);
  assert.equal(isTransferPauseLatched("dead-file"), false);

  resetTransferPauseLatchesForTests();
  resetTransferWalkRegistryForTests();
});

test("soft resume without bridge lifecycleEpoch keeps a monotonic epoch (no stale re-pause)", async () => {
  resetTransferPauseLatchesForTests();
  resetTransferWalkRegistryForTests();
  const { host, getTasks } = createHost(
    [{ ...makeTask("no-epoch", "paused"), lifecycleEpoch: 3, speed: 0 }],
    () => ({
      // Older bridges returned only { success: true } — must not clear epoch.
      resumeTransfer: async () => ({ success: true }),
    }),
  );

  const result = await softResumeTransfer(host, "no-epoch");
  assert.equal(result.handled, true);
  const row = getTasks().find((t) => t.id === "no-epoch");
  assert.equal(row?.status, "transferring");
  assert.equal(row?.lifecycleEpoch, 4, "must advance past pause epoch when bridge omits epoch");

  resetTransferPauseLatchesForTests();
  resetTransferWalkRegistryForTests();
});

test("soft pause/resume stamps bridge lifecycleEpoch so later progress is not stale-dropped", async () => {
  resetTransferPauseLatchesForTests();
  resetTransferWalkRegistryForTests();
  let bridgeEpoch = 0;
  const { host, getTasks } = createHost(
    [makeTask("stream", "transferring")],
    () => ({
      pauseTransfer: async () => {
        bridgeEpoch += 1;
        return { success: true, checkpointBytes: 10, lifecycleEpoch: bridgeEpoch };
      },
      resumeTransfer: async () => {
        bridgeEpoch += 1;
        return { success: true, lifecycleEpoch: bridgeEpoch };
      },
    }),
  );

  // Double soft-pause (second hits already-paused — still returns bridge epoch).
  await softPauseTransfer(host, "stream");
  await softPauseTransfer(host, "stream");
  const pausedEpoch = getTasks().find((t) => t.id === "stream")?.lifecycleEpoch;
  assert.ok(typeof pausedEpoch === "number" && pausedEpoch > 0);

  const handled = await softResumeTransfer(host, "stream");
  assert.equal(handled.handled, true);
  const resumed = getTasks().find((t) => t.id === "stream");
  assert.equal(resumed?.status, "transferring");
  // Bridge-aligned: must equal last resume bridge epoch, not control-plane bumps.
  assert.equal(resumed?.lifecycleEpoch, bridgeEpoch);

  resetTransferPauseLatchesForTests();
  resetTransferWalkRegistryForTests();
});

test("directory softResume stamps bridge epoch only on successIds; queued siblings clear epoch", async () => {
  resetTransferPauseLatchesForTests();
  resetTransferWalkRegistryForTests();
  registerTransferWalk("folder-mix");
  const { host, getTasks } = createHost(
    [
      { ...makeTask("folder-mix", "paused"), isDirectory: true, progressMode: "files", totalBytes: 3, transferredBytes: 1, speed: 0, lifecycleEpoch: 9 },
      { ...makeTask("live-child", "paused"), parentTaskId: "folder-mix", transferredBytes: 50, speed: 0, lifecycleEpoch: 9 },
      { ...makeTask("queued-child", "queued"), parentTaskId: "folder-mix", transferredBytes: 0, speed: 0, lifecycleEpoch: 9 },
    ],
    () => ({
      resumeTransfer: async (id: string) => {
        if (id === "live-child") return { success: true, lifecycleEpoch: 4 };
        return { success: false, reason: "not active" };
      },
    }),
  );

  const handled = await softResumeTransfer(host, "folder-mix");
  assert.equal(handled.handled, true);
  const parent = getTasks().find((t) => t.id === "folder-mix");
  const live = getTasks().find((t) => t.id === "live-child");
  const queued = getTasks().find((t) => t.id === "queued-child");
  assert.equal(parent?.status, "transferring");
  assert.equal(parent?.lifecycleEpoch, 4, "parent gets max of successful child bridge epochs");
  assert.equal(live?.status, "transferring");
  assert.equal(live?.lifecycleEpoch, 4, "resumed child keeps its bridge epoch");
  assert.equal(queued?.status, "queued");
  assert.equal(queued?.lifecycleEpoch, undefined, "non-resumed sibling must not inherit parent resume epoch");

  unregisterTransferWalk("folder-mix");
  resetTransferPauseLatchesForTests();
  resetTransferWalkRegistryForTests();
});

for (const isDirectory of [false, true]) {
  for (const newerLocalPause of [false, true]) {
    test(`cross-window resume releases ${isDirectory ? "folder" : "file"} latches unless local pause is newer: ${newerLocalPause}`, async (t) => {
      t.after(resetTransferPauseLatchesForTests);
      let finish!: (result: { success: boolean; superseded: true; supersededBy: "resume" }) => void;
      let pauses = 0;
      const id = `remote-resume-${isDirectory}-${newerLocalPause}`;
      const initial: TransferTask[] = [{ ...makeTask(id), isDirectory }];
      if (isDirectory) initial.push({ ...makeTask(`${id}-child`), parentTaskId: id });
      const { host, getTasks } = createHost(initial, () => ({
        pauseTransfer: () => ++pauses === 1
          ? new Promise((resolve) => { finish = resolve; })
          : Promise.resolve({ success: true, lifecycleEpoch: 9 }),
      }));
      const pending = softPauseTransfer(host, id);
      host.setTasks(getTasks().map(task => isDirectory && task.id === id ? task : ({ ...task, status: "transferring", lifecycleEpoch: 8 })));
      if (newerLocalPause) await softPauseTransfer(host, id);
      finish({ success: false, superseded: true, supersededBy: "resume" });
      await pending;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(isTransferPauseLatched(id), newerLocalPause, "authoritative resume must release the old root pause barrier");
      assert.equal(getTasks().find(task => task.id === id)?.status, newerLocalPause ? "paused" : "transferring");
      if (isDirectory) assert.equal(isTransferPauseLatched(`${id}-child`), newerLocalPause);
    });
  }
}

for (const action of ["pause", "resume"] as const) {
  test(`superseded cross-window ${action} preserves authoritative paused state`, async (t) => {
    t.after(resetTransferPauseLatchesForTests);
    let finish!: (result: { success: boolean; superseded: boolean }) => void;
    const deferred = () => new Promise<{ success: boolean; superseded: boolean }>((resolve) => { finish = resolve; });
    const { host, getTasks } = createHost([makeTask(`cross-window-${action}`, action === "pause" ? "transferring" : "paused")], () => ({ pauseTransfer: deferred, resumeTransfer: deferred }));
    const id = getTasks()[0].id;
    const operation = action === "pause" ? softPauseTransfer(host, id) : softResumeTransfer(host, id);
    // A global event from another window changes lifecycle, not this window's local control epoch.
    host.setTasks(getTasks().map(task => ({ ...task, status: "paused", lifecycleEpoch: 8 })));
    finish({ success: false, superseded: true });
    const result = await operation;
    assert.equal(getTasks()[0].status, "paused");
    assert.equal(getTasks()[0].lifecycleEpoch, 8);
    if (action === "pause") assert.equal(isTransferPauseLatched(id), true);
    else assert.deepEqual(result, { handled: true }, "obsolete response must not trigger dedicated recovery");
  });
}

for (const isDirectory of [false, true]) {
  test(`remote pause restores released ${isDirectory ? "folder" : "file"} barriers after stale resume`, async (t) => {
    t.after(resetTransferPauseLatchesForTests);
    const id = `remote-pause-${isDirectory}`;
    const tasks: TransferTask[] = [{ ...makeTask(id, "paused"), isDirectory }];
    if (isDirectory) tasks.push({ ...makeTask(`${id}-child`, "paused"), parentTaskId: id });
    const { host, getTasks } = createHost(tasks, () => ({
      resumeTransfer: async () => ({ success: false, superseded: true, supersededBy: "pause" }),
    }));
    assert.deepEqual(await softResumeTransfer(host, id), { handled: true });
    assert.equal(isTransferPauseLatched(id), true);
    if (isDirectory) assert.equal(isTransferPauseLatched(`${id}-child`), true);
    assert.equal(getTasks()[0].status, "paused");
  });
}

test("a child-only remote resume does not release the folder pause", async (t) => {
  t.after(resetTransferPauseLatchesForTests);
  const { host } = createHost([
    { ...makeTask("mixed-root"), isDirectory: true },
    { ...makeTask("mixed-one"), parentTaskId: "mixed-root" },
    { ...makeTask("mixed-two"), parentTaskId: "mixed-root" },
  ], () => ({ pauseTransfer: async id => id === "mixed-one"
    ? { success: false, superseded: true, supersededBy: "resume" }
    : { success: true } }));
  await softPauseTransfer(host, "mixed-root");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(isTransferPauseLatched("mixed-root"), true);
  assert.equal(isTransferPauseLatched("mixed-two"), true);
});

test("directory resume joins successful and remotely resumed children", async (t) => {
  t.after(resetTransferPauseLatchesForTests);
  const id = "mixed-success-resume";
  const { host, getTasks } = createHost([
    { ...makeTask(id, "paused"), isDirectory: true },
    { ...makeTask(`${id}-one`, "paused"), parentTaskId: id },
    { ...makeTask(`${id}-two`, "paused"), parentTaskId: id },
  ], () => ({ resumeTransfer: async childId => childId === `${id}-one`
    ? { success: true, lifecycleEpoch: 3 }
    : { success: false, superseded: true, supersededBy: "resume" } }));
  assert.deepEqual(await softResumeTransfer(host, id), { handled: true });
  assert.equal(getTasks().find(task => task.id === id)?.status, "transferring");
  assert.equal(isTransferPauseLatched(id), false);
});

for (const newerPause of [false, true]) {
  test(`directory live resume rejection is ignored only when superseded: ${newerPause}`, async (t) => {
    t.after(resetTransferPauseLatchesForTests);
    t.after(resetTransferWalkRegistryForTests);
    const id = `rejected-folder-resume-${newerPause}`;
    registerTransferWalk(id);
    let rejectResume!: (error: Error) => void;
    let backendPaused = true;
    const { host, getTasks } = createHost([
      { ...makeTask(id, "paused"), isDirectory: true },
      { ...makeTask(`${id}-child`, "paused"), parentTaskId: id },
    ], () => ({
      resumeTransfer: () => new Promise((_, reject) => { rejectResume = reject; }),
      pauseTransfer: async () => { backendPaused = true; return { success: true, lifecycleEpoch: 4 }; },
    }));
    const running = softResumeTransfer(host, id);
    if (newerPause) await softPauseTransfer(host, id);
    rejectResume(new Error("resume transport disconnected"));
    const result = await running;
    assert.equal(result.handled, newerPause);
    if (!newerPause) assert.match(result.reason || "", /resume transport disconnected/);
    assert.equal(backendPaused, true);
    assert.equal(getTasks().find(task => task.id === id)?.status, "paused");
    if (newerPause) assert.equal(isTransferPauseLatched(id), true);
  });
}

for (const newerResume of [false, true]) {
  test(`partial folder resume rejection reports running and paused children unless superseded: ${newerResume}`, async (t) => {
    t.after(resetTransferPauseLatchesForTests);
    const id = `partial-reject-${newerResume}`;
    const successfulId = `${id}-one`;
    let rejectResume!: (error: Error) => void;
    let successfulBackendPaused = true;
    let round = 0;
    let rollbackCalls = 0;
    const { host, getTasks } = createHost([
      { ...makeTask(id, "paused"), isDirectory: true },
      { ...makeTask(successfulId, "paused"), parentTaskId: id },
      { ...makeTask(`${id}-two`, "paused"), parentTaskId: id },
    ], () => ({
      resumeTransfer: async childId => {
        if (childId === successfulId) { successfulBackendPaused = false; return { success: true }; }
        if (round > 0) return { success: true };
        return new Promise((_, reject) => { rejectResume = reject; });
      },
      pauseTransfer: async childId => {
        rollbackCalls++;
        if (childId === successfulId) successfulBackendPaused = true;
        return { success: true };
      },
    }));
    const running = softResumeTransfer(host, id);
    if (newerResume) { round++; await softResumeTransfer(host, id); }
    rejectResume(new Error("second child IPC rejected"));
    const result = await running;
    assert.equal(result.handled, true);
    assert.equal(successfulBackendPaused, false, "successful child keeps running after partial resume");
    assert.equal(rollbackCalls, 0, "partial reporting must not introduce compensating controls");
    assert.equal(getTasks()[0].status, "transferring", "root must report the successful child still running");
    assert.equal(isTransferPauseLatched(id), false);
    const rejected = getTasks().find(task => task.id === `${id}-two`);
    assert.equal(rejected?.status, newerResume ? "transferring" : "paused");
    assert.equal(isTransferPauseLatched(`${id}-two`), !newerResume);
    if (!newerResume) assert.match(rejected?.error || "", /second child IPC rejected/);
  });
}

for (const resolvedFailure of [false, true]) {
test(`remote-resumed child remains visibly running when sibling resume fails: resolved=${resolvedFailure}`, async (t) => {
  t.after(resetTransferPauseLatchesForTests);
  const id = "remote-partial-reject";
  const runningId = `${id}-one`;
  const rejectedId = `${id}-two`;
  const { host, getTasks } = createHost([
    { ...makeTask(id, "paused"), isDirectory: true },
    { ...makeTask(runningId, "paused"), parentTaskId: id },
    { ...makeTask(rejectedId, "paused"), parentTaskId: id },
  ], () => ({ resumeTransfer: async childId => {
    if (childId === rejectedId) {
      if (resolvedFailure) return { success: false, reason: "sibling resume rejected" };
      throw new Error("sibling resume rejected");
    }
    host.setTasks(getTasks().map(task => task.id === runningId ? { ...task, status: "transferring", lifecycleEpoch: 8 } : task));
    return { success: false, superseded: true, supersededBy: "resume" };
  } }));
  assert.equal((await softResumeTransfer(host, id)).handled, true);
  assert.equal(getTasks()[0].status, "transferring");
  assert.equal(isTransferPauseLatched(id), false);
  assert.equal(getTasks().find(task => task.id === runningId)?.status, "transferring");
  assert.equal(getTasks().find(task => task.id === runningId)?.lifecycleEpoch, 8);
  assert.equal(getTasks().find(task => task.id === rejectedId)?.status, "paused");
  assert.equal(isTransferPauseLatched(rejectedId), true);
  assert.match(getTasks().find(task => task.id === rejectedId)?.error || "", /sibling resume rejected/);
});

}

for (const newerResume of [false, true]) {
  test(`resolved verification failure holds live folder unless newer resume won: ${newerResume}`, async (t) => {
    t.after(resetTransferPauseLatchesForTests);
    t.after(resetTransferWalkRegistryForTests);
    const id = `resolved-verification-${newerResume}`;
    registerTransferWalk(id);
    let finish!: (value: { success: boolean; reason: string }) => void;
    let calls = 0;
    const { host, getTasks } = createHost([
      { ...makeTask(id, "paused"), isDirectory: true },
      { ...makeTask(`${id}-child`, "paused"), parentTaskId: id },
    ], () => ({ resumeTransfer: () => ++calls === 1
      ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ success: true }) }));
    const running = softResumeTransfer(host, id);
    if (newerResume) await softResumeTransfer(host, id);
    finish({ success: false, reason: "Could not verify the source file for resume" });
    const result = await running;
    assert.equal(result.handled, newerResume);
    if (!newerResume) assert.match(result.reason || "", /verify the source file/);
    assert.equal(getTasks()[0].status, newerResume ? "transferring" : "paused");
    assert.equal(isTransferPauseLatched(id), !newerResume);
    assert.equal(isTransferPauseLatched(`${id}-child`), !newerResume);
  });
}
