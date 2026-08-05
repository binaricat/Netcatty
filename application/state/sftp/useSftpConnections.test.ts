// Created: 2026-07-21
// Purpose: Verify SFTP prefers live terminal session reuse before fresh auth.

import test from "node:test";
import assert from "node:assert/strict";

import {
  createSftpConnectionId,
  createPinnedReconnectSideResolver,
  openSftpConnectionOnce,
  openSftpWithSessionPreference,
  rejectHostKeyVerificationRequest,
  takeSftpConnectionMetadataForClose,
  releaseSftpConnectionMetadata,
  resolvePinnedReconnectSide,
} from "./useSftpConnections.ts";

test("connection ids stay unique even when connects start in the same millisecond", () => {
  const ids = ["uuid-a", "uuid-b"];
  assert.equal(createSftpConnectionId("left", () => ids.shift()!), "left-uuid-a");
  assert.equal(createSftpConnectionId("left", () => ids.shift()!), "left-uuid-b");
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

test("pinned reconnect side resolver follows moves across async boundaries", async () => {
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
