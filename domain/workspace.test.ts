import test from "node:test";
import assert from "node:assert/strict";

import type { Workspace, WorkspaceNode } from "./models.ts";
import {
  appendPaneToWorkspaceRoot,
  cloneWorkspaceTree,
  insertPaneIntoWorkspace,
  reorderWorkspaceFocusSessionOrder,
  resolveWorkspaceFocusSessionOrder,
  setWorkspaceFocusedSessionId,
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

test("appendPaneToWorkspaceRoot ignores an existing session pane", () => {
  assert.equal(appendPaneToWorkspaceRoot(root, "s2"), root);
});

test("insertPaneIntoWorkspace ignores an existing session pane", () => {
  assert.equal(
    insertPaneIntoWorkspace(root, "s2", {
      direction: "vertical",
      position: "right",
      targetSessionId: "s1",
    }),
    root,
  );
});

const nestedRoot: WorkspaceNode = {
  id: "split-root",
  type: "split",
  direction: "vertical",
  sizes: [0.8, 0.2],
  children: [
    { id: "pane-a", type: "pane", sessionId: "s1" },
    {
      id: "split-inner",
      type: "split",
      direction: "horizontal",
      sizes: [0.5, 0.5],
      children: [
        { id: "pane-b", type: "pane", sessionId: "s2" },
        { id: "pane-c", type: "pane", sessionId: "s3" },
      ],
    },
  ],
};

test("cloneWorkspaceTree remaps every sessionId and preserves direction/sizes", () => {
  const map = new Map([["s1", "n1"], ["s2", "n2"], ["s3", "n3"]]);
  const clone = cloneWorkspaceTree(nestedRoot, map);

  assert.equal(clone.type, "split");
  if (clone.type !== "split") return;
  assert.equal(clone.direction, "vertical");
  assert.deepEqual(clone.sizes, [0.8, 0.2]);
  const inner = clone.children[1];
  assert.equal(inner.type, "split");
  if (inner.type !== "split") return;
  assert.equal(inner.direction, "horizontal");
  assert.deepEqual(inner.sizes, [0.5, 0.5]);

  const collect = (n: WorkspaceNode): string[] =>
    n.type === "pane" ? [n.sessionId] : n.children.flatMap(collect);
  assert.deepEqual(collect(clone), ["n1", "n2", "n3"]);
});

test("cloneWorkspaceTree mints fresh node ids and does not mutate the source", () => {
  const map = new Map([["s1", "n1"], ["s2", "n2"], ["s3", "n3"]]);
  const clone = cloneWorkspaceTree(nestedRoot, map);
  assert.notEqual(clone.id, nestedRoot.id);
  assert.equal(nestedRoot.id, "split-root");
  const collectSrc = (n: WorkspaceNode): string[] =>
    n.type === "pane" ? [n.sessionId] : n.children.flatMap(collectSrc);
  assert.deepEqual(collectSrc(nestedRoot), ["s1", "s2", "s3"]);

  const collectIds = (n: WorkspaceNode): string[] =>
    n.type === "pane" ? [n.id] : [n.id, ...n.children.flatMap(collectIds)];
  const srcIds = new Set(collectIds(nestedRoot));
  assert.ok(collectIds(clone).every(id => !srcIds.has(id)));
});

test("cloneWorkspaceTree uses pre-minted node ids when supplied", () => {
  const clone = cloneWorkspaceTree(
    nestedRoot,
    new Map([["s1", "n1"], ["s2", "n2"], ["s3", "n3"]]),
    new Map([["split-root", "new-root"], ["pane-a", "new-a"], ["split-inner", "new-inner"], ["pane-b", "new-b"], ["pane-c", "new-c"]]),
  );
  assert.equal(clone.id, "new-root");
  if (clone.type !== "split") return;
  assert.equal(clone.children[0].id, "new-a");
  assert.equal(clone.children[1].id, "new-inner");
});

test("cloneWorkspaceTree keeps original sessionId when the map lacks it", () => {
  const clone = cloneWorkspaceTree(
    { id: "p", type: "pane", sessionId: "s1" },
    new Map(),
  );
  assert.equal(clone.type === "pane" && clone.sessionId, "s1");
});

test("setWorkspaceFocusedSessionId keeps the same array when focus is unchanged", () => {
  const workspaces = [
    { id: "ws-1", title: "One", root, focusedSessionId: "s2" },
    { id: "ws-2", title: "Two", root, focusedSessionId: "s1" },
  ] as Workspace[];
  // Pane click + focus capture both call the setter; neither may re-render the shell.
  assert.equal(setWorkspaceFocusedSessionId(workspaces, "ws-1", "s2"), workspaces);
  assert.equal(setWorkspaceFocusedSessionId(workspaces, "missing", "s3"), workspaces);
});

test("setWorkspaceFocusedSessionId replaces only the focused workspace", () => {
  const workspaces = [
    { id: "ws-1", title: "One", root, focusedSessionId: "s2" },
    { id: "ws-2", title: "Two", root, focusedSessionId: "s1" },
  ] as Workspace[];
  const next = setWorkspaceFocusedSessionId(workspaces, "ws-1", "s3");
  assert.notEqual(next, workspaces);
  assert.equal(next[0].focusedSessionId, "s3");
  assert.equal(next[1], workspaces[1]);
  assert.equal(workspaces[0].focusedSessionId, "s2", "input is not mutated");
});
