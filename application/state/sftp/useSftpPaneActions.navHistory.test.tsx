import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import type { SftpFileEntry } from "../../../domain/models";
import {
  canGoBack,
  canGoForward,
  createNavHistory,
  resolveSftpConnectNavHistory,
} from "../../../domain/sftpNavHistory";
import type { DirectoryListingCache } from "./directoryListingCache";
import type { SftpPane } from "./types";
import { useSftpPaneActions } from "./useSftpPaneActions";

function createConnectedPane(id: string, connectionId: string, initialPath: string, isLocal = false): SftpPane {
  return {
    id,
    connection: {
      id: connectionId,
      hostId: isLocal ? "local" : "host-1",
      hostLabel: isLocal ? "Local" : "Server",
      isLocal,
      status: "connected",
      currentPath: initialPath,
      homeDir: "/home/alice",
    },
    files: [],
    loading: false,
    reconnecting: false,
    error: null,
    connectionLogs: [],
    selectedFiles: new Set(),
    filter: "",
    filenameEncoding: "auto",
    showHiddenFiles: false,
    transferMutationToken: 0,
    navHistory: createNavHistory(initialPath),
  };
}

function mountHarness(options?: {
  leftInitialPath?: string;
  rightInitialPath?: string;
  failingPaths?: Set<string>;
  dirCacheTtlMs?: number;
  listDir?: (dirPath: string) => Promise<SftpFileEntry[]>;
}) {
  const previousActFlag = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const leftPane = createConnectedPane("tab-left", "conn-left", options?.leftInitialPath ?? "/home/alice", false);
  const rightPane = createConnectedPane("tab-right", "conn-right", options?.rightInitialPath ?? "/tmp", true);

  const leftTabsRef = { current: { tabs: [leftPane], activeTabId: leftPane.id as string | null } };
  const rightTabsRef = { current: { tabs: [rightPane], activeTabId: rightPane.id as string | null } };
  const navSeqRef = { current: { left: 0, right: 0 } };
  const dirCacheRef = { current: new Map() as DirectoryListingCache };
  const sftpSessionsRef = { current: new Map<string, string>([["conn-left", "sftp-1"]]) };
  const lastConnectedHostRef = { current: { left: null, right: null } };
  const connectionCacheKeyMapRef = { current: new Map<string, string>() };
  const failingPaths = options?.failingPaths ?? new Set<string>();
  const listedPaths: string[] = [];

  const getSideTabs = (side: "left" | "right") => (side === "left" ? leftTabsRef : rightTabsRef);
  const getActivePane = (side: "left" | "right"): SftpPane | null => {
    const ref = getSideTabs(side).current;
    return ref.tabs.find((tab) => tab.id === ref.activeTabId) ?? null;
  };
  const updateTab = (side: "left" | "right", tabId: string, updater: (pane: SftpPane) => SftpPane) => {
    const ref = getSideTabs(side);
    ref.current = {
      ...ref.current,
      tabs: ref.current.tabs.map((tab) => (tab.id === tabId ? updater(tab) : tab)),
    };
  };
  const updateActiveTab = (side: "left" | "right", updater: (pane: SftpPane) => SftpPane) => {
    const activeTabId = getSideTabs(side).current.activeTabId;
    if (!activeTabId) return;
    updateTab(side, activeTabId, updater);
  };

  const listDir = async (dirPath: string): Promise<SftpFileEntry[]> => {
    listedPaths.push(dirPath);
    if (options?.listDir) {
      return options.listDir(dirPath);
    }
    if (failingPaths.has(dirPath)) {
      throw new Error(`Permission denied: ${dirPath}`);
    }
    return [];
  };

  let actions: ReturnType<typeof useSftpPaneActions> | undefined;
  let renderer: ReactTestRenderer | undefined;

  function Probe() {
    actions = useSftpPaneActions({
      hosts: [],
      getActivePane,
      updateTab,
      updateActiveTab,
      leftTabsRef,
      rightTabsRef,
      navSeqRef,
      dirCacheRef,
      sftpSessionsRef,
      lastConnectedHostRef,
      connectionCacheKeyMapRef,
      makeCacheKey: (connectionId, dirPath, encoding) => `${connectionId}::${encoding || "auto"}::${dirPath}`,
      clearCacheForConnection: (connectionId) => {
        for (const key of dirCacheRef.current.keys()) {
          if (key.startsWith(`${connectionId}::`)) dirCacheRef.current.delete(key);
        }
      },
      listLocalFiles: listDir,
      listRemoteFiles: (_sftpId, dirPath) => listDir(dirPath),
      handleSessionError: () => {},
      releaseConnection: async () => {},
      isSessionError: () => false,
      clearSelectionsExcept: () => {},
      dirCacheTtlMs: options?.dirCacheTtlMs ?? 10_000,
    });
    return null;
  }

  return {
    get actions() {
      assert.ok(actions);
      return actions;
    },
    getPane: (side: "left" | "right") => {
      const pane = getActivePane(side);
      assert.ok(pane);
      return pane;
    },
    failingPaths,
    listedPaths,
    dirCacheRef,
    updateTab,
    render: async () => {
      await act(async () => {
        renderer = create(React.createElement(Probe));
      });
    },
    unmount: async () => {
      await act(async () => {
        renderer?.unmount();
      });
      renderer = undefined;
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousActFlag;
    },
  };
}

test("useSftpPaneActions records navigations, traverses back/forward without duplicates, and truncates on branch", async () => {
  const harness = mountHarness();
  try {
    await harness.render();

    assert.equal(canGoBack(harness.getPane("left").navHistory!), false);
    assert.equal(canGoForward(harness.getPane("left").navHistory!), false);

    assert.equal(await harness.actions.navigateTo("left", "/var"), "reached");
    assert.equal(await harness.actions.navigateTo("left", "/var/log"), "reached");
    // Navigating to the same current path is a no-op in history
    assert.equal(await harness.actions.navigateTo("left", "/var/log"), "reached");
    assert.deepEqual(harness.getPane("left").navHistory?.entries, ["/home/alice", "/var", "/var/log"]);
    assert.equal(harness.getPane("left").navHistory?.index, 2);

    // navigateUp pushes parent directory onto history
    await harness.actions.navigateUp("left");
    assert.equal(harness.getPane("left").connection?.currentPath, "/var");
    assert.deepEqual(harness.getPane("left").navHistory?.entries, ["/home/alice", "/var", "/var/log", "/var"]);
    assert.equal(harness.getPane("left").navHistory?.index, 3);

    // Back moves pointer without pushing duplicates or clearing forward entries
    assert.equal(await harness.actions.navigateBack("left"), "reached");
    assert.equal(harness.getPane("left").connection?.currentPath, "/var/log");
    assert.equal(harness.getPane("left").navHistory?.index, 2);
    assert.equal(canGoForward(harness.getPane("left").navHistory!), true);

    assert.equal(await harness.actions.navigateBack("left"), "reached");
    assert.equal(harness.getPane("left").connection?.currentPath, "/var");
    assert.equal(harness.getPane("left").navHistory?.index, 1);

    // Refresh preserves forward stack
    await harness.actions.refresh("left");
    assert.deepEqual(harness.getPane("left").navHistory?.entries, ["/home/alice", "/var", "/var/log", "/var"]);
    assert.equal(harness.getPane("left").navHistory?.index, 1);
    assert.equal(canGoForward(harness.getPane("left").navHistory!), true);

    // Forward steps ahead without duplicating
    assert.equal(await harness.actions.navigateForward("left"), "reached");
    assert.equal(harness.getPane("left").connection?.currentPath, "/var/log");
    assert.equal(harness.getPane("left").navHistory?.index, 2);

    // New navigation from mid-stack truncates forward entries
    assert.equal(await harness.actions.navigateTo("left", "/etc"), "reached");
    assert.deepEqual(harness.getPane("left").navHistory?.entries, ["/home/alice", "/var", "/var/log", "/etc"]);
    assert.equal(harness.getPane("left").navHistory?.index, 3);
    assert.equal(canGoForward(harness.getPane("left").navHistory!), false);

    // Right pane history stays independent
    assert.deepEqual(harness.getPane("right").navHistory?.entries, ["/tmp"]);
    assert.equal(harness.getPane("right").navHistory?.index, 0);
  } finally {
    await harness.unmount();
  }
});

test("useSftpPaneActions preserves history pointer and forward stack when navigation fails", async () => {
  const failingPaths = new Set<string>(["/forbidden"]);
  // Disable cache hits so back/forward also exercises async failure rollback
  const harness = mountHarness({ failingPaths, dirCacheTtlMs: 0 });
  try {
    await harness.render();

    assert.equal(await harness.actions.navigateTo("left", "/var"), "reached");
    assert.equal(await harness.actions.navigateTo("left", "/var/log"), "reached");
    assert.equal(await harness.actions.navigateBack("left"), "reached");
    assert.equal(harness.getPane("left").connection?.currentPath, "/var");
    assert.equal(harness.getPane("left").navHistory?.index, 1);

    // Failed normal navigation must NOT truncate forward entry (/var/log) or push /forbidden
    assert.equal(await harness.actions.navigateTo("left", "/forbidden"), "failed");
    assert.equal(harness.getPane("left").connection?.currentPath, "/var");
    assert.deepEqual(harness.getPane("left").navHistory?.entries, ["/home/alice", "/var", "/var/log"]);
    assert.equal(harness.getPane("left").navHistory?.index, 1);
    assert.equal(canGoForward(harness.getPane("left").navHistory!), true);

    // Failed Back navigation must NOT decrement pointer
    harness.failingPaths.add("/home/alice");
    assert.equal(await harness.actions.navigateBack("left"), "failed");
    assert.equal(harness.getPane("left").connection?.currentPath, "/var");
    assert.deepEqual(harness.getPane("left").navHistory?.entries, ["/home/alice", "/var", "/var/log"]);
    assert.equal(harness.getPane("left").navHistory?.index, 1);

    // Failed Forward navigation must NOT increment pointer
    harness.failingPaths.add("/var/log");
    assert.equal(await harness.actions.navigateForward("left"), "failed");
    assert.equal(harness.getPane("left").connection?.currentPath, "/var");
    assert.deepEqual(harness.getPane("left").navHistory?.entries, ["/home/alice", "/var", "/var/log"]);
    assert.equal(harness.getPane("left").navHistory?.index, 1);

    // Once /var/log is readable again, Forward still works cleanly
    harness.failingPaths.delete("/var/log");
    assert.equal(await harness.actions.navigateForward("left"), "reached");
    assert.equal(harness.getPane("left").connection?.currentPath, "/var/log");
    assert.equal(harness.getPane("left").navHistory?.index, 2);
  } finally {
    await harness.unmount();
  }
});

test("host switch resets navigation history so previous host paths cannot be navigated via Back", async () => {
  const harness = mountHarness();
  try {
    await harness.render();

    assert.equal(await harness.actions.navigateTo("left", "/var"), "reached");
    assert.equal(await harness.actions.navigateTo("left", "/etc"), "reached");
    assert.equal(canGoBack(harness.getPane("left").navHistory!), true);

    // Simulate switching connection on the same tab (sameEndpointReconnect = false)
    harness.updateTab("left", "tab-left", (prev) => ({
      ...prev,
      connection: prev.connection
        ? { ...prev.connection, id: "conn-host-2", hostId: "host-2", currentPath: "/srv/app" }
        : null,
      navHistory: resolveSftpConnectNavHistory({
        sameEndpointReconnect: false,
        previousHistory: prev.navHistory,
        startPath: "/srv/app",
      }),
    }));

    assert.deepEqual(harness.getPane("left").navHistory?.entries, ["/srv/app"]);
    assert.equal(harness.getPane("left").navHistory?.index, 0);
    assert.equal(canGoBack(harness.getPane("left").navHistory!), false);
    assert.equal(canGoForward(harness.getPane("left").navHistory!), false);
    assert.equal(await harness.actions.navigateBack("left"), "aborted");
  } finally {
    await harness.unmount();
  }
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("mid-flight refresh inherits pending push navigation and clears cleanly on settle or failure", async () => {
  const pendingLoads: Array<{ path: string; deferred: ReturnType<typeof createDeferred<SftpFileEntry[]>> }> = [];
  const harness = mountHarness({
    dirCacheTtlMs: 0,
    listDir: (dirPath) => {
      if (dirPath === "/slow" || dirPath === "/slow-fail") {
        const deferred = createDeferred<SftpFileEntry[]>();
        pendingLoads.push({ path: dirPath, deferred });
        return deferred.promise;
      }
      return Promise.resolve([]);
    },
  });

  try {
    await harness.render();

    // Start slow navigation to /slow, then refresh mid-flight before /slow settles.
    const slowNavPromise = harness.actions.navigateTo("left", "/slow");
    assert.equal(harness.getPane("left").connection?.currentPath, "/slow");
    assert.equal(harness.getPane("left").loading, true);
    assert.deepEqual(harness.getPane("left").navHistory?.entries, ["/home/alice"]);

    const refreshPromise = harness.actions.refresh("left");
    assert.equal(pendingLoads.length, 2);

    // Original slow navigation finishes first (superseded), then refresh settles.
    pendingLoads[0].deferred.resolve([]);
    assert.equal(await slowNavPromise, "superseded");
    pendingLoads[1].deferred.resolve([]);
    await refreshPromise;

    assert.equal(harness.getPane("left").connection?.currentPath, "/slow");
    assert.deepEqual(harness.getPane("left").navHistory?.entries, ["/home/alice", "/slow"]);
    assert.equal(harness.getPane("left").navHistory?.index, 1);

    // Back returns to /home/alice cleanly.
    assert.equal(await harness.actions.navigateBack("left"), "reached");
    assert.equal(harness.getPane("left").connection?.currentPath, "/home/alice");
    assert.equal(harness.getPane("left").navHistory?.index, 0);

    // If a mid-flight refresh fails, currentPath reverts and history/forward stack stay intact.
    pendingLoads.length = 0;
    const failNavPromise = harness.actions.navigateTo("left", "/slow-fail");
    const failRefreshPromise = harness.actions.refresh("left");
    assert.equal(pendingLoads.length, 2);

    pendingLoads[0].deferred.resolve([]);
    assert.equal(await failNavPromise, "superseded");
    pendingLoads[1].deferred.reject(new Error("I/O error"));
    await failRefreshPromise;

    assert.equal(harness.getPane("left").connection?.currentPath, "/home/alice");
    assert.deepEqual(harness.getPane("left").navHistory?.entries, ["/home/alice", "/slow"]);
    assert.equal(harness.getPane("left").navHistory?.index, 0);
    assert.equal(canGoForward(harness.getPane("left").navHistory!), true);
  } finally {
    await harness.unmount();
  }
});

test("mid-flight refresh during Forward or Back advances history index consistently", async () => {
  const pendingLoads: Array<{ path: string; deferred: ReturnType<typeof createDeferred<SftpFileEntry[]>> }> = [];
  let interceptTarget: string | null = null;
  const harness = mountHarness({
    dirCacheTtlMs: 0,
    listDir: (dirPath) => {
      if (interceptTarget && dirPath === interceptTarget) {
        const deferred = createDeferred<SftpFileEntry[]>();
        pendingLoads.push({ path: dirPath, deferred });
        return deferred.promise;
      }
      return Promise.resolve([]);
    },
  });

  try {
    await harness.render();

    // Build history: [/home/alice, /var, /var/log], then step Back to /var (index 1).
    assert.equal(await harness.actions.navigateTo("left", "/var"), "reached");
    assert.equal(await harness.actions.navigateTo("left", "/var/log"), "reached");
    assert.equal(await harness.actions.navigateBack("left"), "reached");
    assert.equal(harness.getPane("left").connection?.currentPath, "/var");
    assert.equal(harness.getPane("left").navHistory?.index, 1);

    // Start Forward -> /var/log, then trigger Refresh before it finishes.
    interceptTarget = "/var/log";
    const forwardPromise = harness.actions.navigateForward("left");
    assert.equal(harness.getPane("left").connection?.currentPath, "/var/log");
    assert.equal(harness.getPane("left").navHistory?.index, 1);

    const refreshPromise = harness.actions.refresh("left");
    assert.equal(pendingLoads.length, 2);

    pendingLoads[0].deferred.resolve([]);
    assert.equal(await forwardPromise, "superseded");
    pendingLoads[1].deferred.resolve([]);
    await refreshPromise;

    // Displayed directory and history index must stay synchronized at /var/log (index 2).
    assert.equal(harness.getPane("left").connection?.currentPath, "/var/log");
    assert.deepEqual(harness.getPane("left").navHistory?.entries, ["/home/alice", "/var", "/var/log"]);
    assert.equal(harness.getPane("left").navHistory?.index, 2);

    // Next Back must go to /var (NOT skip /var and jump to /home/alice).
    interceptTarget = "/var";
    pendingLoads.length = 0;
    const backPromise = harness.actions.navigateBack("left");
    const backRefreshPromise = harness.actions.refresh("left");
    assert.equal(pendingLoads.length, 2);

    pendingLoads[0].deferred.resolve([]);
    assert.equal(await backPromise, "superseded");
    pendingLoads[1].deferred.resolve([]);
    await backRefreshPromise;

    assert.equal(harness.getPane("left").connection?.currentPath, "/var");
    assert.equal(harness.getPane("left").navHistory?.index, 1);
    assert.equal(canGoBack(harness.getPane("left").navHistory!), true);
    assert.equal(canGoForward(harness.getPane("left").navHistory!), true);
  } finally {
    await harness.unmount();
  }
});
