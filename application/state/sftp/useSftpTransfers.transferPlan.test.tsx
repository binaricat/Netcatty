/** @test issue #3559 — dual-pane transfers must re-stat remote sources before planning */
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { PREFLIGHT_STAT_CONCURRENCY, PREFLIGHT_STAT_MAX_FILES, useSftpTransfers } from "./useSftpTransfers";
import { sftpTransferCenterStore } from "../sftpTransferCenterStore";
import type { SftpPane } from "./types";

type StartOptions = {
  transferId: string;
  sourcePath: string;
  sourceType: string;
  targetType: string;
  totalBytes?: number;
  sourceSftpId?: string;
};

/** Remote pane whose listing was captured before the file grew to 3626 bytes. */
function makePane(side: "left" | "right"): SftpPane {
  const isLocal = side === "right";
  return {
    id: side,
    connection: {
      id: isLocal ? "local-conn" : "remote-conn",
      hostId: isLocal ? undefined : "host-1",
      hostLabel: isLocal ? "Local" : "SSH host",
      isLocal,
      status: "connected",
      currentPath: isLocal ? "/Users/reporter/Downloads" : "/opt",
    },
    files: isLocal
      ? []
      : [
          {
            name: "aops_dns_view_demo.sh",
            type: "file" as const,
            size: 3622,
            sizeFormatted: "3.5 KB",
            lastModified: 1758000000000,
            lastModifiedFormatted: "",
          },
        ],
    loading: false,
    reconnecting: false,
    error: null,
    connectionLogs: [],
    selectedFiles: new Set<string>(),
    filter: "",
    filenameEncoding: "auto",
    showHiddenFiles: true,
    transferMutationToken: 0,
  };
}

function installGlobals(netty: Record<string, unknown>) {
  const previousWindow = (globalThis as { window?: unknown }).window;
  const previousActFlag = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const previousStorage = (globalThis as { localStorage?: unknown }).localStorage;
  const previousRaf = (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
  const previousCancelRaf = (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
  // Progress patches are rAF-coalesced; provide a microtask-ish shim.
  const raf = (cb: (time: number) => void) => setTimeout(() => cb(Date.now()), 0);
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = raf;
  (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = (id: unknown) => clearTimeout(id as number);
  (globalThis as { window?: unknown }).window = {
    netcatty: netty,
    requestAnimationFrame: raf,
    cancelAnimationFrame: (id: unknown) => clearTimeout(id as number),
  };
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  return () => {
    (globalThis as { window?: unknown }).window = previousWindow;
    (globalThis as { localStorage?: unknown }).localStorage = previousStorage;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActFlag;
    (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = previousRaf;
    (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame = previousCancelRaf;
  };
}

for (const liveStatAvailable of [true, false]) {
  test(
    liveStatAvailable
      ? "dual-pane download plan uses the live source size, not the stale listing (#3559)"
      : "dual-pane download plan falls back to live size measurement when stat is unavailable (#3559)",
    async () => {
      const statCalls: Array<{ sftpId: string; path: string }> = [];
      const startedOptions: StartOptions[] = [];
      let resolveTransfer!: (options: StartOptions) => void;
      const transferStarted = new Promise<StartOptions>((resolve) => { resolveTransfer = resolve; });

      const restore = installGlobals({
        statSftp: async (sftpId: string, target: string) => {
          if (!liveStatAvailable) return undefined;
          statCalls.push({ sftpId, path: target });
          return {
            name: "aops_dns_view_demo.sh",
            type: "file" as const,
            size: 3626,
            sizeKnown: true,
            lastModified: 1758000001000,
          };
        },
        statLocal: async () => null,
        startStreamTransfer: async (options: StartOptions) => {
          startedOptions.push(options);
          resolveTransfer(options);
          sftpTransferCenterStore.ingestBackgroundEvent({
            type: "completed",
            transferId: options.transferId,
            transferred: options.totalBytes ?? 0,
            totalBytes: options.totalBytes ?? 0,
            lifecycleEpoch: 0,
          });
          return {};
        },
        pauseTransfer: async () => ({ success: false, reason: "Transfer is no longer active" }),
        resumeTransfer: async () => ({ success: false, reason: "Transfer is no longer active" }),
      });

      let ops: ReturnType<typeof useSftpTransfers> | undefined;
      let renderer: ReactTestRenderer | undefined;
      function Probe() {
        ops = useSftpTransfers({
          ownerId: "plan-owner",
          getActivePane: (side) => (side === "left" ? makePane("left") : makePane("right")),
          getPaneByConnectionId: () => null,
          getTabByConnectionId: () => null,
          updateTab: () => undefined,
          refresh: async () => undefined,
          clearCacheForConnection: () => undefined,
          handleSessionError: () => undefined,
          sftpSessionsRef: { current: new Map([["remote-conn", "sftp-remote"]]) },
          connectionCacheKeyMapRef: { current: new Map() },
          listLocalFiles: async () => [],
          listRemoteFiles: async () => [],
        });
        return null;
      }

      try {
        await act(async () => { renderer = create(React.createElement(Probe)); });
        await act(async () => {
          const running = ops!.startTransfer(
            [{ name: "aops_dns_view_demo.sh", isDirectory: false }],
            "left",
            "right",
          );
          const options = await transferStarted;
          startedOptions.length = 0;
          startedOptions.push(options);
          await running;
        });

        // Every fresh remote plan must come from a live re-stat of the source.
        if (liveStatAvailable) {
          assert.equal(statCalls.length, 1);
          assert.equal(statCalls[0].sftpId, "sftp-remote");
          assert.equal(statCalls[0].path, "/opt/aops_dns_view_demo.sh");
        }
        const planBytes = startedOptions[0]?.totalBytes;
        if (liveStatAvailable) {
          assert.equal(planBytes, 3626, "plan must use the live remote size, not the stale listing 3622");
        } else {
          // No live stat possible: plan 0 must be omitted so the transfer
          // bridge measures the live size instead of truncating.
          assert.equal(planBytes, undefined);
        }
      } finally {
        renderer?.unmount();
        restore();
      }
    },
  );
}

test("stat-less remote source keeps the listing size in the overwrite dialog and leaves the plan unknown", async () => {
  const started: StartOptions[] = [];
  const restore = installGlobals({
    statSftp: async () => ({
      name: "aops_dns_view_demo.sh",
      type: "file" as const,
      size: 0,
      sizeKnown: false,
      lastModified: 0,
    }),
    statLocal: async () => ({
      name: "aops_dns_view_demo.sh",
      type: "file" as const,
      size: 100,
      lastModified: 1,
    }),
    startStreamTransfer: async (options: StartOptions) => {
      started.push(options);
      return {};
    },
    pauseTransfer: async () => ({ success: false, reason: "Transfer is no longer active" }),
    resumeTransfer: async () => ({ success: false, reason: "Transfer is no longer active" }),
  });

  let ops: ReturnType<typeof useSftpTransfers> | undefined;
  let renderer: ReactTestRenderer | undefined;
  function Probe() {
    ops = useSftpTransfers({
      ownerId: "plan-owner-statless",
      getActivePane: (side) => (side === "left" ? makePane("left") : makePane("right")),
      getPaneByConnectionId: () => null,
      getTabByConnectionId: () => null,
      updateTab: () => undefined,
      refresh: async () => undefined,
      clearCacheForConnection: () => undefined,
      handleSessionError: () => undefined,
      sftpSessionsRef: { current: new Map([["remote-conn", "sftp-remote"]]) },
      connectionCacheKeyMapRef: { current: new Map() },
      listLocalFiles: async () => [],
      listRemoteFiles: async () => [],
    });
    return null;
  }

  try {
    await act(async () => { renderer = create(React.createElement(Probe)); });
    await act(async () => {
      await ops!.startTransfer(
        [{ name: "aops_dns_view_demo.sh", isDirectory: false }],
        "left",
        "right",
      );
    });

    assert.equal(started.length, 0, "an unresolved conflict must not start the transfer");
    assert.equal(ops!.conflicts.length, 1);
    assert.equal(ops!.conflicts[0].newSize, 3622);
    assert.equal(ops!.conflicts[0].newModified, 1758000000000);
    const task = ops!.transfers.find((row) => row.fileName === "aops_dns_view_demo.sh");
    assert.equal(task?.totalBytes, 0, "listing size must not become the transfer plan");
    assert.equal(task?.status, "attention");
  } finally {
    renderer?.unmount();
    restore();
  }
});

test("remote transfer preflight stats stay within the concurrency cap and file bound", async () => {
  const limit = PREFLIGHT_STAT_CONCURRENCY;
  const fileCount = limit + 4;
  let inflight = 0;
  let maxInflight = 0;
  let releaseAll = () => {};
  const gate = new Promise<void>((resolve) => { releaseAll = resolve; });
  let reachedCap = () => {};
  const hitCap = new Promise<void>((resolve) => { reachedCap = resolve; });
  const names = Array.from({ length: fileCount }, (_, index) => `file-${index}.bin`);

  const restore = installGlobals({
    statSftp: async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      if (inflight >= limit) reachedCap();
      try {
        await gate;
      } finally {
        inflight -= 1;
      }
      return {
        name: "file",
        type: "file" as const,
        size: 10,
        sizeKnown: true,
        lastModified: 1,
      };
    },
    statLocal: async () => null,
    startStreamTransfer: async (options: StartOptions) => {
      sftpTransferCenterStore.ingestBackgroundEvent({
        type: "completed",
        transferId: options.transferId,
        transferred: options.totalBytes ?? 0,
        totalBytes: options.totalBytes ?? 0,
        lifecycleEpoch: 0,
      });
      return {};
    },
    pauseTransfer: async () => ({ success: false, reason: "Transfer is no longer active" }),
    resumeTransfer: async () => ({ success: false, reason: "Transfer is no longer active" }),
  });

  let ops: ReturnType<typeof useSftpTransfers> | undefined;
  let renderer: ReactTestRenderer | undefined;
  function Probe() {
    ops = useSftpTransfers({
      ownerId: "plan-owner-concurrency",
      getActivePane: (side) => (side === "left" ? makePane("left") : makePane("right")),
      getPaneByConnectionId: () => null,
      getTabByConnectionId: () => null,
      updateTab: () => undefined,
      refresh: async () => undefined,
      clearCacheForConnection: () => undefined,
      handleSessionError: () => undefined,
      sftpSessionsRef: { current: new Map([["remote-conn", "sftp-remote"]]) },
      connectionCacheKeyMapRef: { current: new Map() },
      listLocalFiles: async () => [],
      listRemoteFiles: async () => [],
    });
    return null;
  }

  try {
    await act(async () => { renderer = create(React.createElement(Probe)); });
    let running: Promise<unknown> = Promise.resolve();
    await act(async () => {
      running = ops!.startTransfer(
        names.map((name) => ({ name, isDirectory: false })),
        "left",
        "right",
      );
      const capTimeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("preflight did not reach the concurrency cap")), 2000);
      });
      await Promise.race([hitCap, capTimeout]);
    });
    assert.equal(maxInflight, limit);
    assert.ok(inflight <= limit);
    releaseAll();
    await act(async () => { await running; });
    assert.equal(maxInflight, limit);
  } finally {
    releaseAll();
    renderer?.unmount();
    restore();
  }
});

test("a preflight timeout stops the rest of the batch", async () => {
  const extra = 4;
  const names = Array.from(
    { length: PREFLIGHT_STAT_CONCURRENCY + extra },
    (_, index) => `hung-${index}.bin`,
  );
  let statCalls = 0;
  const restore = installGlobals({
    statSftp: () => {
      statCalls += 1;
      return new Promise(() => {});
    },
    statLocal: async () => null,
    startStreamTransfer: async (options: StartOptions) => {
      sftpTransferCenterStore.ingestBackgroundEvent({
        type: "completed",
        transferId: options.transferId,
        transferred: options.totalBytes ?? 0,
        totalBytes: options.totalBytes ?? 0,
        lifecycleEpoch: 0,
      });
      return {};
    },
    pauseTransfer: async () => ({ success: false, reason: "Transfer is no longer active" }),
    resumeTransfer: async () => ({ success: false, reason: "Transfer is no longer active" }),
  });

  let ops: ReturnType<typeof useSftpTransfers> | undefined;
  let renderer: ReactTestRenderer | undefined;
  function Probe() {
    ops = useSftpTransfers({
      ownerId: "plan-owner-timeout",
      getActivePane: (side) => (side === "left" ? makePane("left") : makePane("right")),
      getPaneByConnectionId: () => null,
      getTabByConnectionId: () => null,
      updateTab: () => undefined,
      refresh: async () => undefined,
      clearCacheForConnection: () => undefined,
      handleSessionError: () => undefined,
      sftpSessionsRef: { current: new Map([["remote-conn", "sftp-remote"]]) },
      connectionCacheKeyMapRef: { current: new Map() },
      listLocalFiles: async () => [],
      listRemoteFiles: async () => [],
    });
    return null;
  }

  try {
    await act(async () => { renderer = create(React.createElement(Probe)); });
    await act(async () => {
      await ops!.startTransfer(
        names.map((name) => ({ name, isDirectory: false })),
        "left",
        "right",
      );
    });
    // One preflight wave, then stop. Timed-out files are not statted again.
    assert.equal(statCalls, PREFLIGHT_STAT_CONCURRENCY);
  } finally {
    renderer?.unmount();
    restore();
  }
});

test("stat-less preflight results are not statted again before transfer", async () => {
  const names = Array.from(
    { length: PREFLIGHT_STAT_CONCURRENCY + 2 },
    (_, index) => `legacy-${index}.bin`,
  );
  let statCalls = 0;
  let inflight = 0;
  let maxInflight = 0;
  const started: StartOptions[] = [];
  const restore = installGlobals({
    statSftp: async () => {
      statCalls += 1;
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await Promise.resolve();
      inflight -= 1;
      return {
        name: "legacy",
        type: "file" as const,
        size: 0,
        sizeKnown: false,
        lastModified: 0,
      };
    },
    statLocal: async () => null,
    startStreamTransfer: async (options: StartOptions) => {
      started.push(options);
      sftpTransferCenterStore.ingestBackgroundEvent({
        type: "completed",
        transferId: options.transferId,
        transferred: options.totalBytes ?? 0,
        totalBytes: options.totalBytes ?? 0,
        lifecycleEpoch: 0,
      });
      return {};
    },
    pauseTransfer: async () => ({ success: false, reason: "Transfer is no longer active" }),
    resumeTransfer: async () => ({ success: false, reason: "Transfer is no longer active" }),
  });

  let ops: ReturnType<typeof useSftpTransfers> | undefined;
  let renderer: ReactTestRenderer | undefined;
  function Probe() {
    ops = useSftpTransfers({
      ownerId: "plan-owner-statless-batch",
      getActivePane: (side) => (side === "left" ? makePane("left") : makePane("right")),
      getPaneByConnectionId: () => null,
      getTabByConnectionId: () => null,
      updateTab: () => undefined,
      refresh: async () => undefined,
      clearCacheForConnection: () => undefined,
      handleSessionError: () => undefined,
      sftpSessionsRef: { current: new Map([["remote-conn", "sftp-remote"]]) },
      connectionCacheKeyMapRef: { current: new Map() },
      listLocalFiles: async () => [],
      listRemoteFiles: async () => [],
    });
    return null;
  }

  try {
    await act(async () => { renderer = create(React.createElement(Probe)); });
    await act(async () => {
      await ops!.startTransfer(
        names.map((name) => ({ name, isDirectory: false })),
        "left",
        "right",
      );
    });
    assert.equal(statCalls, names.length);
    assert.ok(maxInflight <= PREFLIGHT_STAT_CONCURRENCY);
    assert.equal(started.length, names.length);
    assert.equal(started.filter((options) => options.totalBytes === undefined).length, names.length);
  } finally {
    renderer?.unmount();
    restore();
  }
});

test("files past the preflight bound are not statted again and keep an unknown plan", async () => {
  const extra = 2;
  const names = Array.from({ length: PREFLIGHT_STAT_MAX_FILES + extra }, (_, index) => `bulk-${index}.bin`);
  let statCalls = 0;
  const started: StartOptions[] = [];
  const restore = installGlobals({
    statSftp: async () => {
      statCalls += 1;
      return {
        name: "bulk",
        type: "file" as const,
        size: 20,
        sizeKnown: true,
        lastModified: 5,
      };
    },
    statLocal: async () => null,
    startStreamTransfer: async (options: StartOptions) => {
      started.push(options);
      sftpTransferCenterStore.ingestBackgroundEvent({
        type: "completed",
        transferId: options.transferId,
        transferred: options.totalBytes ?? 0,
        totalBytes: options.totalBytes ?? 0,
        lifecycleEpoch: 0,
      });
      return {};
    },
    pauseTransfer: async () => ({ success: false, reason: "Transfer is no longer active" }),
    resumeTransfer: async () => ({ success: false, reason: "Transfer is no longer active" }),
  });

  let ops: ReturnType<typeof useSftpTransfers> | undefined;
  let renderer: ReactTestRenderer | undefined;
  function Probe() {
    ops = useSftpTransfers({
      ownerId: "plan-owner-bound",
      getActivePane: (side) => (side === "left" ? makePane("left") : makePane("right")),
      getPaneByConnectionId: () => null,
      getTabByConnectionId: () => null,
      updateTab: () => undefined,
      refresh: async () => undefined,
      clearCacheForConnection: () => undefined,
      handleSessionError: () => undefined,
      sftpSessionsRef: { current: new Map([["remote-conn", "sftp-remote"]]) },
      connectionCacheKeyMapRef: { current: new Map() },
      listLocalFiles: async () => [],
      listRemoteFiles: async () => [],
    });
    return null;
  }

  try {
    await act(async () => { renderer = create(React.createElement(Probe)); });
    await act(async () => {
      await ops!.startTransfer(
        names.map((name) => ({ name, isDirectory: false })),
        "left",
        "right",
      );
    });
    assert.equal(statCalls, PREFLIGHT_STAT_MAX_FILES);
    assert.equal(started.length, names.length);
    const omitted = started.filter((options) => options.totalBytes === undefined);
    assert.equal(omitted.length, extra);
  } finally {
    renderer?.unmount();
    restore();
  }
});
