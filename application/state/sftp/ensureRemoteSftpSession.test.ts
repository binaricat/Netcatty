import assert from "node:assert/strict";
import test from "node:test";

import type { Host } from "../../../domain/models";
import { ensureRemoteSftpSession } from "./ensureRemoteSftpSession";
import type { SftpPane } from "./types";

const host = {
  id: "host-1",
  label: "CI-Build-01",
  hostname: "ci.example",
  port: 22,
  username: "root",
  protocol: "ssh",
} as Host;

const remotePane = (connectionId: string): SftpPane => ({
  id: "pane-1",
  connection: {
    id: connectionId,
    hostId: "host-1",
    hostLabel: "CI-Build-01",
    isLocal: false,
    status: "connected",
    currentPath: "/root",
  },
  files: [],
  loading: false,
  reconnecting: false,
  error: null,
  selectedFiles: new Set(),
  filter: "",
  filenameEncoding: "auto",
  showHiddenFiles: false,
  connectionLogs: [],
} as unknown as SftpPane);

test("returns an existing mapped SFTP session without reconnecting", async () => {
  let connectCalls = 0;
  const sftpId = await ensureRemoteSftpSession({
    side: "left",
    getActivePane: () => remotePane("conn-1"),
    sftpSessionsRef: { current: new Map([["conn-1", "sftp-live"]]) },
    lastConnectedHostRef: { current: { left: host, right: null } },
    connect: async () => { connectCalls += 1; },
  });
  assert.equal(sftpId, "sftp-live");
  assert.equal(connectCalls, 0);
});

test("reconnects when the mapped session is missing", async () => {
  let connectCalls = 0;
  const sessions = { current: new Map<string, string>() };
  const sftpId = await ensureRemoteSftpSession({
    side: "left",
    getActivePane: () => {
      // After reconnect, connection id stays and mapping is filled by connect mock.
      return remotePane("conn-1");
    },
    sftpSessionsRef: sessions,
    lastConnectedHostRef: { current: { left: host, right: null } },
    connect: async () => {
      connectCalls += 1;
      sessions.current.set("conn-1", "sftp-reconnected");
    },
  });
  assert.equal(connectCalls, 1);
  assert.equal(sftpId, "sftp-reconnected");
});

test("forceReconnect reopens even when a mapping exists", async () => {
  let connectCalls = 0;
  const sessions = { current: new Map([["conn-1", "sftp-stale"]]) };
  const sftpId = await ensureRemoteSftpSession({
    side: "left",
    getActivePane: () => remotePane("conn-1"),
    sftpSessionsRef: sessions,
    lastConnectedHostRef: { current: { left: host, right: null } },
    forceReconnect: true,
    connect: async () => {
      connectCalls += 1;
      sessions.current.set("conn-1", "sftp-new");
    },
  });
  assert.equal(connectCalls, 1);
  assert.equal(sftpId, "sftp-new");
});

test("probe failure triggers reconnect", async () => {
  let connectCalls = 0;
  const sessions = { current: new Map([["conn-1", "sftp-dead"]]) };
  const sftpId = await ensureRemoteSftpSession({
    side: "left",
    getActivePane: () => remotePane("conn-1"),
    sftpSessionsRef: sessions,
    lastConnectedHostRef: { current: { left: host, right: null } },
    probeSession: async () => {
      throw new Error("SFTP session not found");
    },
    connect: async () => {
      connectCalls += 1;
      sessions.current.set("conn-1", "sftp-fresh");
    },
  });
  assert.equal(connectCalls, 1);
  assert.equal(sftpId, "sftp-fresh");
});

test("uses resolveHostById when lastConnectedHostRef is empty", async () => {
  let connectedHost: Host | "local" | null = null;
  const sessions = { current: new Map<string, string>() };
  const sftpId = await ensureRemoteSftpSession({
    side: "left",
    getActivePane: () => remotePane("conn-1"),
    sftpSessionsRef: sessions,
    lastConnectedHostRef: { current: { left: null, right: null } },
    resolveHostById: (id) => (id === "host-1" ? host : null),
    connect: async (_side, resolved) => {
      connectedHost = resolved;
      sessions.current.set("conn-1", "sftp-vault");
    },
  });
  assert.equal(sftpId, "sftp-vault");
  assert.equal((connectedHost as Host).hostname, "ci.example");
  assert.equal((connectedHost as Host).username, "root");
});

test("refuses synthetic root@label:22 when host metadata is missing", async () => {
  await assert.rejects(
    () => ensureRemoteSftpSession({
      side: "left",
      getActivePane: () => remotePane("conn-1"),
      sftpSessionsRef: { current: new Map() },
      lastConnectedHostRef: { current: { left: null, right: null } },
      connect: async () => {
        throw new Error("should not connect");
      },
    }),
    /credentials are unavailable/,
  );
});

test("reconnect reads the new connection id from the pinned tab", async () => {
  let currentConnectionId = "conn-old";
  let connectTabId: string | undefined;
  const sessions = { current: new Map<string, string>() };
  const sftpId = await ensureRemoteSftpSession({
    side: "left",
    tabId: "pane-1",
    getActivePane: () => remotePane(currentConnectionId),
    sftpSessionsRef: sessions,
    lastConnectedHostRef: { current: { left: host, right: null } },
    connect: async (_side, _host, options) => {
      connectTabId = options?.tabId;
      sessions.current.delete(currentConnectionId);
      currentConnectionId = "conn-new";
      sessions.current.set(currentConnectionId, "sftp-after-reconnect");
    },
  });
  assert.equal(connectTabId, "pane-1");
  assert.equal(currentConnectionId, "conn-new");
  assert.equal(sftpId, "sftp-after-reconnect");
});

test("reconnect prefers the pane host over a stale side-wide lastConnected host", async () => {
  const otherHost = {
    id: "host-other",
    label: "Other",
    hostname: "other.example",
    port: 22,
    username: "deploy",
    protocol: "ssh",
  } as Host;
  let connectedHost: Host | "local" | null = null;
  const sessions = { current: new Map<string, string>() };
  const sftpId = await ensureRemoteSftpSession({
    side: "left",
    tabId: "pane-1",
    getActivePane: () => remotePane("conn-1"),
    sftpSessionsRef: sessions,
    // Side last connected to a different host (another tab), which must not win.
    lastConnectedHostRef: { current: { left: otherHost, right: null } },
    resolveHostById: (id) => {
      if (id === "host-1") return host;
      if (id === "host-other") return otherHost;
      return null;
    },
    connect: async (_side, resolved) => {
      connectedHost = resolved;
      sessions.current.set("conn-1", "sftp-pane-host");
    },
  });
  assert.equal(sftpId, "sftp-pane-host");
  assert.equal((connectedHost as Host).id, "host-1");
  assert.equal((connectedHost as Host).hostname, "ci.example");
});

test("reconnect reuses lastConnected host when it matches the pane hostId", async () => {
  const lastHostWithOverrides = {
    ...host,
    hostname: "session-override.example",
  } as Host;
  let connectedHost: Host | "local" | null = null;
  const sessions = { current: new Map<string, string>() };
  await ensureRemoteSftpSession({
    side: "left",
    getActivePane: () => remotePane("conn-1"),
    sftpSessionsRef: sessions,
    lastConnectedHostRef: { current: { left: lastHostWithOverrides, right: null } },
    resolveHostById: (id) => (id === "host-1" ? host : null),
    connect: async (_side, resolved) => {
      connectedHost = resolved;
      sessions.current.set("conn-1", "sftp-matched");
    },
  });
  assert.equal((connectedHost as Host).hostname, "session-override.example");
});
