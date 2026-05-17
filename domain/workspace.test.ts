import test from "node:test";
import assert from "node:assert/strict";

import type { WorkspaceNode } from "./models.ts";
import {
  reorderWorkspaceFocusSessionOrder,
  resolveWorkspaceFocusSessionOrder,
} from "./workspace.ts";

const root: WorkspaceNode = {
  id: "split-1",
  type: "split",
  direction: "vertical",
  children: [
    { id: "pane-1", type: "pane", sessionId: "s1" },
    { id: "pane-2", type: "pane", sessionId: "s2" },
    { id: "pane-3", type: "pane", sessionId: "s3" },
  ],
};

test("resolveWorkspaceFocusSessionOrder follows tree order when no saved order exists", () => {
  assert.deepEqual(resolveWorkspaceFocusSessionOrder(root), ["s1", "s2", "s3"]);
});

test("resolveWorkspaceFocusSessionOrder drops stale ids and appends new panes", () => {
  assert.deepEqual(
    resolveWorkspaceFocusSessionOrder(root, ["stale", "s3", "s1"]),
    ["s3", "s1", "s2"],
  );
});

test("reorderWorkspaceFocusSessionOrder moves a session before a target", () => {
  assert.deepEqual(
    reorderWorkspaceFocusSessionOrder(root, undefined, "s3", "s1", "before"),
    ["s3", "s1", "s2"],
  );
});

test("reorderWorkspaceFocusSessionOrder moves a session after a target", () => {
  assert.deepEqual(
    reorderWorkspaceFocusSessionOrder(root, ["s1", "s2", "s3"], "s1", "s3", "after"),
    ["s2", "s3", "s1"],
  );
});
