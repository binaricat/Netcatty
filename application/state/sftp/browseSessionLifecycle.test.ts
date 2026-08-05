import assert from "node:assert/strict";
import test from "node:test";

import {
  listRemoteBrowseConnectionIds,
  listRemoteBrowseSftpTabIds,
  isBrowseSessionInteractive,
  listRemoteConnectionIdsForRestore,
  shouldParkBrowseSessions,
  shouldRestoreBrowseSessions,
  takeBrowseSessionsForClose,
} from "./browseSessionLifecycle.ts";

test("editor retention tracks remote browse connections but excludes local panes", () => {
  assert.deepEqual(listRemoteBrowseConnectionIds([
    { connection: { id: "remote-a", isLocal: false } },
    { connection: { id: "local-a", isLocal: true } },
    { connection: null },
    { connection: { id: "remote-a", isLocal: false } },
  ]), ["remote-a"]);
});

test("editor ownership tracks stable remote pane tab ids", () => {
  assert.deepEqual(listRemoteBrowseSftpTabIds([
    { id: "pane-remote-a", connection: { id: "remote-a", isLocal: false } },
    { id: "pane-local", connection: { id: "local-a", isLocal: true } },
    { id: "pane-empty", connection: null },
    { id: "pane-remote-b", connection: { id: "remote-b", isLocal: false } },
  ]), ["pane-remote-a", "pane-remote-b"]);
});

test("keeps a hidden SFTP owner interactive while its promoted editor tab is open", () => {
  const interactive = isBrowseSessionInteractive({
    surfaceVisible: false,
    hasOwnedEditorTab: true,
  });

  assert.equal(interactive, true);
  assert.equal(shouldParkBrowseSessions({ interactive, browseParked: false }), false);
});

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

test("keeps a hidden SFTP owner live while an external editor temp file is open", () => {
  const interactive = isBrowseSessionInteractive({
    surfaceVisible: false,
    hasOwnedEditorTab: false,
    hasActiveExternalEdit: true,
  });

  assert.equal(interactive, true);
  assert.equal(shouldParkBrowseSessions({
    interactive: false,
    browseParked: false,
    activeExternalEditCount: 1,
  }), false);
  assert.equal(shouldParkBrowseSessions({
    interactive: false,
    browseParked: false,
    activeExternalEditCount: 0,
  }), true);
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
