/** @test issue #4132 — a one-click duplicate copies next to the source without a conflict prompt */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useSftpTransfers } from "./useSftpTransfers";
import { createEmptyPane } from "./types";
import { sftpTransferCenterStore } from "../sftpTransferCenterStore";

test("duplicate transfers resolve same-name conflicts to (copy) without prompting", async () => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), ".duplicate-entries-"));
  const ownerId = `duplicate-entries-${crypto.randomUUID()}`;
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  let renderer: ReactTestRenderer | undefined;
  let ops!: ReturnType<typeof useSftpTransfers>;
  // A duplicate has to cover both files and folders: the conflict type key
  // differs between the two and the seeded defaults must match both.
  const fileNames = ["report.txt"];
  const folderNames = ["photos"];
  for (const name of fileNames) {
    await fs.writeFile(path.join(dir, name), "original data");
  }
  for (const name of folderNames) {
    await fs.mkdir(path.join(dir, name));
    await fs.writeFile(path.join(dir, name, "nested.txt"), "nested data");
  }
  const pane = createEmptyPane("duplicate-pane");
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
  const waitForSettledRoots = async (expected: number) => {
    await act(async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const roots = sftpTransferCenterStore.getOwnerTasks(ownerId).filter(row => !row.parentTaskId);
        if (roots.length === expected && roots.every(row => ["completed", "failed"].includes(row.status))) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    });
  };
  try {
    await act(async () => { renderer = create(React.createElement(Probe)); });
    const sources = [...fileNames, ...folderNames].map(name => ({ name, isDirectory: folderNames.includes(name) }));
    await act(async () => {
      await ops.startTransfer(sources, "left", "left", { sourcePath: dir, targetPath: dir, duplicate: true });
    });
    // The duplicate option must resolve conflicts by itself; a prompt here
    // would defeat the one-click action the issue asks for.
    assert.deepEqual(ops.conflicts, []);
    await waitForSettledRoots(sources.length);
    const roots = sftpTransferCenterStore.getOwnerTasks(ownerId).filter(row => !row.parentTaskId);
    assert.equal(roots.length, sources.length, JSON.stringify(roots.map(row => row.fileName)));
    assert.ok(roots.every(row => row.status === "completed"), JSON.stringify(roots.map(row => ({ status: row.status, error: row.error }))));
    for (const name of fileNames) {
      assert.equal(await fs.readFile(path.join(dir, name), "utf8"), "original data");
    }
    assert.equal(await fs.readFile(path.join(dir, "report (copy).txt"), "utf8"), "original data");
    assert.equal(await fs.readFile(path.join(dir, "photos (copy)", "nested.txt"), "utf8"), "nested data");

    // A second duplicate must pick the next free name instead of colliding
    // with the copy created by the first run.
    await act(async () => {
      await ops.startTransfer(sources, "left", "left", { sourcePath: dir, targetPath: dir, duplicate: true });
    });
    assert.deepEqual(ops.conflicts, []);
    await waitForSettledRoots(sources.length * 2);
    assert.equal(await fs.readFile(path.join(dir, "report (copy 2).txt"), "utf8"), "original data");
    assert.equal(await fs.readFile(path.join(dir, "photos (copy 2)", "nested.txt"), "utf8"), "nested data");

    // The tree's ".." navigation row must never be duplicated: it would copy
    // an ancestor into itself.
    const tasksBefore = sftpTransferCenterStore.getOwnerTasks(ownerId).length;
    let navigationResults: unknown;
    await act(async () => {
      navigationResults = await ops.startTransfer(
        [{ name: "..", isDirectory: true }],
        "left",
        "left",
        { sourcePath: dir, targetPath: dir, duplicate: true },
      );
    });
    assert.deepEqual(navigationResults, []);
    assert.equal(sftpTransferCenterStore.getOwnerTasks(ownerId).length, tasksBefore);
    assert.deepEqual(ops.conflicts, []);
  } finally {
    await act(async () => { renderer?.unmount(); });
    for (const row of sftpTransferCenterStore.getOwnerTasks(ownerId)) sftpTransferCenterStore.dismiss(row.id);
    (globalThis as { window?: unknown }).window = previousWindow;
    (globalThis as { localStorage?: unknown }).localStorage = previousStorage;
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
