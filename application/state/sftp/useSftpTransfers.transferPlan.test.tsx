/** @test issue #3559 — dual-pane transfers must re-stat remote sources before planning */
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useSftpTransfers } from "./useSftpTransfers";
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
