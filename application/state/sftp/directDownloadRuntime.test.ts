import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useSftpTransfers } from "./useSftpTransfers";
import { transferRuntime } from "./transferRuntime";
import { sftpTransferCenterStore } from "../sftpTransferCenterStore";
import { releaseTransferPauseTree } from "./transferPauseLatch";
import type { Host } from "../../../domain/models";

test("direct download opens both pooled reads through the tab's connected host", async () => {
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const globals = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = globals.IS_REACT_ACT_ENVIRONMENT;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  const connectedHost = { id: "host", hostname: "same.example", proxyConfig: { type: "socks5", host: "proxy-b", port: 1080 } } as Host;
  const seenHosts: Array<Host | undefined> = [];
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => null, setItem: () => undefined, removeItem: () => undefined,
  };
  (globalThis as { window?: unknown }).window = { netcatty: {
    startStreamTransfer: async (options: { transferId: string }) => {
      sftpTransferCenterStore.ingestBackgroundEvent({ type: "completed", transferId: options.transferId, transferred: 1, totalBytes: 1, lifecycleEpoch: 0 });
      return {};
    },
  } };
  let ops: ReturnType<typeof useSftpTransfers> | undefined;
  let renderer: ReactTestRenderer | undefined;
  function Probe() {
    ops = useSftpTransfers({
      ownerId: "direct-connected-host-owner", getActivePane: () => null,
      getPaneByConnectionId: () => null,
      getTabByConnectionId: () => ({ side: "left", tabId: "tab-1", pane: {} as never }),
      resolveConnectedHost: () => connectedHost,
      getTransferPoolKeyForHost: async () => "route-new",
      acquireTransferSession: async (_hostId, _transferId, host) => {
        seenHosts.push(host);
        return { poolKey: "connected-host", sftpId: `pooled-${seenHosts.length}`, release: () => undefined, discard: () => undefined };
      },
      updateTab: () => undefined, refresh: async () => undefined,
      clearCacheForConnection: () => undefined, handleSessionError: () => undefined,
      sftpSessionsRef: { current: new Map() }, connectionCacheKeyMapRef: { current: new Map() },
      listLocalFiles: async () => [], listRemoteFiles: async () => [],
    });
    return null;
  }
  try {
    await act(async () => { renderer = create(React.createElement(Probe)); });
    await act(async () => {
      assert.equal(await ops!.downloadToLocal({
        fileName: "file.bin", sourcePath: "/remote/file.bin", targetPath: "/local/file.bin",
        sftpId: "browse", connectionId: "ssh", sourceHostId: "host", sourceHostLabel: "Host",
        isDirectory: false, totalBytes: 1,
      }), "completed");
    });
    assert.equal(seenHosts.length, 2);
    assert.ok(seenHosts.every((host) => host === connectedHost));
    await act(async () => {
      assert.equal(await ops!.downloadToLocal({
        fileName: "other.bin", sourcePath: "/remote/other.bin", targetPath: "/local/other.bin",
        expectedLocalTarget: {
          parentRealPath: "/local", parentIdentity: "1:2", parentBirthtimeNs: "100",
          targetIdentity: "1:3", targetBirthtimeNs: "200", targetCtimeNs: "201", targetMtimeNs: "202",
          targetSha256: "a".repeat(64),
        },
        expectedSourceEndpointKey: "route-old",
        sftpId: "browse", connectionId: "ssh", sourceHostId: "host", sourceHostLabel: "Host",
        isDirectory: false, totalBytes: 1,
      }), "failed");
    });
    assert.equal(seenHosts.length, 2, "route mismatch must fail before opening another transfer connection");
    await act(async () => {
      assert.equal(await ops!.downloadToLocal({
        fileName: "first.bin", sourcePath: "/remote/first.bin", targetPath: "/local/first.bin",
        expectedSourceEndpointKey: "route-old",
        sftpId: "browse", connectionId: "ssh", sourceHostId: "host", sourceHostLabel: "Host",
        isDirectory: false, totalBytes: 1,
      }), "failed");
    });
    assert.equal(seenHosts.length, 2, "a first Save As route mismatch must not start a transfer");
  } finally {
    await act(async () => { renderer?.unmount(); });
    for (const task of sftpTransferCenterStore.getOwnerTasks("direct-connected-host-owner")) {
      sftpTransferCenterStore.dismiss(task.id);
    }
    (globalThis as { window?: unknown }).window = previousWindow;
    (globalThis as { localStorage?: unknown }).localStorage = previousStorage;
    globals.IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});

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
