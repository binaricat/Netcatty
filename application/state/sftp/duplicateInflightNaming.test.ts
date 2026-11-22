/** @test issue #4132 — a duplicate must not reuse a destination an earlier copy still holds */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useSftpTransfers } from "./useSftpTransfers";
import { createEmptyPane } from "./types";
import { sftpTransferCenterStore } from "../sftpTransferCenterStore";

test("duplicate names around a destination an in-flight copy has not created yet", async () => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), ".duplicate-inflight-"));
  const ownerId = `duplicate-inflight-${crypto.randomUUID()}`;
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  let renderer: ReactTestRenderer | undefined;
  let ops!: ReturnType<typeof useSftpTransfers>;
  let releaseFirst: (() => void) | undefined;
  const firstCopyGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let streamStarts = 0;
  await fs.writeFile(path.join(dir, "report.txt"), "original data");
  const pane = createEmptyPane("duplicate-inflight-pane");
  pane.connection = { id: ownerId, isLocal: true, currentPath: dir, status: "connected" } as NonNullable<typeof pane.connection>;
  const statPath = async (value: string) => {
    try {
      const stat = await fs.lstat(value);
      return { type: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file", size: stat.size, lastModified: stat.mtimeMs };
    } catch {
      return null;
    }
  };
  (globalThis as { window?: unknown }).window = { requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout, netcatty: {
    realpathLocal: fs.realpath, statLocal: statPath, lstatLocal: statPath,
    mkdirLocal: async (value: string) => { await fs.mkdir(value, { recursive: true }); },
    deleteLocalFile: async (value: string) => { await fs.rm(value, { recursive: true, force: true }); },
    renameLocalFile: async (source: string, target: string) => { await fs.rename(source, target); },
    startStreamTransfer: async (options: { sourcePath: string; targetPath: string; transferId: string }) => {
      streamStarts += 1;
      // Hold the first copy before it writes its destination: the second
      // duplicate then sees no "(copy)" on disk even though one is reserved.
      if (streamStarts === 1) await firstCopyGate;
      await fs.copyFile(options.sourcePath, options.targetPath);
      sftpTransferCenterStore.ingestBackgroundEvent({ type: "completed", transferId: options.transferId, transferred: 13, totalBytes: 13, lifecycleEpoch: 0 });
      return {};
    },
  } };
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  function Probe() {
    ops = useSftpTransfers({
      ownerId, getActivePane: () => pane, getPaneByConnectionId: () => pane, getTabByConnectionId: () => ({ side: "left", tabId: pane.id, pane }),
      updateTab: () => undefined, refresh: async () => undefined,
      clearCacheForConnection: () => undefined, handleSessionError: () => undefined,
      sftpSessionsRef: { current: new Map() }, connectionCacheKeyMapRef: { current: new Map() },
      listRemoteFiles: async () => [],
      listLocalFiles: async (value: string) => Promise.all((await fs.readdir(value)).map(async name => {
        const stat = await fs.lstat(path.join(value, name));
        return { name, type: stat.isSymbolicLink() ? "symlink" as const : stat.isDirectory() ? "directory" as const : "file" as const, size: stat.size, sizeFormatted: "", lastModified: stat.mtimeMs, lastModifiedFormatted: "" };
      })),
    });
    return null;
  }
  const sources = [{ name: "report.txt", isDirectory: false }];
  const options = { sourcePath: dir, targetPath: dir, duplicate: true };
  try {
    await act(async () => { renderer = create(React.createElement(Probe)); });
    // First duplicate starts copying and blocks before writing "(copy)".
    let firstRun: ReturnType<typeof ops.startTransfer> | undefined;
    await act(async () => {
      firstRun = ops.startTransfer(sources, "left", "left", options);
      const deadline = Date.now() + 3000;
      while (streamStarts === 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    });
    assert.equal(streamStarts, 1, "the first copy should be in flight");

    // Second duplicate runs while "(copy)" is still absent from the disk.
    await act(async () => { await ops.startTransfer(sources, "left", "left", options); });
    assert.equal(ops.conflicts.length, 0, "duplicate must not prompt for a reserved name");
    releaseFirst?.();
    await act(async () => { await firstRun; });

    await act(async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const rows = sftpTransferCenterStore.getOwnerTasks(ownerId).filter(row => !row.parentTaskId);
        if (rows.length === 2 && rows.every(row => ["completed", "failed"].includes(row.status))) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    });
    const roots = sftpTransferCenterStore.getOwnerTasks(ownerId).filter(row => !row.parentTaskId);
    assert.deepEqual(roots.map(row => row.fileName).sort(), ["report (copy 2).txt", "report (copy).txt"]);
    assert.ok(roots.every(row => row.status === "completed"), JSON.stringify(roots.map(row => ({ status: row.status, error: row.error }))));
    assert.equal(await fs.readFile(path.join(dir, "report (copy).txt"), "utf8"), "original data");
    assert.equal(await fs.readFile(path.join(dir, "report (copy 2).txt"), "utf8"), "original data");
  } finally {
    releaseFirst?.();
    await act(async () => { renderer?.unmount(); });
    for (const row of sftpTransferCenterStore.getOwnerTasks(ownerId)) sftpTransferCenterStore.dismiss(row.id);
    (globalThis as { window?: unknown }).window = previousWindow;
    (globalThis as { localStorage?: unknown }).localStorage = previousStorage;
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
