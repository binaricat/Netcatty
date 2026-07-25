import assert from "node:assert/strict";
import test from "node:test";

import {
  collectLiveRemoteConnectionIds,
  listRemoteConnectionIdsForRestore,
  shouldParkBrowseSessions,
  shouldRestoreBrowseSessions,
  takeBrowseSessionsForClose,
  takeUnusedBrowseSessions,
} from "./browseSessionLifecycle.ts";

test("parks browse only when the interactive surface hides and not already parked", () => {
  assert.equal(shouldParkBrowseSessions({ interactive: false, browseParked: false }), true);
  assert.equal(shouldParkBrowseSessions({ interactive: false, browseParked: true }), false);
  assert.equal(shouldParkBrowseSessions({ interactive: true, browseParked: false }), false);
  assert.equal(shouldParkBrowseSessions({
    interactive: false,
    browseParked: false,
    activeTransfersCount: 2,
  }), false);
});

test("restores browse when the surface becomes interactive again after park", () => {
  assert.equal(shouldRestoreBrowseSessions({ interactive: true, browseParked: true }), true);
  assert.equal(shouldRestoreBrowseSessions({ interactive: true, browseParked: false }), false);
  assert.equal(shouldRestoreBrowseSessions({ interactive: false, browseParked: true }), false);
});

test("takeBrowseSessionsForClose snapshots and clears the map", () => {
  const sessions = new Map([
    ["conn-a", "sftp-1"],
    ["conn-b", "sftp-2"],
  ]);
  assert.deepEqual(takeBrowseSessionsForClose(sessions), [
    { connectionId: "conn-a", sftpId: "sftp-1" },
    { connectionId: "conn-b", sftpId: "sftp-2" },
  ]);
  assert.equal(sessions.size, 0);
});

test("listRemoteConnectionIdsForRestore skips local and already-live remotes", () => {
  const ids = listRemoteConnectionIdsForRestore({
    leftTabs: [
      { connection: { id: "local", isLocal: true } },
      { connection: { id: "remote-a", isLocal: false } },
      { connection: null },
    ],
    rightTabs: [
      { connection: { id: "remote-b", isLocal: false } },
      { connection: { id: "remote-a", isLocal: false } },
    ],
    liveSessionConnectionIds: new Set(["remote-b"]),
  });
  assert.deepEqual(ids, ["remote-a"]);
});

test("collectLiveRemoteConnectionIds excludes a closing tab and locals", () => {
  const ids = collectLiveRemoteConnectionIds({
    leftTabs: [
      { id: "closing", connection: { id: "remote-a", isLocal: false } },
      { id: "keep", connection: { id: "remote-b", isLocal: false } },
      { id: "local", connection: { id: "local-1", isLocal: true } },
    ],
    rightTabs: [
      { id: "other", connection: { id: "remote-c", isLocal: false } },
    ],
    exclude: { side: "left", tabId: "closing" },
  });
  assert.deepEqual([...ids].sort(), ["remote-b", "remote-c"]);
});

test("takeUnusedBrowseSessions removes mappings not owned by live tabs", () => {
  const sessions = new Map([
    ["remote-a", "sftp-a"],
    ["remote-b", "sftp-b"],
    ["orphan", "sftp-orphan"],
  ]);
  const unused = takeUnusedBrowseSessions(sessions, new Set(["remote-b"]));
  assert.deepEqual(unused, [
    { connectionId: "remote-a", sftpId: "sftp-a" },
    { connectionId: "orphan", sftpId: "sftp-orphan" },
  ]);
  assert.deepEqual([...sessions.keys()], ["remote-b"]);
});
