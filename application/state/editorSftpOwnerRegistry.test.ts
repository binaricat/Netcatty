import assert from "node:assert/strict";
import test from "node:test";
import { findEditorSftpOwnerTabId, registerEditorSftpOwnerResolver } from "./editorSftpOwnerRegistry";

test("resolves the owning tab for a registered SFTP connection id", () => {
  const unregister = registerEditorSftpOwnerResolver(() => ({
    connectionIds: ["left-abc", "right-def"],
    ownerTabId: "session-1",
  }));
  try {
    assert.equal(findEditorSftpOwnerTabId("left-abc"), "session-1");
    assert.equal(findEditorSftpOwnerTabId("right-def"), "session-1");
    assert.equal(findEditorSftpOwnerTabId("left-unknown"), null);
    assert.equal(findEditorSftpOwnerTabId(undefined), null);
  } finally {
    unregister();
  }
});

test("falls back to the stable pane tab id when the connection id is stale", () => {
  // Browse reconnects regenerate connection ids; an unsaved editor may still
  // reference the pre-reconnect id, so owner resolution must also match on the
  // stable pane tab id.
  const unregister = registerEditorSftpOwnerResolver(() => ({
    connectionIds: ["conn_new"],
    paneTabIds: ["pane_1"],
    ownerTabId: "session-1",
  }));
  try {
    assert.equal(findEditorSftpOwnerTabId("conn_old", "pane_1"), "session-1");
    assert.equal(findEditorSftpOwnerTabId(undefined, "pane_1"), "session-1");
    assert.equal(findEditorSftpOwnerTabId("conn_old", "pane_unknown"), null);
    assert.equal(findEditorSftpOwnerTabId(undefined, undefined), null);
  } finally {
    unregister();
  }
});

test("unregistering a resolver stops it from resolving owners", () => {
  const unregister = registerEditorSftpOwnerResolver(() => ({
    connectionIds: ["conn-x"],
    ownerTabId: "tab-x",
  }));
  unregister();
  assert.equal(findEditorSftpOwnerTabId("conn-x"), null);
});

test("resolvers without an owner tab id never match", () => {
  const unregister = registerEditorSftpOwnerResolver(() => ({
    connectionIds: ["conn-y"],
    ownerTabId: null,
  }));
  try {
    assert.equal(findEditorSftpOwnerTabId("conn-y"), null);
  } finally {
    unregister();
  }
});
