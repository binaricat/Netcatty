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
