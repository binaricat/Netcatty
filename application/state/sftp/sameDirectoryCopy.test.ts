import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useSftpTransfers } from "./useSftpTransfers";
import { createEmptyPane } from "./types";
import { sftpTransferCenterStore } from "../sftpTransferCenterStore";

for (const action of ["merge", "replace", "duplicate"] as const) {
  test(`same-directory ${action} preserves source links through the real transfer hook`, async () => {
    const dir = await fs.mkdtemp(path.join(process.cwd(), ".same-directory-copy-"));
    const ownerId = `self-copy-${action}-${crypto.randomUUID()}`;
    const previousWindow = globalThis.window;
    const previousStorage = globalThis.localStorage;
    const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
    globals.IS_REACT_ACT_ENVIRONMENT = true;
    let writes = 0;
    let listings = 0;
    let renderer: ReactTestRenderer | undefined;
    let ops!: ReturnType<typeof useSftpTransfers>;
    const names = ["one", "two"];
    for (const name of names) {
      await fs.mkdir(path.join(dir, name));
      await fs.writeFile(path.join(dir, name, "file"), "original data");
      await fs.symlink("file", path.join(dir, name, "link"));
    }
    const pane = createEmptyPane("self-copy-pane");
    pane.connection = { id: ownerId, isLocal: true, currentPath: dir, status: "connected" } as NonNullable<typeof pane.connection>;
    const statPath = async (value: string) => {
      const stat = await fs.lstat(value);
      return { type: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file", size: stat.size, lastModified: stat.mtimeMs };
    };
    (globalThis as { window?: unknown }).window = { requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout, netcatty: {
      realpathLocal: fs.realpath, statLocal: statPath, lstatLocal: statPath,
      mkdirLocal: async (value: string) => { writes++; await fs.mkdir(value, { recursive: true }); },
      deleteLocalFile: async (value: string) => { writes++; await fs.rm(value, { recursive: true, force: true }); },
      renameLocalFile: async (source: string, target: string) => { writes++; await fs.rename(source, target); },
      startStreamTransfer: async (options: { sourcePath: string; targetPath: string; transferId: string }) => {
        writes++;
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
        listLocalFiles: async (value: string) => {
          listings++;
          return Promise.all((await fs.readdir(value)).map(async name => {
            const stat = await fs.lstat(path.join(value, name));
            return { name, type: stat.isSymbolicLink() ? "symlink" as const : "file" as const, size: stat.size, sizeFormatted: "", lastModified: stat.mtimeMs, lastModifiedFormatted: "" };
          }));
        },
      });
      return null;
    }
    try {
      await act(async () => { renderer = create(React.createElement(Probe)); });
      await act(async () => { await ops.startTransfer(names.map(name => ({ name, isDirectory: true })), "left", "left"); });
      assert.equal(ops.conflicts.length, 2, JSON.stringify(sftpTransferCenterStore.getOwnerTasks(ownerId)));
      const firstId = ops.conflicts[0].transferId;
      // Apply to all exercises shared batch resolution rather than just one row.
      await act(async () => { await ops.resolveConflict(firstId, action, true); });
      await act(async () => {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const rows = sftpTransferCenterStore.getOwnerTasks(ownerId).filter(row => !row.parentTaskId);
          if (rows.length === 2 && rows.every(row => ["completed", "failed"].includes(row.status))) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      });
      for (const name of names) {
        assert.equal(await fs.readlink(path.join(dir, name, "link")), "file");
        assert.equal(await fs.readFile(path.join(dir, name, "file"), "utf8"), "original data");
      }
      const roots = sftpTransferCenterStore.getOwnerTasks(ownerId).filter(row => !row.parentTaskId);
      assert.equal(roots.length, 2);
      assert.ok(roots.every(row => row.status === "completed"), JSON.stringify(roots.map(row => ({ status: row.status, error: row.error }))));
      if (action === "duplicate") {
        assert.ok(writes > 0);
        assert.ok(listings > 0);
        for (const name of names) assert.equal(await fs.readFile(path.join(dir, `${name} (copy)`, "file"), "utf8"), "original data");
      } else {
        assert.equal(writes, 0, "self merge/replace must never write or unlink anything");
        assert.equal(listings, 0, "self merge/replace must not walk the source tree");
      }
    } finally {
      await act(async () => { renderer?.unmount(); });
      for (const row of sftpTransferCenterStore.getOwnerTasks(ownerId)) sftpTransferCenterStore.dismiss(row.id);
      (globalThis as { window?: unknown }).window = previousWindow;
      (globalThis as { localStorage?: unknown }).localStorage = previousStorage;
      globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}
