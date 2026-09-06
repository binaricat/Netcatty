import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { SftpFileEntry, TransferTask } from "../../../domain/models";
import { useSftpDirectoryTransferOps } from "./transferDirectoryOps";

const directoryEntry = (name: string): SftpFileEntry => ({
  name,
  type: "directory",
  size: 0,
  sizeFormatted: "0 B",
  lastModified: 0,
  lastModifiedFormatted: "",
});

const fileEntry = (name: string): SftpFileEntry => ({
  name,
  type: "file",
  size: 1,
  sizeFormatted: "1 B",
  lastModified: 0,
  lastModifiedFormatted: "",
});

const rootTask = (): TransferTask => ({
  id: "root",
  fileName: "source",
  sourcePath: "/source",
  targetPath: "/target",
  sourceConnectionId: "source-sftp",
  targetConnectionId: "local",
  direction: "download",
  status: "transferring",
  totalBytes: 0,
  transferredBytes: 0,
  speed: 0,
  startTime: 0,
  isDirectory: true,
  progressMode: "files",
});

for (const newestAction of ["pause", "cancel", "resume"] as const) {
  test(`directory pause watcher respects a newer ${newestAction}`, async () => {
    const { bumpTransferControlEpoch, resetTransferControlEpochsForTests } = await import("./transferControlEpoch");
    const { latchTransferPauseTree, resetTransferPauseLatchesForTests } = await import("./transferPauseLatch");
    const previousWindow = (globalThis as { window?: unknown }).window;
    const previousLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
    const previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const root = { ...rootTask(), id: `watch-root-${newestAction}` };
    let tasks: TransferTask[] = [root];
    const transfersRef = { current: tasks };
    const cancelledTasksRef = { current: new Set<string>() };
    let finishPause!: (value: { success: boolean }) => void;
    let finishTransfer!: (value: { error?: string }) => void;
    let pauseStarted!: () => void;
    const pauseGate = new Promise<void>((resolve) => { pauseStarted = resolve; });
    const transferGate = new Promise<{ error?: string }>((resolve) => { finishTransfer = resolve; });
    let resumeCalls = 0;
    let childId = "";
    (globalThis as { window?: unknown }).window = { netcatty: {
      mkdirLocal: async () => undefined,
      statLocal: async () => ({ type: "directory" }),
      startStreamTransfer: (options: { transferId: string }) => {
        childId = options.transferId;
        // Reproduce a stream arming during the parent's initial pause round.
        bumpTransferControlEpoch(root.id);
        latchTransferPauseTree(root.id, [childId]);
        return transferGate;
      },
      pauseTransfer: () => {
        pauseStarted();
        return new Promise<{ success: boolean }>((resolve) => { finishPause = resolve; });
      },
      resumeTransfer: async () => { resumeCalls++; return { success: true }; },
    } };
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => null, setItem: () => undefined, removeItem: () => undefined,
    };
    let operations: ReturnType<typeof useSftpDirectoryTransferOps> | undefined;
    let renderer: ReactTestRenderer | null = null;
    let running: Promise<unknown> | undefined;
    const Probe = () => {
      operations = useSftpDirectoryTransferOps({
        ownerId: `watch-owner-${newestAction}`, cancelledTasksRef,
        pausedTasksRef: { current: new Set() },
        waitUntilTransferResumed: async () => undefined,
        activeChildIdsRef: { current: new Map() }, transfersRef,
        setTransfers: (update) => {
          tasks = typeof update === "function" ? update(tasks) : update;
          transfersRef.current = tasks;
        },
        listLocalFiles: async () => [], listRemoteFiles: async () => [fileEntry("file.txt")],
      });
      return null;
    };
    try {
      await act(async () => { renderer = create(React.createElement(Probe)); });
      assert.ok(operations);
      running = operations.transferDirectory(root, "source-sftp", null, false, true, "auto", "auto", root.id);
      await pauseGate;
      bumpTransferControlEpoch(root.id);
      if (newestAction === "pause") latchTransferPauseTree(root.id, [childId]);
      else {
        if (newestAction === "cancel") cancelledTasksRef.current.add(root.id);
        resetTransferPauseLatchesForTests();
      }
      finishPause({ success: true });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(resumeCalls, newestAction === "resume" ? 1 : 0, "compensation must follow the latest decision");
    } finally {
      resetTransferPauseLatchesForTests();
      finishPause?.({ success: true });
      finishTransfer({});
      await running?.catch(() => {});
      await act(async () => { renderer?.unmount(); });
      resetTransferControlEpochsForTests();
      (globalThis as { window?: unknown }).window = previousWindow;
      (globalThis as { localStorage?: unknown }).localStorage = previousLocalStorage;
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  });
}

test("directory transfer discovers each directory once with bounded listing concurrency", async () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  const previousLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
  const previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const directoryCount = 64;
  const root = rootTask();
  let tasks: TransferTask[] = [
    root,
    ...Array.from({ length: directoryCount }, (_, index): TransferTask => ({
      ...root,
      id: `completed-${index}`,
      fileName: `file-${index}.txt`,
      sourcePath: `/source/dir-${index}/file-${index}.txt`,
      targetPath: `/target/dir-${index}/file-${index}.txt`,
      status: "completed",
      totalBytes: 1,
      transferredBytes: 1,
      isDirectory: false,
      progressMode: "bytes",
      parentTaskId: root.id,
    })),
  ];
  const transfersRef = { current: tasks };
  const setTransfers = (update: React.SetStateAction<TransferTask[]>) => {
    tasks = typeof update === "function" ? update(tasks) : update;
    transfersRef.current = tasks;
  };

  let activeListings = 0;
  let maxActiveListings = 0;
  const listCalls = new Map<string, number>();
  const listRemoteFiles = async (_sftpId: string, path: string): Promise<SftpFileEntry[]> => {
    listCalls.set(path, (listCalls.get(path) ?? 0) + 1);
    activeListings += 1;
    maxActiveListings = Math.max(maxActiveListings, activeListings);
    await new Promise((resolve) => setTimeout(resolve, 1));
    activeListings -= 1;
    if (path === "/source") {
      return [
        ...Array.from({ length: directoryCount }, (_, index) => directoryEntry(`dir-${index}`)),
        { ...directoryEntry("loop"), type: "symlink", linkTarget: "directory" },
      ];
    }
    const index = Number(path.slice(path.lastIndexOf("-") + 1));
    return [fileEntry(`file-${index}.txt`)];
  };

  (globalThis as { window?: unknown }).window = {
    netcatty: {
      mkdirLocal: async () => undefined,
      statLocal: async () => ({ type: "directory" }),
      realpathSftp: async (_sftpId: string, remotePath: string) => (
        remotePath === "/source/loop" ? "/source" : remotePath
      ),
    },
  };
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };

  let operations: ReturnType<typeof useSftpDirectoryTransferOps> | undefined;
  let renderer: ReactTestRenderer | null = null;
  const Probe = () => {
    operations = useSftpDirectoryTransferOps({
      ownerId: "owner",
      cancelledTasksRef: { current: new Set() },
      pausedTasksRef: { current: new Set() },
      waitUntilTransferResumed: async () => undefined,
      activeChildIdsRef: { current: new Map() },
      transfersRef,
      setTransfers,
      listLocalFiles: async () => [],
      listRemoteFiles,
    });
    return null;
  };

  try {
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });
    assert.ok(operations);
    assert.equal("countDirectoryFiles" in operations, false, "directory startup must not expose a separate full-tree count pass");

    await operations.transferDirectory(
      root,
      "source-sftp",
      null,
      false,
      true,
      "auto",
      "auto",
      root.id,
      undefined,
      0,
      true,
    );

    assert.equal(listCalls.size, directoryCount + 1);
    assert.ok(Array.from(listCalls.values()).every((count) => count === 1));
    assert.equal(listCalls.has("/source/loop"), false, "canonical symlink cycles must not be listed");
    // Interleaved walk processes sibling subdirectories sequentially so resume
    // manifests stay deterministic (no full-tree pre-scan fan-out).
    assert.equal(maxActiveListings, 1, `expected sequential listings, got ${maxActiveListings}`);
    assert.equal(tasks.find((task) => task.id === root.id)?.totalBytes, directoryCount);
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    (globalThis as { window?: unknown }).window = previousWindow;
    (globalThis as { localStorage?: unknown }).localStorage = previousLocalStorage;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});

test("live directory download rejects a Windows backslash traversal entry", async () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  const previousLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;
  const previousActEnvironment = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const root = {
    ...rootTask(),
    targetPath: "C:\\Users\\alice\\Downloads\\folder",
  };
  let tasks: TransferTask[] = [root];
  const transfersRef = { current: tasks };
  const setTransfers = (update: React.SetStateAction<TransferTask[]>) => {
    tasks = typeof update === "function" ? update(tasks) : update;
    transfersRef.current = tasks;
  };
  (globalThis as { window?: unknown }).window = {
    netcatty: {
      mkdirLocal: async () => undefined,
      statLocal: async () => ({ type: "directory" }),
    },
  };
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };

  let operations: ReturnType<typeof useSftpDirectoryTransferOps> | undefined;
  let renderer: ReactTestRenderer | null = null;
  const Probe = () => {
    operations = useSftpDirectoryTransferOps({
      ownerId: "owner",
      cancelledTasksRef: { current: new Set() },
      pausedTasksRef: { current: new Set() },
      waitUntilTransferResumed: async () => undefined,
      activeChildIdsRef: { current: new Map() },
      transfersRef,
      setTransfers,
      listLocalFiles: async () => [],
      listRemoteFiles: async () => [fileEntry("..\\outside.txt")],
    });
    return null;
  };

  try {
    await act(async () => {
      renderer = create(React.createElement(Probe));
    });
    assert.ok(operations);
    await assert.rejects(
      operations.transferDirectory(
        root,
        "source-sftp",
        null,
        false,
        true,
        "auto",
        "auto",
        root.id,
      ),
      /unsafe transfer path/i,
    );
    assert.equal(tasks.some((task) => task.parentTaskId === root.id), false);
  } finally {
    await act(async () => {
      renderer?.unmount();
    });
    (globalThis as { window?: unknown }).window = previousWindow;
    (globalThis as { localStorage?: unknown }).localStorage = previousLocalStorage;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  }
});
