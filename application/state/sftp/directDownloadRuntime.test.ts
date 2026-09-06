import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useSftpTransfers } from "./useSftpTransfers";
import { transferRuntime } from "./transferRuntime";
import { sftpTransferCenterStore } from "../sftpTransferCenterStore";
import { releaseTransferPauseTree } from "./transferPauseLatch";

for (const closePanel of [false, true]) {
  test(`direct folder download resumes discovery with panel ${closePanel ? "closed" : "open"}`, async () => {
    const previousWindow = globalThis.window;
    const previousStorage = globalThis.localStorage;
    const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
    globals.IS_REACT_ACT_ENVIRONMENT = true;
    let finishListing!: () => void;
    const listingGate = new Promise<void>((resolve) => { finishListing = resolve; });
    let listingStarted!: () => void;
    const started = new Promise<void>((resolve) => { listingStarted = resolve; });
    let listCalls = 0;
    let maxCount = 0;
    const unsubscribe = sftpTransferCenterStore.subscribe(() => {
      const root = sftpTransferCenterStore.getOwnerTasks("direct-runtime-owner").find((row) => !row.parentTaskId);
      maxCount = Math.max(maxCount, root?.transferredBytes ?? 0);
    });
    (globalThis as { window?: unknown }).window = { netcatty: {
      mkdirLocal: async () => undefined,
      statLocal: async () => undefined,
      startStreamTransfer: async (options: { transferId: string }) => {
        sftpTransferCenterStore.ingestBackgroundEvent({ type: "completed", transferId: options.transferId, transferred: 1, totalBytes: 1, lifecycleEpoch: 0 });
        return {};
      },
      resumeTransfer: async () => ({ success: false, reason: "Transfer is no longer active" }),
      pauseTransfer: async () => ({ success: false, reason: "Transfer is no longer active" }),
    } };
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => null, setItem: () => undefined, removeItem: () => undefined,
    };
    let ops: ReturnType<typeof useSftpTransfers> | undefined;
    let renderer: ReactTestRenderer | undefined;
    let running: Promise<unknown> | undefined;
    let rootId = "";
    let reconnects = 0;
    sftpTransferCenterStore.setDedicatedResumeHandler(async () => {
      reconnects++;
      return { success: false, error: "unexpected reconnect" };
    });
    function Probe() {
      ops = useSftpTransfers({
        ownerId: "direct-runtime-owner", getActivePane: () => null,
        getPaneByConnectionId: () => null, getTabByConnectionId: () => null,
        updateTab: () => undefined, refresh: async () => undefined,
        clearCacheForConnection: () => undefined, handleSessionError: () => undefined,
        sftpSessionsRef: { current: new Map() }, connectionCacheKeyMapRef: { current: new Map() },
        listLocalFiles: async () => [], listRemoteFiles: async () => {
          listCalls++; listingStarted(); await listingGate;
          return ["one.txt", "two.txt"].map((name) => ({ name, type: "file" as const, size: 1, sizeFormatted: "1 B", lastModified: 0, lastModifiedFormatted: "" }));
        },
      });
      return null;
    }
    try {
      await act(async () => { renderer = create(React.createElement(Probe)); });
      assert.ok(ops);
      await act(async () => {
        running = ops!.downloadToLocal({ fileName: "folder", sourcePath: "/folder", targetPath: "/download/folder-runtime", sftpId: "sftp", connectionId: "ssh", sourceHostId: "host", sourceHostLabel: "Test", isDirectory: true });
        await started;
      });
      const root = sftpTransferCenterStore.getOwnerTasks("direct-runtime-owner")[0];
      assert.ok(root); rootId = root.id;
      assert.equal(root.status, "transferring", "live root must be visible in In Progress");
      assert.equal(transferRuntime.isWalkInFlight(rootId), true, "direct download registers before discovery");
      await act(async () => { await ops!.pauseTransfer(rootId); });
      assert.equal(sftpTransferCenterStore.getTask(rootId)?.status, "paused");
      if (closePanel) await act(async () => { renderer?.unmount(); renderer = undefined; });
      await act(async () => { await ops!.resumeTransfer(rootId); });
      assert.equal(sftpTransferCenterStore.getTask(rootId)?.status, "transferring", "resume must rejoin live directory discovery even without an active child stream");
      assert.equal(transferRuntime.isWalkInFlight(rootId), true);
      assert.equal(reconnects, 0);
      finishListing();
      await act(async () => { assert.equal(await running, "completed"); });
      assert.equal(sftpTransferCenterStore.getTask(rootId)?.status, "completed");
      assert.equal(sftpTransferCenterStore.getTask(rootId)?.transferredBytes, 2);
      assert.ok(maxCount <= 2, `completed children must be counted once, observed ${maxCount}`);
      assert.equal(listCalls, 1);
      assert.equal(transferRuntime.isWalkInFlight(rootId), false);
    } finally {
      releaseTransferPauseTree(rootId, []);
      finishListing();
      await act(async () => { await running; renderer?.unmount(); });
      if (rootId) sftpTransferCenterStore.dismiss(rootId);
      unsubscribe();
      sftpTransferCenterStore.setDedicatedResumeHandler(null);
      (globalThis as { window?: unknown }).window = previousWindow;
      (globalThis as { localStorage?: unknown }).localStorage = previousStorage;
      globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
    }
  });
}
