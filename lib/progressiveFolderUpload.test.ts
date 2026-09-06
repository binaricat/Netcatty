import test from "node:test";
import assert from "node:assert/strict";

import { uploadLocalFoldersProgressively } from "./progressiveFolderUpload.ts";
import { UploadController } from "./uploadController.ts";
import type { LocalTreeListEntry } from "./sftpFileUtils.ts";

test("progressive folder upload starts file transfers before the tree walk finishes", async () => {
  const events: string[] = [];
  let releaseSecondBatch: (() => void) | null = null;
  const secondBatchGate = new Promise<void>((resolve) => {
    releaseSecondBatch = resolve;
  });

  const listLocalTree = async (
    _path: string,
    options: {
      onEntries?: (entries: LocalTreeListEntry[]) => void;
    },
  ) => {
    options.onEntries?.([
      {
        localPath: "/tmp/docs",
        relativePath: "docs",
        type: "directory",
        size: 0,
        lastModified: 1,
      },
      {
        localPath: "/tmp/docs/a.txt",
        relativePath: "docs/a.txt",
        type: "file",
        size: 3,
        lastModified: 1,
      },
    ]);
    events.push("batch1");
    // First file should be uploadable while we still "discover" more.
    await secondBatchGate;
    options.onEntries?.([
      {
        localPath: "/tmp/docs/b.txt",
        relativePath: "docs/b.txt",
        type: "file",
        size: 4,
        lastModified: 2,
      },
    ]);
    events.push("batch2");
    return [];
  };

  const transferred: string[] = [];
  const controller = new UploadController();
  const uploadPromise = uploadLocalFoldersProgressively(
    [{ name: "docs", localPath: "/tmp/docs" }],
    {
      targetPath: "/remote",
      sftpId: "sftp-1",
      isLocal: false,
      joinPath: (base, name) => `${base}/${name}`,
      bridge: {
        mkdirSftp: async () => {},
        startStreamTransfer: async (payload) => {
          transferred.push(payload.sourcePath);
          events.push(`upload:${payload.sourcePath}`);
          if (payload.sourcePath.endsWith("a.txt")) {
            // Let the second discovery batch proceed only after the first upload started.
            releaseSecondBatch?.();
          }
          return { transferId: payload.transferId };
        },
      },
      listLocalTree,
      callbacks: {
        onTaskCreated: (task) => events.push(`created:${task.fileName}`),
        onTaskCompleted: (taskId) => events.push(`completed:${taskId.slice(0, 8)}`),
        onTaskProgress: (taskId, progress) => {
          events.push(`progress:${progress.transferred}/${progress.total}:${progress.phase ?? ""}`);
        },
      },
    },
    controller,
  );

  const results = await uploadPromise;
  assert.equal(results.filter((row) => row.success).length, 2);
  assert.deepEqual(transferred, ["/tmp/docs/a.txt", "/tmp/docs/b.txt"]);
  // First upload must happen before the second discovery batch finishes.
  const uploadA = events.indexOf("upload:/tmp/docs/a.txt");
  const batch2 = events.indexOf("batch2");
  assert.ok(uploadA >= 0 && batch2 >= 0, "expected both upload and batch events");
  assert.ok(uploadA < batch2, "first file must upload while scan still running");
});

test("progressive folder upload honors an explicit transfer concurrency above the default", async () => {
  const requestedConcurrency = 16;
  const entries: LocalTreeListEntry[] = Array.from(
    { length: requestedConcurrency + 2 },
    (_, index) => ({
      localPath: `/tmp/docs/file-${index}.txt`,
      relativePath: `docs/file-${index}.txt`,
      type: "file",
      size: 1,
      lastModified: index,
    }),
  );
  const started: string[] = [];
  let releaseAll!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseAll = resolve;
  });
  const config = {
    targetPath: "/remote",
    sftpId: "sftp-1",
    fileTransferConcurrency: requestedConcurrency,
    isLocal: false,
    joinPath: (base: string, name: string) => `${base}/${name}`,
    bridge: {
      mkdirSftp: async () => {},
      startStreamTransfer: async (payload: { sourcePath: string; transferId: string }) => {
        started.push(payload.sourcePath);
        await gate;
        return { transferId: payload.transferId };
      },
    },
    listLocalTree: async (
      _path: string,
      options: { onEntries?: (batch: LocalTreeListEntry[]) => void },
    ) => {
      options.onEntries?.(entries);
      return [];
    },
  };

  const uploading = uploadLocalFoldersProgressively(
    [{ name: "docs", localPath: "/tmp/docs" }],
    config,
    new UploadController(),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const initiallyStarted = started.length;
  releaseAll();
  await uploading;

  assert.equal(initiallyStarted, requestedConcurrency);
});

test("progressive folder upload enqueues nested subdirectory files", async () => {
  const transferred: string[] = [];
  const mkdirs: string[] = [];

  const listLocalTree = async (
    _path: string,
    options: {
      onEntries?: (entries: LocalTreeListEntry[]) => void;
    },
  ) => {
    options.onEntries?.([
      {
        localPath: "/tmp/docs",
        relativePath: "docs",
        type: "directory",
        size: 0,
        lastModified: 1,
      },
      {
        localPath: "/tmp/docs/a.txt",
        relativePath: "docs/a.txt",
        type: "file",
        size: 1,
        lastModified: 1,
      },
    ]);
    options.onEntries?.([
      {
        localPath: "/tmp/docs/nested",
        relativePath: "docs/nested",
        type: "directory",
        size: 0,
        lastModified: 1,
      },
      {
        localPath: "/tmp/docs/nested/deep",
        relativePath: "docs/nested/deep",
        type: "directory",
        size: 0,
        lastModified: 1,
      },
      {
        localPath: "/tmp/docs/nested/deep/b.txt",
        relativePath: "docs/nested/deep/b.txt",
        type: "file",
        size: 2,
        lastModified: 2,
      },
    ]);
    return [];
  };

  const results = await uploadLocalFoldersProgressively(
    [{ name: "docs", localPath: "/tmp/docs" }],
    {
      targetPath: "/remote",
      sftpId: "sftp-1",
      isLocal: false,
      joinPath: (base, name) => `${base}/${name}`,
      bridge: {
        mkdirSftp: async (_id, dirPath) => {
          mkdirs.push(dirPath);
        },
        startStreamTransfer: async (payload) => {
          transferred.push(payload.targetPath);
          return { transferId: payload.transferId };
        },
      },
      listLocalTree,
    },
  );

  assert.equal(results.filter((row) => row.success).length, 2);
  assert.deepEqual(transferred.sort(), [
    "/remote/docs/a.txt",
    "/remote/docs/nested/deep/b.txt",
  ].sort());
  assert.ok(mkdirs.includes("/remote/docs/nested"));
  assert.ok(mkdirs.includes("/remote/docs/nested/deep"));
});

test("progressive folder upload stops enqueueing children after cancel", async () => {
  const controller = new UploadController();
  const createdChildren: string[] = [];
  let entriesCb: ((entries: LocalTreeListEntry[]) => void) | null = null;

  const listLocalTree = async (
    _path: string,
    options: {
      onEntries?: (entries: LocalTreeListEntry[]) => void;
      abortSignal?: AbortSignal;
    },
  ) => {
    entriesCb = options.onEntries ?? null;
    options.onEntries?.([
      {
        localPath: "/tmp/big/a.txt",
        relativePath: "big/a.txt",
        type: "file",
        size: 1,
        lastModified: 1,
      },
    ]);
    // Wait until cancelled.
    await new Promise<void>((resolve) => {
      if (options.abortSignal?.aborted) {
        resolve();
        return;
      }
      options.abortSignal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return [];
  };

  const abort = new AbortController();
  const uploadPromise = uploadLocalFoldersProgressively(
    [{ name: "big", localPath: "/tmp/big" }],
    {
      targetPath: "/remote",
      sftpId: "sftp-1",
      isLocal: false,
      joinPath: (base, name) => `${base}/${name}`,
      abortSignal: abort.signal,
      bridge: {
        mkdirSftp: async () => {},
        startStreamTransfer: async (payload) => {
          // Cancel as soon as the first child begins.
          await controller.cancel();
          abort.abort();
          // Push more discovered files after cancel — workers must not create more children.
          entriesCb?.([
            {
              localPath: "/tmp/big/b.txt",
              relativePath: "big/b.txt",
              type: "file",
              size: 1,
              lastModified: 1,
            },
            {
              localPath: "/tmp/big/c.txt",
              relativePath: "big/c.txt",
              type: "file",
              size: 1,
              lastModified: 1,
            },
          ]);
          return { transferId: payload.transferId, cancelled: true };
        },
      },
      listLocalTree,
      callbacks: {
        onTaskCreated: (task) => {
          if (!task.isDirectory) createdChildren.push(task.fileName);
        },
      },
    },
    controller,
  );

  await uploadPromise;
  // At most the in-flight child should have been created.
  assert.ok(createdChildren.length <= 1, `expected no post-cancel flood, got ${createdChildren.join(",")}`);
});

test("progressive folder upload stops enqueueing children while soft-paused", async () => {
  const createdChildren: string[] = [];
  const transferred: string[] = [];
  let paused = true;
  let releasePause!: () => void;
  const pauseGate = new Promise<void>((resolve) => {
    releasePause = resolve;
  });
  let releaseMoreFiles!: () => void;
  const moreFilesGate = new Promise<void>((resolve) => {
    releaseMoreFiles = resolve;
  });

  const waitWhilePaused = async () => {
    while (paused) {
      await pauseGate;
    }
  };

  const listLocalTree = async (
    _path: string,
    options: {
      onEntries?: (entries: LocalTreeListEntry[]) => void;
    },
  ) => {
    options.onEntries?.([
      {
        localPath: "/tmp/docs/a.txt",
        relativePath: "docs/a.txt",
        type: "file",
        size: 1,
        lastModified: 1,
      },
    ]);
    // Stay in the walk until the test unblocks the second batch (after pause assert).
    await moreFilesGate;
    options.onEntries?.([
      {
        localPath: "/tmp/docs/b.txt",
        relativePath: "docs/b.txt",
        type: "file",
        size: 1,
        lastModified: 2,
      },
      {
        localPath: "/tmp/docs/c.txt",
        relativePath: "docs/c.txt",
        type: "file",
        size: 1,
        lastModified: 3,
      },
    ]);
    return [];
  };

  const uploadPromise = uploadLocalFoldersProgressively(
    [{ name: "docs", localPath: "/tmp/docs" }],
    {
      targetPath: "/remote",
      sftpId: "sftp-1",
      isLocal: false,
      joinPath: (base, name) => `${base}/${name}`,
      waitWhilePaused,
      bridge: {
        mkdirSftp: async () => {},
        startStreamTransfer: async (payload) => {
          transferred.push(payload.sourcePath);
          return { transferId: payload.transferId };
        },
      },
      listLocalTree,
      callbacks: {
        onTaskCreated: (task) => {
          if (!task.isDirectory) createdChildren.push(task.fileName);
        },
      },
    },
  );

  // Give workers a turn; soft-pause must block child creation entirely.
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(createdChildren, [], "no children while paused");
  assert.deepEqual(transferred, [], "no transfers while paused");

  paused = false;
  releasePause();
  // Let first file create/upload, then release the rest of the tree.
  await new Promise((resolve) => setTimeout(resolve, 40));
  releaseMoreFiles();

  const results = await uploadPromise;
  assert.equal(results.filter((row) => row.success).length, 3);
  assert.deepEqual(
    createdChildren.sort(),
    ["docs/a.txt", "docs/b.txt", "docs/c.txt"].sort(),
  );
  assert.equal(transferred.length, 3);
});

test("progressive multi-root pause does not HOL-block an unpaused sibling root", async () => {
  const transferred: string[] = [];
  const pausedParents = new Set<string>(["parent-a"]);
  const parentIds = new Map([
    ["folderA", "parent-a"],
    ["folderB", "parent-b"],
  ]);

  const waitWhilePaused = async (parentId: string) => {
    while (pausedParents.has(parentId)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  const listLocalTree = async (
    localPath: string,
    options: {
      onEntries?: (entries: LocalTreeListEntry[]) => void;
    },
  ) => {
    if (localPath.endsWith("folderA")) {
      options.onEntries?.([
        {
          localPath: "/tmp/folderA/a.txt",
          relativePath: "folderA/a.txt",
          type: "file",
          size: 1,
          lastModified: 1,
        },
      ]);
    } else {
      options.onEntries?.([
        {
          localPath: "/tmp/folderB/b.txt",
          relativePath: "folderB/b.txt",
          type: "file",
          size: 1,
          lastModified: 1,
        },
      ]);
    }
    return [];
  };

  const uploadPromise = uploadLocalFoldersProgressively(
    [
      { name: "folderA", localPath: "/tmp/folderA" },
      { name: "folderB", localPath: "/tmp/folderB" },
    ],
    {
      targetPath: "/remote",
      sftpId: "sftp-1",
      isLocal: false,
      joinPath: (base, name) => `${base}/${name}`,
      parentTaskIds: parentIds,
      waitWhilePaused,
      isPaused: (parentId) => pausedParents.has(parentId),
      bridge: {
        mkdirSftp: async () => {},
        startStreamTransfer: async (payload) => {
          transferred.push(payload.sourcePath);
          // Unpause A only after B has uploaded — proves HOL skip works.
          if (payload.sourcePath.includes("folderB")) {
            pausedParents.delete("parent-a");
          }
          return { transferId: payload.transferId };
        },
      },
      listLocalTree,
    },
  );

  const results = await uploadPromise;
  assert.equal(results.filter((row) => row.success).length, 2);
  assert.ok(transferred.some((p) => p.includes("folderB")), "unpaused root must transfer");
  assert.ok(transferred.some((p) => p.includes("folderA")), "paused root resumes after unlatch");
  // folderB must not wait behind folderA indefinitely — B completes first.
  assert.ok(
    transferred.indexOf(transferred.find((p) => p.includes("folderB"))!)
      < transferred.indexOf(transferred.find((p) => p.includes("folderA"))!),
    `expected B before A, got ${transferred.join(",")}`,
  );
});

test("progressive backpressure wakes every parked enqueue waiter", async () => {
  // Discovery floods the queue while workers hold transfers open so the queue
  // stays above the high-water mark. Multiple enqueueBatch waiters must all
  // be released when workers drain past the low-water mark.
  const transferred: string[] = [];
  let releaseTransfers!: () => void;
  const transferGate = new Promise<void>((resolve) => {
    releaseTransfers = resolve;
  });
  let started = 0;

  const listLocalTree = async (
    _path: string,
    options: {
      onEntries?: (entries: LocalTreeListEntry[]) => void;
    },
  ) => {
    const batches = Array.from({ length: 8 }, (_, batch) => (
      Array.from({ length: 300 }, (__, i) => ({
        localPath: `/tmp/docs/f-${batch}-${i}.txt`,
        relativePath: `docs/f-${batch}-${i}.txt`,
        type: "file" as const,
        size: 1,
        lastModified: 1,
      }))
    ));
    // Overlapping handlers so several park on waitIfQueueHigh together.
    await Promise.all(batches.map((batch) => Promise.resolve().then(() => options.onEntries?.(batch))));
    return [];
  };

  const uploadPromise = uploadLocalFoldersProgressively(
    [{ name: "docs", localPath: "/tmp/docs" }],
    {
      targetPath: "/remote",
      sftpId: "sftp-1",
      isLocal: false,
      joinPath: (base, name) => `${base}/${name}`,
      bridge: {
        mkdirSftp: async () => {},
        startStreamTransfer: async (payload) => {
          started += 1;
          transferred.push(payload.sourcePath);
          await transferGate;
          return { transferId: payload.transferId };
        },
      },
      listLocalTree,
    },
  );

  // Let discovery fill past high-water (2000) while 2 workers hold the gate.
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(started >= 1, "workers should have started");
  releaseTransfers();
  const results = await uploadPromise;
  assert.equal(results.filter((row) => row.success).length, 8 * 300);
  assert.equal(transferred.length, 8 * 300);
});

test("progressive root conflict skip does not overwrite an existing remote folder", async () => {
  const transferred: string[] = [];
  const result = await uploadLocalFoldersProgressively(
    [{ name: "docs", localPath: "/tmp/docs" }],
    {
      targetPath: "/remote",
      sftpId: "sftp-1",
      isLocal: false,
      joinPath: (base, name) => `${base}/${name}`,
      resolveConflict: async () => "skip",
      bridge: {
        mkdirSftp: async () => {},
        statSftp: async () => ({ type: "directory", size: 0, lastModified: 1 }),
        startStreamTransfer: async (payload) => {
          transferred.push(payload.sourcePath);
          return { transferId: payload.transferId };
        },
      },
      listLocalTree: async () => {
        throw new Error("scan must not run after skip");
      },
    },
  );
  assert.equal(transferred.length, 0);
  assert.equal(result[0]?.cancelled, true);
});

test("progressive root conflict check fails closed when destination access is denied", async () => {
  let conflictPrompts = 0;
  let scans = 0;
  let transfers = 0;

  await assert.rejects(
    () => uploadLocalFoldersProgressively(
      [{ name: "docs", localPath: "/tmp/docs" }],
      {
        targetPath: "/remote",
        sftpId: "sftp-1",
        isLocal: false,
        joinPath: (base, name) => `${base}/${name}`,
        resolveConflict: async () => {
          conflictPrompts += 1;
          return "skip";
        },
        bridge: {
          mkdirSftp: async () => {},
          lstatSftp: async () => {
            const error = new Error("Permission denied") as Error & { code: string };
            error.code = "EACCES";
            throw error;
          },
          startStreamTransfer: async (payload) => {
            transfers += 1;
            return { transferId: payload.transferId };
          },
        },
        listLocalTree: async () => {
          scans += 1;
          return [];
        },
      },
    ),
    /Permission denied/,
  );

  assert.equal(conflictPrompts, 0, "unknown destination state must not be treated as a conflict");
  assert.equal(scans, 0, "folder scanning must not start after a failed destination check");
  assert.equal(transfers, 0, "upload must not start when destination safety is unknown");
});

test("progressive root conflict check treats explicit ENOENT as an absent destination", async () => {
  const transferred: string[] = [];
  let followedStats = 0;
  const results = await uploadLocalFoldersProgressively(
    [{ name: "docs", localPath: "/tmp/docs" }],
    {
      targetPath: "/remote",
      sftpId: "sftp-1",
      isLocal: false,
      joinPath: (base, name) => `${base}/${name}`,
      resolveConflict: async () => {
        throw new Error("absent destination must not prompt for conflict");
      },
      bridge: {
        mkdirSftp: async () => {},
        statSftp: async () => {
          followedStats += 1;
          return { type: "directory", size: 0, lastModified: 1 };
        },
        lstatSftp: async () => {
          const error = new Error("No such file") as Error & { code: string };
          error.code = "ENOENT";
          throw error;
        },
        startStreamTransfer: async (payload) => {
          transferred.push(payload.targetPath);
          return { transferId: payload.transferId };
        },
      },
      listLocalTree: async (_path, options) => {
        options.onEntries?.([{
          localPath: "/tmp/docs/a.txt",
          relativePath: "docs/a.txt",
          type: "file",
          size: 1,
          lastModified: 1,
        }]);
        return [];
      },
    },
  );

  assert.equal(followedStats, 0, "destination checks should prefer no-follow lstat");
  assert.deepEqual(transferred, ["/remote/docs/a.txt"]);
  assert.equal(results[0]?.success, true);
});

test("progressive root replace carries the inspected type into the guarded delete", async () => {
  let currentType: "file" | "directory" = "directory";
  let scans = 0;
  let transfers = 0;

  await assert.rejects(
    () => uploadLocalFoldersProgressively(
      [{ name: "docs", localPath: "/tmp/docs" }],
      {
        targetPath: "/remote",
        sftpId: "sftp-1",
        isLocal: false,
        joinPath: (base, name) => `${base}/${name}`,
        resolveConflict: async () => {
          currentType = "file";
          return "replace";
        },
        bridge: {
          mkdirSftp: async () => {},
          lstatSftp: async () => ({ type: "directory", size: 0, lastModified: 1 }),
          deleteSftp: async (_sftpId, _path, expectedType) => {
            assert.equal(expectedType, "directory");
            if (currentType !== expectedType) {
              throw new Error(`Expected ${expectedType}, found ${currentType}`);
            }
          },
          startStreamTransfer: async (payload) => {
            transfers += 1;
            return { transferId: payload.transferId };
          },
        },
        listLocalTree: async () => {
          scans += 1;
          return [];
        },
      },
    ),
    /Expected directory, found file/,
  );

  assert.equal(scans, 0, "changed targets must abort before scanning starts");
  assert.equal(transfers, 0, "changed targets must not be overwritten");
});

test("progressive multi-root resume of non-head parent unblocks while head stays paused", async () => {
  const transferred: string[] = [];
  // Both latched initially; head is always parent-a in FIFO order.
  const pausedParents = new Set<string>(["parent-a", "parent-b"]);
  const parentIds = new Map([
    ["folderA", "parent-a"],
    ["folderB", "parent-b"],
  ]);
  const waiters = new Map<string, Array<() => void>>();

  const waitWhilePaused = async (parentId: string) => {
    while (pausedParents.has(parentId)) {
      await new Promise<void>((resolve) => {
        const list = waiters.get(parentId) ?? [];
        list.push(resolve);
        waiters.set(parentId, list);
      });
    }
  };

  const release = (parentId: string) => {
    pausedParents.delete(parentId);
    for (const resolve of waiters.get(parentId) ?? []) resolve();
    waiters.delete(parentId);
  };

  const listLocalTree = async (
    localPath: string,
    options: {
      onEntries?: (entries: LocalTreeListEntry[]) => void;
    },
  ) => {
    if (localPath.endsWith("folderA")) {
      options.onEntries?.([
        {
          localPath: "/tmp/folderA/a.txt",
          relativePath: "folderA/a.txt",
          type: "file",
          size: 1,
          lastModified: 1,
        },
      ]);
    } else {
      options.onEntries?.([
        {
          localPath: "/tmp/folderB/b.txt",
          relativePath: "folderB/b.txt",
          type: "file",
          size: 1,
          lastModified: 1,
        },
      ]);
    }
    return [];
  };

  const uploadPromise = uploadLocalFoldersProgressively(
    [
      { name: "folderA", localPath: "/tmp/folderA" },
      { name: "folderB", localPath: "/tmp/folderB" },
    ],
    {
      targetPath: "/remote",
      sftpId: "sftp-1",
      isLocal: false,
      joinPath: (base, name) => `${base}/${name}`,
      parentTaskIds: parentIds,
      waitWhilePaused,
      isPaused: (parentId) => pausedParents.has(parentId),
      bridge: {
        mkdirSftp: async () => {},
        startStreamTransfer: async (payload) => {
          transferred.push(payload.sourcePath);
          return { transferId: payload.transferId };
        },
      },
      listLocalTree,
    },
  );

  // Let both jobs queue and workers park on all-paused race.
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(transferred, []);
  // Resume only non-head parent B while A stays paused.
  release("parent-b");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(
    transferred.some((p) => p.includes("folderB")),
    `B must transfer while A paused, got ${transferred.join(",")}`,
  );
  assert.equal(
    transferred.some((p) => p.includes("folderA")),
    false,
    "A must stay blocked",
  );
  release("parent-a");
  const results = await uploadPromise;
  assert.equal(results.filter((row) => row.success).length, 2);
});
