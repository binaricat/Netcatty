// Created: 2026-07-21
// Purpose: Verify SFTP prefers live terminal session reuse before fresh auth.

import test from "node:test";
import assert from "node:assert/strict";
import type { Host } from "../../../domain/models";
import type { SftpPane } from "./types";

import {
  applyToLiveSftpTabSide,
  beginSftpTabConnectRequest,
  buildSftpConnectInFlightKey,
  buildSftpHomeDirCandidates,
  clearSftpConnectInFlightForTab,
  closeSftpTabLifecycle,
  runSftpConnectOnceByKey,
  createSftpConnectionId,
  createPinnedReconnectSideResolver,
  finishSftpTabConnectRequest,
  invalidateSftpTabConnectRequest,
  isSftpHostKeySessionCurrent,
  isSftpTabConnectRequestCurrent,
  openSftpConnectionOnce,
  openSftpWithSessionPreference,
  rejectHostKeyVerificationRequest,
  registerOpenedSftpSession,
  resolveSftpPaneEndpointKey,
  resolveSftpReconnectAttempt,
  takeSftpConnectionMetadataForClose,
  releaseSftpConnectionMetadata,
  resolvePinnedReconnectSide,
  resolveSftpReconnectOptions,
  resolveSftpReconnectSchedule,
  resolveSftpReconnectHost,
  runSftpTabDisconnectIfLatest,
  settleFailedSftpConnectIfCurrent,
} from "./useSftpConnections.ts";

test("home dir candidates prefer user home then root", () => {
  assert.deepEqual(buildSftpHomeDirCandidates("deploy"), ["/home/deploy", "/root"]);
  assert.deepEqual(buildSftpHomeDirCandidates("root"), ["/root"]);
  assert.deepEqual(buildSftpHomeDirCandidates(undefined), ["/root"]);
  assert.deepEqual(buildSftpHomeDirCandidates(null), ["/root"]);
});

test("connection ids stay unique even when connects start in the same millisecond", () => {
  const ids = ["uuid-a", "uuid-b"];
  assert.equal(createSftpConnectionId("left", () => ids.shift()!), "left-uuid-a");
  assert.equal(createSftpConnectionId("left", () => ids.shift()!), "left-uuid-b");
});

test("runSftpConnectOnceByKey shares an in-flight connect for the same tab and endpoint", async () => {
  const inFlight = new Map<string, Promise<void>>();
  let runs = 0;
  let releaseFirst: (() => void) | undefined;

  const first = runSftpConnectOnceByKey(inFlight, "left:tab-1:host-key:ssh-session-1:/home", async () => {
    runs += 1;
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
  });
  const second = runSftpConnectOnceByKey(inFlight, "left:tab-1:host-key:ssh-session-1:/home", async () => {
    runs += 1;
  });

  assert.equal(runs, 1);
  releaseFirst?.();
  await Promise.all([first, second]);
  assert.equal(runs, 1);
  assert.equal(inFlight.size, 0);
});

test("disconnect detaches only that tab's in-flight connects", () => {
  const pending = Promise.resolve();
  const inFlight = new Map<string, Promise<void>>([
    [`tab-a\u0000host-a\u0000`, pending],
    [`tab-b\u0000host-a\u0000`, pending],
  ]);

  clearSftpConnectInFlightForTab(inFlight, "tab-a");

  assert.deepEqual([...inFlight.keys()], ["tab-b\u0000host-a\u0000"]);
});

test("buildSftpConnectInFlightKey uses the allocated tab id for forced new tabs", () => {
  const first = buildSftpConnectInFlightKey({
    side: "left",
    tabId: "new-tab-a",
    targetConnectionKey: "host-key",
    sourceSessionId: "ssh-session-1",
    initialPath: "/home",
    forceNewTab: true,
  });
  const second = buildSftpConnectInFlightKey({
    side: "left",
    tabId: "new-tab-b",
    targetConnectionKey: "host-key",
    sourceSessionId: "ssh-session-1",
    initialPath: "/home",
    forceNewTab: true,
  });

  assert.notEqual(first, second);
});

test("moving an in-flight reconnect does not create a second connection", () => {
  const base = {
    tabId: "moving-tab",
    targetConnectionKey: "host-key",
    sourceSessionId: "ssh-session-1",
    initialPath: "/home",
  };
  assert.equal(
    buildSftpConnectInFlightKey({ ...base, side: "left" }),
    buildSftpConnectInFlightKey({ ...base, side: "right" }),
  );
});

test("the newest request for a moved tab wins after an older close finishes", () => {
  const requests = new Map<string, symbol>();
  const oldRequest = beginSftpTabConnectRequest(requests, "tab-moving");
  const newRequest = beginSftpTabConnectRequest(requests, "tab-moving");

  assert.equal(isSftpTabConnectRequestCurrent(requests, "tab-moving", oldRequest), false);
  assert.equal(isSftpTabConnectRequestCurrent(requests, "tab-moving", newRequest), true);

  finishSftpTabConnectRequest(requests, "tab-moving", oldRequest);
  assert.equal(isSftpTabConnectRequestCurrent(requests, "tab-moving", newRequest), true);

  invalidateSftpTabConnectRequest(requests, "tab-moving");
  assert.equal(isSftpTabConnectRequestCurrent(requests, "tab-moving", newRequest), false);
});

test("a slow disconnect cannot clear a newer connection on the same tab", async () => {
  const requests = new Map<string, symbol>();
  let releaseClose: (() => void) | undefined;
  let clears = 0;
  const disconnect = runSftpTabDisconnectIfLatest({
    requests,
    tabId: "tab-a",
    disconnect: async () => new Promise<void>((resolve) => {
      releaseClose = resolve;
    }),
    clear: () => {
      clears += 1;
    },
  });

  await Promise.resolve();
  const newerConnect = beginSftpTabConnectRequest(requests, "tab-a");
  finishSftpTabConnectRequest(requests, "tab-a", newerConnect);
  releaseClose?.();

  assert.equal(await disconnect, false);
  assert.equal(clears, 0);
});

test("a slow disconnect clears a tab after it moves to the other pane", async () => {
  const requests = new Map<string, symbol>();
  let leftTabs: ReadonlyArray<{ id: string }> = [{ id: "tab-moving" }];
  let rightTabs: ReadonlyArray<{ id: string }> = [];
  let releaseClose: (() => void) | undefined;
  let clearedSide: "left" | "right" | null = null;
  const disconnect = runSftpTabDisconnectIfLatest({
    requests,
    tabId: "tab-moving",
    disconnect: async () => new Promise<void>((resolve) => {
      releaseClose = resolve;
    }),
    clear: () => {
      applyToLiveSftpTabSide({
        requestedSide: "left",
        tabId: "tab-moving",
        leftTabs,
        rightTabs,
        apply: (side) => {
          clearedSide = side;
        },
      });
    },
  });

  await Promise.resolve();
  leftTabs = [];
  rightTabs = [{ id: "tab-moving" }];
  releaseClose?.();

  assert.equal(await disconnect, true);
  assert.equal(clearedSide, "right");
});

test("closing a tab removes it before a slow connection release", async () => {
  const requests = new Map<string, symbol>();
  beginSftpTabConnectRequest(requests, "tab-a");
  const pending = Promise.resolve();
  const inFlight = new Map<string, Promise<void>>([
    ["tab-a\u0000host-a", pending],
    ["tab-b\u0000host-b", pending],
  ]);
  const connectedHosts = new Map<string, Host | "local">([["tab-a", "local"]]);
  let releaseClose: (() => void) | undefined;
  let closedSide: "left" | "right" | null = null;
  const closing = closeSftpTabLifecycle({
    requestedSide: "left",
    tabId: "tab-a",
    leftTabs: [{ id: "tab-a" }],
    rightTabs: [],
    connectRequests: requests,
    connectInFlight: inFlight,
    connectedHosts,
    closeTab: (side) => {
      closedSide = side;
    },
    releaseConnection: async () => new Promise<void>((resolve) => {
      releaseClose = resolve;
    }),
  });

  assert.equal(closedSide, "left");
  assert.equal(requests.has("tab-a"), false);
  assert.deepEqual([...inFlight.keys()], ["tab-b\u0000host-b"]);
  assert.equal(connectedHosts.has("tab-a"), false);
  releaseClose?.();
  await closing;
});

test("a slow failed-request cleanup cannot overwrite a newer successful connection", async () => {
  let current = true;
  let releaseClose: (() => void) | undefined;
  let failuresWritten = 0;
  const settlement = settleFailedSftpConnectIfCurrent({
    isCurrent: () => current,
    close: async () => new Promise<void>((resolve) => {
      releaseClose = resolve;
    }),
    updateFailure: () => {
      failuresWritten += 1;
    },
  });

  await Promise.resolve();
  current = false;
  releaseClose?.();

  assert.equal(await settlement, false);
  assert.equal(failuresWritten, 0);
});

test("stale host-key prompts do not belong to a replacement connection", () => {
  const requests = new Map<string, symbol>();
  const oldToken = beginSftpTabConnectRequest(requests, "tab-a");
  const oldOwner = { tabId: "tab-a", connectRequestToken: oldToken };
  assert.equal(isSftpHostKeySessionCurrent(requests, oldOwner), true);

  beginSftpTabConnectRequest(requests, "tab-a");
  assert.equal(isSftpHostKeySessionCurrent(requests, oldOwner), false);
});

test("reconnect state only follows the endpoint that originally failed", () => {
  assert.equal(resolveSftpReconnectAttempt({
    isPinnedBackgroundReconnect: false,
    previousPaneReconnecting: true,
    previousConnectionKey: "host-a",
    targetConnectionKey: "host-a",
  }), true);
  assert.equal(resolveSftpReconnectAttempt({
    isPinnedBackgroundReconnect: false,
    previousPaneReconnecting: true,
    previousConnectionKey: "host-a",
    targetConnectionKey: "host-b",
  }), false);
  assert.equal(resolveSftpReconnectAttempt({
    isPinnedBackgroundReconnect: true,
    initialPath: "/srv/app",
    previousPaneReconnecting: false,
    previousConnectionKey: null,
    targetConnectionKey: "host-a",
  }), true);
});

test("reconnect keeps its endpoint identity after released connection metadata is gone", () => {
  const hostA = {
    id: "host-a",
    label: "A",
    hostname: "a.example",
    port: 22,
    username: "alice",
    protocol: "ssh",
  } as Host;
  const hostB = {
    id: "host-b",
    label: "B",
    hostname: "b.example",
    port: 22,
    username: "bob",
    protocol: "ssh",
  } as Host;
  const pane = {
    id: "tab-a",
    reconnecting: true,
    connection: {
      id: "released-connection-a",
      hostId: hostA.id,
      hostLabel: hostA.label,
      isLocal: false,
      status: "disconnected",
      currentPath: "/srv/app",
    },
  } as SftpPane;

  const previousConnectionKey = resolveSftpPaneEndpointKey({
    connection: pane.connection,
    cachedConnectionKey: null,
    connectedHost: hostA,
  });
  const hostAKey = resolveSftpPaneEndpointKey({
    connection: pane.connection,
    cachedConnectionKey: null,
    connectedHost: hostA,
  });
  const hostBKey = resolveSftpPaneEndpointKey({
    connection: {
      ...pane.connection!,
      hostId: hostB.id,
    },
    cachedConnectionKey: null,
    connectedHost: hostB,
  });

  assert.equal(resolveSftpReconnectAttempt({
    isPinnedBackgroundReconnect: false,
    previousPaneReconnecting: pane.reconnecting,
    previousConnectionKey,
    targetConnectionKey: hostAKey!,
  }), true);
  assert.equal(resolveSftpReconnectAttempt({
    isPinnedBackgroundReconnect: false,
    previousPaneReconnecting: pane.reconnecting,
    previousConnectionKey,
    targetConnectionKey: hostBKey!,
  }), false);
});

test("forced terminal rebinds never merge into an older in-flight route", () => {
  const base = {
    side: "left" as const,
    tabId: "tab-1",
    targetConnectionKey: "host-key",
    initialPath: "/srv/app",
  };
  const oldRoute = buildSftpConnectInFlightKey(base);
  const newRouteDrop = buildSftpConnectInFlightKey({
    ...base,
    connectRequestKey: "drop-route-b",
  });

  assert.notEqual(oldRoute, newRouteDrop);
});

const openOptions = {
  sessionId: "sftp-request-1",
  hostname: "192.168.9.138",
  username: "zhlrs",
  port: 22,
} as NetcattySSHOptions;

test("openSftpWithSessionPreference opens session-backed SFTP before authing again", async () => {
  const calls: string[] = [];
  let expectedEndpoint: NetcattySSHOptions | undefined;
  const sftpId = await openSftpWithSessionPreference({
    bridge: {
      openSftpForSession: async (sessionId: string, endpoint?: NetcattySSHOptions) => {
        calls.push(`openForSession:${sessionId}`);
        expectedEndpoint = endpoint;
        return "session-backed-sftp";
      },
      openSftp: async () => {
        calls.push("openSftp");
        return "fresh-sftp";
      },
    },
    sourceSessionId: "ssh-session-1",
    openOptions,
  });

  assert.equal(sftpId, "session-backed-sftp");
  assert.deepEqual(calls, ["openForSession:ssh-session-1"]);
  assert.equal(expectedEndpoint, openOptions);
});

test("openSftpWithSessionPreference falls back to normal SFTP when session reuse fails", async () => {
  const calls: string[] = [];
  const sftpId = await openSftpWithSessionPreference({
    bridge: {
      openSftpForSession: async (sessionId: string) => {
        calls.push(`openForSession:${sessionId}`);
        throw new Error("channel unavailable");
      },
      openSftp: async (options: NetcattySSHOptions) => {
        calls.push(`openSftp:${options.sessionId}`);
        return "fresh-sftp";
      },
    },
    sourceSessionId: "ssh-session-1",
    openOptions,
  });

  assert.equal(sftpId, "fresh-sftp");
  assert.deepEqual(calls, ["openForSession:ssh-session-1", "openSftp:sftp-request-1"]);
});

test("strict source-session reuse never dials a different route after reuse fails", async () => {
  const calls: string[] = [];
  let receivedOptions: NetcattySSHOptions | undefined;
  await assert.rejects(
    openSftpWithSessionPreference({
      bridge: {
        openSftpForSession: async (sessionId: string, options?: NetcattySSHOptions) => {
          calls.push(`openForSession:${sessionId}`);
          receivedOptions = options;
          throw new Error("channel unavailable");
        },
        openSftp: async () => {
          calls.push("openSftp");
          return "fresh-sftp";
        },
      },
      sourceSessionId: "ssh-session-1",
      requireSourceSessionReuse: true,
      openOptions,
    }),
    /channel unavailable/,
  );

  assert.deepEqual(calls, ["openForSession:ssh-session-1"]);
  assert.equal(receivedOptions?.requireExactSourceSession, true);
});

test("openSftpWithSessionPreference tries session reuse for sudo SFTP before fresh auth", async () => {
  const calls: string[] = [];
  let passedOptions: NetcattySSHOptions | undefined;
  const sftpId = await openSftpWithSessionPreference({
    bridge: {
      openSftpForSession: async (sessionId: string, options?: NetcattySSHOptions) => {
        calls.push(`openForSession:${sessionId}`);
        passedOptions = options;
        return "sudo-session-backed-sftp";
      },
      openSftp: async () => {
        calls.push("openSftp");
        return "fresh-sftp";
      },
    },
    sourceSessionId: "ssh-session-1",
    openOptions: {
      ...openOptions,
      sudo: true,
      password: "sudo-pass",
    },
  });

  assert.equal(sftpId, "sudo-session-backed-sftp");
  assert.deepEqual(calls, ["openForSession:ssh-session-1"]);
  assert.equal(passedOptions?.sudo, true);
  assert.equal(passedOptions?.password, "sudo-pass");
});

test("openSftpWithSessionPreference opens normal SFTP without a source session", async () => {
  const calls: string[] = [];
  const sftpId = await openSftpWithSessionPreference({
    bridge: {
      openSftpForSession: async () => {
        calls.push("openForSession");
        return "session-backed-sftp";
      },
      openSftp: async (options: NetcattySSHOptions) => {
        calls.push(`openSftp:${options.sessionId}`);
        return "fresh-sftp";
      },
    },
    sourceSessionId: undefined,
    openOptions,
  });

  assert.equal(sftpId, "fresh-sftp");
  assert.deepEqual(calls, ["openSftp:sftp-request-1"]);
});

test("one connect attempt never repeats a failed fresh SFTP dial after reuse fails", async () => {
  const calls: string[] = [];
  await assert.rejects(
    openSftpConnectionOnce({
      bridge: {
        openSftpForSession: async () => {
          calls.push("openForSession");
          throw new Error("shared channel unavailable");
        },
        openSftp: async () => {
          calls.push("openSftp");
          throw new Error("authentication failed");
        },
      },
      sourceSessionId: "ssh-session-1",
      openOptions,
    }),
    /authentication failed/,
  );

  assert.deepEqual(calls, ["openForSession", "openSftp"]);
});

test("closing connections releases their session and cache-key metadata", () => {
  const sessions = new Map<string, string>();
  const cacheKeys = new Map<string, string>();
  const cleared: string[] = [];
  for (let index = 0; index < 1_000; index += 1) {
    const connectionId = `connection-${index}`;
    sessions.set(connectionId, `sftp-${index}`);
    cacheKeys.set(connectionId, `endpoint-${index}`);
    assert.equal(takeSftpConnectionMetadataForClose({
      connectionId,
      sftpSessions: sessions,
      connectionCacheKeys: cacheKeys,
      clearCacheForConnection: (id) => { cleared.push(id); },
    }), `sftp-${index}`);
  }
  assert.equal(sessions.size, 0);
  assert.equal(cacheKeys.size, 0);
  assert.equal(cleared.length, 1_000);
});

test("release metadata closes the backend before a failed connection is retained as an error", async () => {
  const sessions = new Map([["connection-1", "sftp-1"]]);
  const cacheKeys = new Map([["connection-1", "endpoint-1"]]);
  const closed: string[] = [];
  const cleared: string[] = [];

  await releaseSftpConnectionMetadata({
    connectionId: "connection-1",
    sftpSessions: sessions,
    connectionCacheKeys: cacheKeys,
    clearCacheForConnection: (id) => { cleared.push(id); },
    closeSftp: async (id) => { closed.push(id); },
  });

  assert.deepEqual(closed, ["sftp-1"]);
  assert.deepEqual(cleared, ["connection-1"]);
  assert.equal(sessions.size, 0);
  assert.equal(cacheKeys.size, 0);
});

test("a connection that finishes after its owner unmounts is closed instead of registered", async () => {
  const sftpSessions = new Map<string, string>();
  const closed: string[] = [];
  const notified: string[] = [];
  const disposedRef = { current: true };

  const registered = await registerOpenedSftpSession({
    disposedRef,
    connectionId: "connection-late",
    sftpId: "sftp-late",
    sftpSessions,
    closeSftp: async (sftpId) => { closed.push(sftpId); },
    onRemoteSessionClosed: (sftpId) => { notified.push(sftpId); },
  });

  assert.equal(registered, false);
  assert.equal(sftpSessions.size, 0);
  assert.deepEqual(closed, ["sftp-late"]);
  assert.deepEqual(notified, ["sftp-late"]);
});

test("a connection that finishes after browse parking is closed instead of registered", async () => {
  const sftpSessions = new Map<string, string>();
  const closed: string[] = [];
  const lifecycle = { generation: 1, interactive: true };
  const openedGeneration = lifecycle.generation;
  lifecycle.generation += 1;
  lifecycle.interactive = false;

  const registered = await registerOpenedSftpSession({
    disposedRef: { current: false },
    canRegister: () => (
      lifecycle.interactive && lifecycle.generation === openedGeneration
    ),
    connectionId: "connection-parked",
    sftpId: "sftp-parked",
    sftpSessions,
    closeSftp: async (sftpId) => { closed.push(sftpId); },
  });

  assert.equal(registered, false);
  assert.equal(sftpSessions.size, 0);
  assert.deepEqual(closed, ["sftp-parked"]);
});

test("releaseSftpConnectionMetadata notifies after a remote session closes", async () => {
  const sessions = new Map([["connection-1", "sftp-1"]]);
  const cacheKeys = new Map([["connection-1", "cache-1"]]);
  const notified: string[] = [];

  await releaseSftpConnectionMetadata({
    connectionId: "connection-1",
    sftpSessions: sessions,
    connectionCacheKeys: cacheKeys,
    clearCacheForConnection: () => {},
    closeSftp: async () => {},
    onRemoteSessionClosed: (sftpId) => { notified.push(sftpId); },
  });

  assert.deepEqual(notified, ["sftp-1"]);
});

test("resolvePinnedReconnectSide follows a tab moved to the other side", () => {
  assert.equal(
    resolvePinnedReconnectSide("left", "tab-1", [], [{ id: "tab-1" }]),
    "right",
  );
  assert.equal(
    resolvePinnedReconnectSide("right", "tab-1", [{ id: "tab-1" }], []),
    "left",
  );
  assert.equal(
    resolvePinnedReconnectSide("left", "tab-1", [{ id: "tab-1" }], []),
    "left",
  );
  assert.equal(
    resolvePinnedReconnectSide("left", undefined, [], [{ id: "tab-1" }]),
    "left",
  );
  assert.throws(
    () => resolvePinnedReconnectSide("left", "gone", [], []),
    /SFTP tab is no longer available/,
  );
});

test("rejectHostKeyVerificationRequest rejects an orphaned verification", () => {
  const responses: Array<[string, boolean, boolean]> = [];

  rejectHostKeyVerificationRequest({
    respondHostKeyVerification: async (requestId, accept, addToKnownHosts) => {
      responses.push([requestId, accept, addToKnownHosts]);
      return { success: true };
    },
  }, "hostkey-1");

  assert.deepEqual(responses, [["hostkey-1", false, false]]);
});

test("a newly allocated forced-connect tab follows moves across async boundaries", async () => {
  let leftTabs: ReadonlyArray<{ id: string }> = [{ id: "tab-1" }];
  let rightTabs: ReadonlyArray<{ id: string }> = [];
  const resolveSide = createPinnedReconnectSideResolver(
    "left",
    "tab-1",
    () => leftTabs,
    () => rightTabs,
  );

  assert.equal(resolveSide(), "left");

  await Promise.resolve();
  leftTabs = [];
  rightTabs = [{ id: "tab-1" }];

  assert.equal(resolveSide(), "right");

  rightTabs = [];
  assert.equal(resolveSide(), "right");
});

test("a just-allocated connect tab uses its known side until React state commits", () => {
  let leftTabs: ReadonlyArray<{ id: string }> = [];
  let rightTabs: ReadonlyArray<{ id: string }> = [];
  const resolveSide = createPinnedReconnectSideResolver(
    "left",
    "new-tab",
    () => leftTabs,
    () => rightTabs,
  );

  assert.equal(resolveSide(), "left");
  leftTabs = [{ id: "new-tab" }];
  assert.equal(resolveSide(), "left");
  leftTabs = [];
  rightTabs = [{ id: "new-tab" }];
  assert.equal(resolveSide(), "right");
});

test("reconnect uses the active tab host instead of the side's previous host", () => {
  const hostA = {
    id: "host-a",
    label: "A",
    hostname: "a.example",
    port: 22,
    username: "alice",
    protocol: "ssh",
  } as Host;
  const hostB = {
    id: "host-b",
    label: "B",
    hostname: "b.example",
    port: 22,
    username: "bob",
    protocol: "ssh",
  } as Host;
  const activePane = {
    id: "tab-a-moved-right",
    connection: {
      id: "connection-a",
      hostId: "host-a",
      hostLabel: "A",
      isLocal: false,
      status: "disconnected",
      currentPath: "/home/alice",
    },
  } as SftpPane;

  assert.equal(resolveSftpReconnectHost({
    pane: activePane,
    lastHost: hostB,
    connectedHostByTabId: new Map([[activePane.id, hostA]]),
    hosts: [hostA, hostB],
  }), hostA);
});

test("a reconnecting tab moved to the other pane still schedules recovery", () => {
  const movedPane = {
    id: "tab-a",
    reconnecting: true,
    connection: {
      id: "connection-a",
      hostId: "host-a",
      hostLabel: "A",
      isLocal: false,
      status: "disconnected",
      currentPath: "/home/alice",
    },
  } as SftpPane;

  assert.deepEqual(resolveSftpReconnectSchedule({
    requestedSide: "left",
    pane: movedPane,
    leftTabs: [],
    rightTabs: [movedPane],
  }), { side: "right", tabId: "tab-a" });
});

test("automatic reconnect retries the source session then allows a fresh open", () => {
  const pane = {
    id: "tab-a",
    connection: {
      id: "connection-a",
      hostId: "host-a",
      hostLabel: "A",
      isLocal: false,
      status: "disconnected",
      currentPath: "/home/alice",
      sourceSessionId: "ssh-a",
    },
  } as SftpPane;

  assert.deepEqual(resolveSftpReconnectOptions(pane), {
    tabId: "tab-a",
    sourceSessionId: "ssh-a",
  });
  assert.equal(
    "requireSourceSessionReuse" in resolveSftpReconnectOptions(pane),
    false,
  );
});
