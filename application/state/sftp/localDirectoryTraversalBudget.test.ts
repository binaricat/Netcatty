import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { SftpFileEntry, TransferTask } from "../../../domain/models";
import { createSftpDirectoryTraversalBudget } from "../../../domain/sftpDirectoryCheckpoint";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { useSftpDirectoryTransferOps } from "./transferDirectoryOps";

const modes = [
  { name: "ordinary local upload", sourceLocal: true, targetLocal: false, sameConnection: false, bounded: false },
  { name: "cross-pane local copy", sourceLocal: true, targetLocal: true, sameConnection: false, bounded: false },
  { name: "same-pane local copy", sourceLocal: true, targetLocal: true, sameConnection: true, bounded: true },
  { name: "remote download", sourceLocal: false, targetLocal: true, sameConnection: false, bounded: true },
] as const;

for (const mode of modes) {
  for (const limit of ["entries", "directories"] as const) {
    test(`${mode.name} ${mode.bounded ? "enforces" : "does not inherit"} the ${limit} budget`, async () => {
      const previousGet = netcattyBridge.get;
      const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
      const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
      globals.IS_REACT_ACT_ENVIRONMENT = true;
      let renderer: ReactTestRenderer | undefined;
      let ops!: ReturnType<typeof useSftpDirectoryTransferOps>;
      const listed: string[] = [];
      const root: TransferTask = {
        id: crypto.randomUUID(), fileName: "source", sourcePath: "/source", targetPath: "/target",
        sourceConnectionId: "source", targetConnectionId: mode.sameConnection ? "source" : "target",
        direction: mode.sourceLocal ? "upload" : "download", status: "transferring",
        totalBytes: 0, transferredBytes: 0, speed: 0, startTime: 0, isDirectory: true,
      };
      const transfersRef = { current: [root] };
      const list = async (value: string): Promise<SftpFileEntry[]> => {
        listed.push(value);
        return value === "/source" ? ["one", "two"].map(name => ({
          name, type: "directory", size: 0, sizeFormatted: "0 B", lastModified: 0, lastModifiedFormatted: "",
        })) : [];
      };
      netcattyBridge.get = () => ({
        mkdirLocal: async () => undefined,
        mkdirSftp: async () => undefined,
        realpathSftp: async (_id: string, value: string) => value,
      } as unknown as NetcattyBridge);
      function Probe() {
        ops = useSftpDirectoryTransferOps({
          ownerId: root.id, cancelledTasksRef: { current: new Set() }, pausedTasksRef: { current: new Set() },
          waitUntilTransferResumed: async () => undefined, activeChildIdsRef: { current: new Map() },
          transfersRef,
          setTransfers: update => { transfersRef.current = typeof update === "function" ? update(transfersRef.current) : update; },
          listLocalFiles: list, listRemoteFiles: (_id, value) => list(value),
        });
        return null;
      }
      try {
        await act(async () => { renderer = create(React.createElement(Probe)); });
        // Three empty directories exercise real recursion without large fixtures or file streams.
        const budget = createSftpDirectoryTraversalBudget({
          maxEntries: limit === "entries" ? 1 : 10,
          maxDirectories: limit === "directories" ? 1 : 10,
        });
        const run = ops.transferDirectory(root, mode.sourceLocal ? null : "remote-source",
          mode.targetLocal ? null : "remote-target", mode.sourceLocal, mode.targetLocal,
          "auto", "auto", root.id, false, 0, false, undefined, budget);
        if (mode.bounded) {
          await assert.rejects(run, limit === "entries" ? /entry limit exceeded/ : /directory limit exceeded/);
          assert.deepEqual(listed, ["/source"]);
        } else {
          assert.equal(await run, 0);
          assert.deepEqual(listed, ["/source", "/source/one", "/source/two"]);
          assert.equal(budget.visitedDirectories, 0);
          assert.equal(budget.visitedEntries, 0);
        }
        assert.equal(budget.activeCanonicalDirectories.size, 0);
      } finally {
        await act(async () => { renderer?.unmount(); });
        netcattyBridge.get = previousGet;
        globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
      }
    });
  }
}
