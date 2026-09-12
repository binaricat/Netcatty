import assert from "node:assert/strict";
import test from "node:test";

import type { TransferTask } from "../domain/models";
import {
  buildGlobalTransferProgressDisplay,
  getGlobalConflictActionPresentation,
  getGlobalTransferBadge,
  getGlobalTransferBatchEligibility,
  getGlobalTransferStatusOverride,
  getGlobalTransferBucket,
  getTasksForGlobalTransferBucket,
  isDirectoryParentTask,
  listChildTasksForParent,
  pickActiveChildSummaries,
  shouldShowCollapsedActiveChildren,
  splitBackgroundTransfers,
} from "./GlobalSftpTransferCenter";

test("folder conflicts emphasize merge and mark replace as destructive in the transfer center", () => {
  assert.deepEqual(getGlobalConflictActionPresentation("merge", true), {
    variant: "default",
    destructiveReplace: false,
  });
  assert.deepEqual(getGlobalConflictActionPresentation("replace", true), {
    variant: "outline",
    destructiveReplace: true,
  });
  assert.deepEqual(getGlobalConflictActionPresentation("replace", false), {
    variant: "default",
    destructiveReplace: false,
  });
});

const task = (id: string, status: TransferTask["status"], background = false) => ({
  id,
  fileName: id,
  sourcePath: "/a",
  targetPath: "/b",
  sourceConnectionId: "local",
  targetConnectionId: "remote",
  direction: "upload" as const,
  status,
  totalBytes: 10,
  transferredBytes: 1,
  speed: 1,
  startTime: 1,
  isDirectory: false,
  background,
});

test("global transfer statuses keep paused work separate from items needing attention", () => {
  assert.equal(getGlobalTransferBucket(task("a", "transferring")), "active");
  assert.equal(getGlobalTransferBucket(task("a", "pausing")), "active");
  assert.equal(getGlobalTransferBucket(task("a", "queued")), "queued");
  assert.equal(getGlobalTransferBucket(task("a", "paused")), "paused");
  assert.equal(getGlobalTransferBucket(task("a", "interrupted")), "attention");
  assert.equal(getGlobalTransferBucket(task("a", "attention")), "attention");
  assert.equal(getGlobalTransferBucket(task("a", "failed")), "attention");
  assert.equal(getGlobalTransferBucket(task("a", "completed")), "completed");
  assert.equal(getGlobalTransferBucket(task("a", "cancelled")), "completed");
});

test("batch actions are disabled when no task can accept them", () => {
  assert.deepEqual(getGlobalTransferBatchEligibility([
    task("done", "completed"),
    task("cancelled", "cancelled"),
  ]), { pausableCount: 0, resumableCount: 0 });

  assert.deepEqual(getGlobalTransferBatchEligibility([
    task("running", "transferring"),
    task("waiting", "queued"),
    task("paused", "paused"),
    { ...task("failed", "failed"), checkpointBytes: 4 },
  ]), { pausableCount: 2, resumableCount: 2 });
});

test("paused transfer errors remain visible instead of looking safely paused", () => {
  assert.equal(getGlobalTransferStatusOverride({
    error: "Upload resume is unavailable",
    pauseUnavailableReason: undefined,
  }), "Upload resume is unavailable");
});

test("the all bucket includes every top-level task regardless of status", () => {
  const tasks = [
    task("a", "transferring"),
    task("b", "queued"),
    task("c", "failed"),
    { ...task("child", "transferring"), parentTaskId: "a" },
  ];
  assert.deepEqual(getTasksForGlobalTransferBucket(tasks, "all").map((item) => item.id), ["a", "b", "c"]);
});

test("badge counts active and queued work while surfacing attention", () => {
  assert.deepEqual(getGlobalTransferBadge([
    task("a", "transferring"),
    task("b", "queued"),
    task("c", "failed"),
  ]), { count: 2, hasAttention: true });
});

test("badge does not double count child files in a folder transfer", () => {
  assert.deepEqual(getGlobalTransferBadge([
    task("parent", "transferring"),
    { ...task("child", "transferring"), parentTaskId: "parent" },
  ]), { count: 1, hasAttention: false });
});

test("successful background work is collapsed but failures stay visible", () => {
  const split = splitBackgroundTransfers([
    task("a", "completed", true),
    task("b", "failed", true),
    task("c", "completed", false),
  ]);
  assert.deepEqual(split.visible.map((item) => item.id), ["b", "c"]);
  assert.deepEqual(split.collapsed.map((item) => item.id), ["a"]);
});

test("directory parent detection matches side-queue file-count semantics", () => {
  assert.equal(isDirectoryParentTask({
    isDirectory: true,
    parentTaskId: undefined,
    progressMode: "files",
  }), true);
  assert.equal(isDirectoryParentTask({
    isDirectory: true,
    parentTaskId: undefined,
    progressMode: undefined,
  }), true);
  assert.equal(isDirectoryParentTask({
    isDirectory: true,
    parentTaskId: "p",
    progressMode: "files",
  }), false);
  assert.equal(isDirectoryParentTask({
    isDirectory: false,
    parentTaskId: undefined,
    progressMode: "bytes",
  }), false);
  assert.equal(isDirectoryParentTask({
    isDirectory: true,
    parentTaskId: undefined,
    progressMode: "bytes",
  }), false);
});

test("folder parent progress uses progressive discovery labels not byte formatting", () => {
  const t = (key: string, params?: Record<string, string | number>) => {
    if (key === "sftp.transfers.filesDiscoveredProgress") {
      return `${params?.completed} done · ${params?.discovered} found`;
    }
    if (key === "sftp.transfers.filesProgress") {
      return `${params?.current}/${params?.total} files`;
    }
    if (key === "sftp.transfers.filesCount") {
      return `${params?.count} files`;
    }
    return key;
  };
  const display = buildGlobalTransferProgressDisplay({
    status: "transferring",
    isDirectory: true,
    progressMode: "files",
    totalBytes: 12,
    transferredBytes: 1,
    speed: 0,
    phase: "transferring",
  }, t);
  assert.equal(display.percent, (1 / 12) * 100);
  assert.equal(display.detail, "1 done · 12 found");
  assert.equal(display.indeterminate, false);
  // Must not look like "1 Bytes / 12 Bytes"
  assert.doesNotMatch(display.detail, /Bytes/i);
});

test("folder parent scanning stays indeterminate while nothing has completed", () => {
  const t = (key: string, params?: Record<string, string | number>) => {
    if (key === "sftp.transfers.filesDiscoveredProgress") {
      return `${params?.completed} done · ${params?.discovered} found`;
    }
    return key;
  };
  const display = buildGlobalTransferProgressDisplay({
    status: "transferring",
    isDirectory: true,
    progressMode: "files",
    totalBytes: 40,
    transferredBytes: 0,
    speed: 0,
    phase: "scanning",
  }, t);
  assert.equal(display.detail, "0 done · 40 found");
  assert.equal(display.indeterminate, true);
});

test("single-file progress still shows byte totals", () => {
  const t = (key: string) => key;
  const display = buildGlobalTransferProgressDisplay({
    status: "transferring",
    isDirectory: false,
    progressMode: "bytes",
    totalBytes: 1024,
    transferredBytes: 512,
    speed: 0,
  }, t);
  assert.equal(display.percent, 50);
  assert.match(display.detail, /512\s*Bytes/);
  assert.match(display.detail, /1(\.00)?\s*KB/);
});

test("active child summary prefers transferring files over queued", () => {
  const children = [
    { ...task("q1", "queued"), parentTaskId: "p", startTime: 1 },
    { ...task("t1", "transferring"), parentTaskId: "p", startTime: 2 },
    { ...task("t2", "transferring"), parentTaskId: "p", startTime: 3 },
    { ...task("done", "completed"), parentTaskId: "p", startTime: 0 },
  ];
  assert.deepEqual(
    pickActiveChildSummaries(children, 2).map((item) => item.id),
    ["t1", "t2"],
  );
});

test("collapsed active children only show while transferring or soft-draining", () => {
  assert.equal(shouldShowCollapsedActiveChildren("transferring"), true);
  assert.equal(shouldShowCollapsedActiveChildren("pausing"), true);
  assert.equal(shouldShowCollapsedActiveChildren("paused"), false);
  assert.equal(shouldShowCollapsedActiveChildren("interrupted"), false);
  assert.equal(shouldShowCollapsedActiveChildren("queued"), false);
});

test("listChildTasksForParent skips cancelled siblings", () => {
  const tasks = [
    task("p", "transferring"),
    { ...task("c1", "transferring"), parentTaskId: "p" },
    { ...task("c2", "cancelled"), parentTaskId: "p" },
    { ...task("other", "transferring"), parentTaskId: "x" },
  ];
  assert.deepEqual(listChildTasksForParent(tasks, "p").map((item) => item.id), ["c1"]);
});
