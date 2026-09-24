import assert from "node:assert/strict";
import test from "node:test";

import type { TransferTask } from "./models";
import { createEmptyDirectoryResumeCheckpoint } from "./sftpDirectoryCheckpoint";
import {
  createSftpTransferCenter,
  deserializeSftpTransferCenter,
  pruneSftpTransferHistory,
  serializeSftpTransferCenter,
  validateTransferResumeSource,
} from "./sftpTransferCenter";

const task = (id: string, status: TransferTask["status"], startTime: number): TransferTask => ({
  id,
  fileName: `${id}.bin`,
  sourcePath: `/source/${id}.bin`,
  targetPath: `/target/${id}.bin`,
  sourceConnectionId: "local",
  targetConnectionId: "remote-1",
  targetHostId: "host-1",
  direction: "upload",
  status,
  totalBytes: 100,
  transferredBytes: status === "completed" ? 100 : 25,
  speed: 0,
  startTime,
  isDirectory: false,
  origin: "manual",
  resumable: true,
});

test("global transfer center queues fairly and promotes a task to the front", () => {
  const center = createSftpTransferCenter({ concurrency: 2 });
  center.add("panel-a", [task("a", "queued", 1), task("b", "queued", 2)]);
  center.add("panel-b", [task("c", "queued", 3)]);

  assert.deepEqual(center.takeRunnable().map((item) => item.id), ["a", "c"]);
  center.prioritize("b");
  center.complete("a");

  assert.deepEqual(center.takeRunnable().map((item) => item.id), ["b"]);
});

test("pause and resume preserve the transfer checkpoint", () => {
  const center = createSftpTransferCenter({ concurrency: 1 });
  center.add("panel-a", [task("a", "transferring", 1)]);
  center.update("a", { transferredBytes: 48, checkpointBytes: 48 });
  center.pause("a");

  assert.equal(center.getTask("a")?.status, "paused");
  assert.equal(center.getTask("a")?.transferredBytes, 48);
  assert.equal(center.getTask("a")?.checkpointBytes, 48);

  center.resume("a");
  assert.equal(center.getTask("a")?.status, "queued");
  assert.equal(center.getTask("a")?.checkpointBytes, 48);
});

test("restoring already-interrupted rows still requires reconnect after force-quit", () => {
  const raw = JSON.stringify({
    version: 1,
    tasks: [{
      id: "was-interrupted",
      fileName: "a.txt",
      sourcePath: "/s/a.txt",
      targetPath: "/t/a.txt",
      sourceConnectionId: "local",
      targetConnectionId: "remote",
      direction: "upload",
      status: "interrupted",
      totalBytes: 10,
      transferredBytes: 3,
      speed: 1,
      startTime: Date.now() - 1000,
      isDirectory: false,
      // Stale process left reconnectRequired false / lifecycle epoch set.
      reconnectRequired: false,
      lifecycleEpoch: 9,
      targetHostId: "host-1",
    }],
  });
  const restored = deserializeSftpTransferCenter(raw);
  assert.equal(restored.tasks[0]?.status, "interrupted");
  assert.equal(restored.tasks[0]?.reconnectRequired, true);
  assert.equal(restored.tasks[0]?.lifecycleEpoch, undefined);
  assert.equal(restored.tasks[0]?.speed, 0);
});

test("restoring persisted state interrupts unfinished work and ignores secrets", () => {
  const restored = deserializeSftpTransferCenter(JSON.stringify({
    version: 1,
    tasks: [{
      ...task("a", "transferring", 1),
      phase: "transferring",
      password: "must-not-survive",
      privateKey: "must-not-survive",
    }],
  }));

  assert.equal(restored.tasks[0]?.status, "interrupted");
  assert.equal(restored.tasks[0]?.reconnectRequired, true);
  assert.equal(restored.tasks[0]?.phase, undefined);
  assert.equal("password" in (restored.tasks[0] ?? {}), false);
  assert.equal("privateKey" in (restored.tasks[0] ?? {}), false);
});

test("restoring a paused task also marks it interrupted after restart", () => {
  const restored = deserializeSftpTransferCenter(JSON.stringify({
    version: 1,
    tasks: [{
      ...task("paused", "paused", 1),
      phase: "transferring",
      checkpointBytes: 40,
      lifecycleEpoch: 7,
    }],
  }));

  assert.equal(restored.tasks[0]?.status, "interrupted");
  assert.equal(restored.tasks[0]?.reconnectRequired, true);
  assert.equal(restored.tasks[0]?.phase, undefined);
  assert.equal(restored.tasks[0]?.checkpointBytes, 40);
  assert.equal(restored.tasks[0]?.lifecycleEpoch, undefined);
});

test("remembered local target identity survives transfer persistence", () => {
  const original = {
    ...task("guarded-download", "transferring", 1),
    direction: "download" as const,
    expectedLocalTarget: {
      parentRealPath: "/target",
      parentIdentity: "1:2",
      parentBirthtimeNs: "100",
      targetIdentity: "1:3",
      targetBirthtimeNs: "200",
      targetCtimeNs: "201",
    },
  };
  const restored = deserializeSftpTransferCenter(serializeSftpTransferCenter([original]));
  assert.equal(restored.tasks[0]?.status, "interrupted");
  assert.deepEqual(restored.tasks[0]?.expectedLocalTarget, original.expectedLocalTarget);
});

test("malformed saved target identity fails closed", () => {
  const restored = deserializeSftpTransferCenter(JSON.stringify({
    version: 1,
    tasks: [{ ...task("guarded-download", "paused", 1), expectedLocalTarget: { targetIdentity: "1:3" } }],
  }));
  assert.deepEqual(restored.tasks[0]?.expectedLocalTarget, {
    parentRealPath: "", parentIdentity: "", parentBirthtimeNs: "",
    targetIdentity: "", targetBirthtimeNs: "", targetCtimeNs: "",
  });
});

test("restoring terminal tasks strips stale conflict payloads (skip-without-clear legacy)", () => {
  const conflict = {
    transferId: "css-dir",
    fileName: "css",
    sourcePath: "/src/css",
    targetPath: "/dst/css",
    isDirectory: true,
    existingType: "directory" as const,
    existingSize: 8192,
    newSize: 0,
    existingModified: 1,
    newModified: 2,
  };
  const restored = deserializeSftpTransferCenter(JSON.stringify({
    version: 1,
    tasks: [{
      ...task("css-dir", "cancelled", 1),
      isDirectory: true,
      conflict,
      endTime: Date.now(),
    }, {
      ...task("still-open", "attention", 2),
      isDirectory: true,
      conflict: { ...conflict, transferId: "still-open" },
    }],
  }));

  assert.equal(restored.tasks[0]?.status, "cancelled");
  assert.equal(restored.tasks[0]?.conflict, undefined);
  assert.equal(restored.tasks[1]?.status, "attention");
  assert.equal(restored.tasks[1]?.conflict?.fileName, "css");
});

test("history keeps unfinished tasks and caps terminal tasks by age and count", () => {
  const now = Date.UTC(2026, 6, 23);
  const old = now - 31 * 24 * 60 * 60 * 1000;
  const recent = now - 1000;
  const tasks = [
    task("paused", "paused", old),
    task("old", "completed", old),
    ...Array.from({ length: 205 }, (_, index) => task(`done-${index}`, "completed", recent + index)),
  ];

  const pruned = pruneSftpTransferHistory(tasks, now);
  assert.equal(pruned.some((item) => item.id === "paused"), true);
  assert.equal(pruned.some((item) => item.id === "old"), false);
  assert.equal(pruned.filter((item) => item.status === "completed").length, 200);
});

test("resume rejects changed or shortened source files", () => {
  const resumable = {
    ...task("a", "interrupted", 1),
    totalBytes: 100,
    sourceLastModified: 50,
    checkpointBytes: 60,
  };
  assert.equal(validateTransferResumeSource(resumable, { size: 100, lastModified: 50 }), null);
  assert.match(validateTransferResumeSource(resumable, { size: 90, lastModified: 50 }) ?? "", /size changed/);
  assert.match(validateTransferResumeSource(resumable, { size: 100, lastModified: 51 }) ?? "", /modified/);
  assert.match(validateTransferResumeSource(resumable, { size: 40, lastModified: 50 }) ?? "", /checkpoint/);
  // Upload sources still reject growth.
  assert.match(validateTransferResumeSource(resumable, { size: 120, lastModified: 50 }) ?? "", /size changed/);
  // Download snapshots of append-only files may grow; mtime drift is then expected.
  assert.equal(
    validateTransferResumeSource(
      resumable,
      { size: 120, lastModified: 51 },
      { allowSourceGrowth: true },
    ),
    null,
  );
  // Shrink remains unsafe even when growth is allowed.
  assert.match(
    validateTransferResumeSource(
      resumable,
      { size: 90, lastModified: 50 },
      { allowSourceGrowth: true },
    ) ?? "",
    /size changed/,
  );
  // Explicit zero-byte download snapshots may also grow (empty log → first lines).
  const emptyPlan = {
    ...task("empty", "interrupted", 1),
    totalBytes: 0,
    sourceLastModified: 50,
    checkpointBytes: 0,
  };
  assert.equal(
    validateTransferResumeSource(
      emptyPlan,
      { size: 40, lastModified: 51 },
      { allowSourceGrowth: true },
    ),
    null,
  );
  assert.match(
    validateTransferResumeSource(
      emptyPlan,
      { size: 0, lastModified: 51 },
      { allowSourceGrowth: true },
    ) ?? "",
    /modified/,
  );
});

test("resume skips size-based validation when the source size is unknown", () => {
  // Stat-less SCP endpoints report size as a placeholder 0 (sizeKnown false).
  // Saved progress must not be misread as a shrunk/changed source.
  const resumable = {
    ...task("scp", "interrupted", 1),
    totalBytes: 100,
    sourceLastModified: 50,
    checkpointBytes: 60,
  };
  assert.equal(
    validateTransferResumeSource(
      resumable,
      { size: 0, lastModified: 50, sizeKnown: false },
      { allowSourceGrowth: true },
    ),
    null,
  );
  // mtime drift is still detectable without a size.
  assert.match(
    validateTransferResumeSource(
      resumable,
      { size: 0, lastModified: 51, sizeKnown: false },
    ) ?? "",
    /modified/,
  );
  // The mtime guard is skipped while growth is allowed (append-only updates).
  assert.equal(
    validateTransferResumeSource(
      resumable,
      { size: 0, lastModified: 51, sizeKnown: false },
      { allowSourceGrowth: true },
    ),
    null,
  );
});

test("prune upgrades legacy completed children into the parent checkpoint", () => {
  const now = Date.now();
  const parent: TransferTask = {
    ...task("dir", "interrupted", now - 1000),
    isDirectory: true,
    fileName: "folder",
  };
  const children = Array.from({ length: 5 }, (_, i) => ({
    ...task(`child-${i}`, "completed", now - 500 + i),
    parentTaskId: "dir",
    endTime: now - 400,
  }));
  // Add many other terminal tasks that would push children out of the cap.
  const noise = Array.from({ length: 220 }, (_, i) => ({
    ...task(`old-${i}`, "completed", now - 10_000 + i),
    endTime: now - 1000 + i,
  }));
  const pruned = pruneSftpTransferHistory([parent, ...children, ...noise], now);
  assert.deepEqual(pruned.filter((item) => item.id === "dir").map((item) => item.id), ["dir"]);
  assert.equal(pruned.some((item) => item.parentTaskId === "dir"), false);
  assert.equal(pruned.find((item) => item.id === "dir")?.directoryResumeCheckpoint?.completedEntries, 5);
});

test("prune compacts 50,000 completed directory children into a bounded parent checkpoint", () => {
  const pruneStartedAt = Date.now();
  const now = Date.now();
  const parent: TransferTask = {
    ...task("huge-dir", "interrupted", now - 1000),
    isDirectory: true,
    fileName: "huge-folder",
    totalBytes: 50_000,
    transferredBytes: 50_000,
  };
  const children = Array.from({ length: 50_000 }, (_, index) => ({
    ...task(`huge-child-${index}`, "completed", now - 500 + index),
    parentTaskId: parent.id,
    sourcePath: `/source/file-${index}`,
    targetPath: `/target/file-${index}`,
    endTime: now,
    directoryEntryIndex: index,
    directoryEntryIdentity: index.toString(16).padStart(64, "0"),
  } as TransferTask));

  const pruned = pruneSftpTransferHistory([parent, ...children], now);
  const compactedParent = pruned.find((item) => item.id === parent.id) as TransferTask & {
    directoryResumeCheckpoint?: { coveredEntries: number; completedEntries: number };
  };

  assert.equal(pruned.length, 1, "completed children must leave the full task array");
  assert.equal(compactedParent.directoryResumeCheckpoint?.coveredEntries, 50_000);
  assert.equal(compactedParent.directoryResumeCheckpoint?.completedEntries, 50_000);
  assert.ok(
    serializeSftpTransferCenter(pruned).length < 10_000,
    "persisted history must stay bounded instead of serializing every completed child",
  );
  const restored = deserializeSftpTransferCenter(serializeSftpTransferCenter(pruned));
  assert.equal(restored.tasks.length, 1);
  assert.equal(restored.tasks[0]?.directoryResumeCheckpoint?.version, 2);
  assert.equal(restored.tasks[0]?.directoryResumeCheckpoint?.completedEntries, 50_000);
  assert.ok(Date.now() - pruneStartedAt < 5_000, "50k compaction should finish within 5 seconds");
});

test("history pruning groups many directory parents without quadratic rescans", () => {
  const now = Date.now();
  const tasks: TransferTask[] = [];
  for (let index = 0; index < 20_000; index += 1) {
    const parent: TransferTask = {
      ...task(`many-parent-${index}`, "paused", index),
      isDirectory: true,
      directoryResumeCheckpoint: createEmptyDirectoryResumeCheckpoint(),
    };
    tasks.push(parent, {
      ...task(`many-child-${index}`, "paused", index),
      parentTaskId: parent.id,
      directoryEntryIndex: 0,
      directoryEntryIdentity: "a".repeat(64),
    });
  }

  const startedAt = Date.now();
  const pruned = pruneSftpTransferHistory(tasks, now);
  assert.equal(pruned.length, tasks.length);
  assert.ok(Date.now() - startedAt < 2_000, "parent grouping should stay linear");
});

test("out-of-order completion keeps the unfinished hole while compacting the later child", () => {
  const now = Date.now();
  const parent: TransferTask = {
    ...task("out-of-order-dir", "paused", now - 1000),
    isDirectory: true,
    totalBytes: 2,
    transferredBytes: 1,
  };
  const unfinished = {
    ...task("index-0", "paused", now),
    parentTaskId: parent.id,
    directoryEntryIndex: 0,
    directoryEntryIdentity: "a".repeat(64),
  } as TransferTask;
  const completed = {
    ...task("index-1", "completed", now),
    parentTaskId: parent.id,
    directoryEntryIndex: 1,
    directoryEntryIdentity: "b".repeat(64),
  } as TransferTask;

  const pruned = pruneSftpTransferHistory([parent, unfinished, completed], now);
  const compactedParent = pruned.find((item) => item.id === parent.id)!;

  assert.deepEqual(pruned.map((item) => item.id).sort(), [parent.id, unfinished.id].sort());
  assert.equal(compactedParent.directoryResumeCheckpoint?.coveredEntries, 2);
  assert.equal(compactedParent.directoryResumeCheckpoint?.completedEntries, 1);
  assert.equal(pruned.find((item) => item.id === unfinished.id)?.status, "paused");
});

test("failed directory history drops an ambiguous compact checkpoint before child history is capped", () => {
  const now = Date.now();
  const parent: TransferTask = {
    ...task("failed-dir", "failed", now - 1000),
    isDirectory: true,
    checkpointBytes: 500,
    endTime: now,
    directoryResumeCheckpoint: {
      version: 1,
      coveredEntries: 500,
      completedEntries: 0,
      manifestHash: "a".repeat(64),
    },
  };
  const failedChildren = Array.from({ length: 500 }, (_, index) => ({
    ...task(`failed-child-${index}`, "failed", now - 900 + index),
    parentTaskId: parent.id,
    directoryEntryIndex: index,
    directoryEntryIdentity: index.toString(16).padStart(64, "0"),
    endTime: now - 1 - index,
  } as TransferTask));

  const pruned = pruneSftpTransferHistory([parent, ...failedChildren], now);
  const retainedParent = pruned.find((item) => item.id === parent.id);
  assert.equal(retainedParent?.directoryResumeCheckpoint, undefined);
  assert.ok(pruned.length <= 200);
});
