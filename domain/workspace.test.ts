import test from "node:test";
import assert from "node:assert/strict";

import type { Workspace, WorkspaceNode } from "./models.ts";
import {
  appendPaneToWorkspaceRoot,
  cloneWorkspaceTree,
  collectSessionIds,
  createEmptyWorkspaceRoot,
  insertPaneIntoWorkspace,
  movePaneInWorkspace,
  pruneWorkspaceNode,
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

test("the first appended terminal fills an empty workspace without an empty sibling", () => {
  for (const direction of ["vertical", "horizontal"] as const) {
    const emptyRoot = createEmptyWorkspaceRoot();
    const result = appendPaneToWorkspaceRoot(emptyRoot, "first-terminal", direction);
    assert.equal(result.type, "pane", direction);
    if (result.type !== "pane") continue;
    assert.equal(result.sessionId, "first-terminal");
    assert.deepEqual(collectSessionIds(result), ["first-terminal"]);
    assert.deepEqual(collectSessionIds(emptyRoot), []);
  }
});

test("the first inserted terminal fills an empty workspace for every drop edge", () => {
  for (const hint of [
    { direction: "vertical", position: "left" },
    { direction: "vertical", position: "right" },
    { direction: "horizontal", position: "top" },
    { direction: "horizontal", position: "bottom" },
  ] as const) {
    const result = insertPaneIntoWorkspace(createEmptyWorkspaceRoot(), "first-terminal", hint);
    assert.equal(result.type, "pane", hint.position);
    if (result.type !== "pane") continue;
    assert.equal(result.sessionId, "first-terminal");
    assert.deepEqual(collectSessionIds(result), ["first-terminal"]);
  }
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

// --- movePaneInWorkspace (#4037) ---

const collectPaneNodeIds = (n: WorkspaceNode): string[] =>
  n.type === "pane" ? [n.id] : n.children.flatMap(collectPaneNodeIds);

const assertEverySplitSizesValid = (n: WorkspaceNode): void => {
  if (n.type === "pane") return;
  assert.equal(n.sizes?.length, n.children.length, "every split sizes its children");
  for (const size of n.sizes ?? []) {
    assert.ok(Number.isFinite(size) && size > 0, "sizes are positive finite numbers");
  }
  n.children.forEach(assertEverySplitSizesValid);
};

test("movePaneInWorkspace moves a pane to the left/right of a sibling", () => {
  const left = movePaneInWorkspace(root, "s3", { direction: "vertical", position: "left", targetSessionId: "s1" });
  assert.deepEqual(collectSessionIds(left), ["s3", "s1", "s2"]);

  const right = movePaneInWorkspace(root, "s1", { direction: "vertical", position: "right", targetSessionId: "s2" });
  assert.deepEqual(collectSessionIds(right), ["s2", "s1", "s3"]);
});

test("movePaneInWorkspace moves a pane above/below a sibling", () => {
  const top = movePaneInWorkspace(root, "s3", { direction: "horizontal", position: "top", targetSessionId: "s1" });
  assert.deepEqual(collectSessionIds(top), ["s3", "s1", "s2"]);

  const bottom = movePaneInWorkspace(root, "s2", { direction: "horizontal", position: "bottom", targetSessionId: "s3" });
  assert.deepEqual(collectSessionIds(bottom), ["s1", "s3", "s2"]);
});

test("movePaneInWorkspace rebalances sizes and keeps membership identical", () => {
  const moved = movePaneInWorkspace(root, "s3", { direction: "vertical", position: "left", targetSessionId: "s1" });
  assert.deepEqual(collectSessionIds(moved).sort(), collectSessionIds(root).sort(), "membership unchanged");
  assertEverySplitSizesValid(moved);
});

test("movePaneInWorkspace keeps untouched pane node ids stable and does not mutate the source", () => {
  const moved = movePaneInWorkspace(root, "s3", { direction: "vertical", position: "left", targetSessionId: "s1" });
  const after = collectPaneNodeIds(moved);
  for (const id of ["pane-1", "pane-2"]) {
    assert.ok(after.includes(id), `untouched pane ${id} keeps its node id`);
  }
  assert.deepEqual(collectSessionIds(root), ["s1", "s2", "s3"], "source tree is not mutated");
  assert.deepEqual(root.type === "split" ? root.children.map(c => c.id) : [], ["pane-1", "pane-2", "pane-3"]);
});

test("movePaneInWorkspace without a target wraps the pruned root (move to root split)", () => {
  const moved = movePaneInWorkspace(root, "s2", { direction: "vertical", position: "right" });
  assert.deepEqual(collectSessionIds(moved), ["s1", "s3", "s2"]);
  assert.equal(moved.type, "split");
  if (moved.type !== "split") return;
  assert.equal(moved.children[1].type, "pane");
  if (moved.children[1].type !== "pane") return;
  assert.equal(moved.children[1].sessionId, "s2");
});

test("movePaneInWorkspace handles a target inside the source subtree", () => {
  const subtreeRoot: WorkspaceNode = {
    id: "split-root",
    type: "split",
    direction: "vertical",
    sizes: [0.7, 0.3],
    children: [
      {
        id: "split-inner",
        type: "split",
        direction: "horizontal",
        sizes: [0.5, 0.5],
        children: [
          { id: "pane-a", type: "pane", sessionId: "s1" },
          { id: "pane-b", type: "pane", sessionId: "s2" },
        ],
      },
      { id: "pane-c", type: "pane", sessionId: "s3" },
    ],
  };

  // s1 leaves the inner split, which collapses onto s2; s1 then lands as a
  // new sibling of s2.
  const moved = movePaneInWorkspace(subtreeRoot, "s1", { direction: "vertical", position: "right", targetSessionId: "s2" });
  assert.deepEqual(collectSessionIds(moved), ["s2", "s1", "s3"]);
  assertEverySplitSizesValid(moved);
});

test("movePaneInWorkspace is a no-op when the pane drops onto itself", () => {
  assert.equal(
    movePaneInWorkspace(root, "s2", { direction: "vertical", position: "left", targetSessionId: "s2" }),
    root,
  );
});

test("movePaneInWorkspace is a no-op for a single-pane workspace", () => {
  const single: WorkspaceNode = { id: "pane-only", type: "pane", sessionId: "s1" };
  assert.equal(
    movePaneInWorkspace(single, "s1", { direction: "vertical", position: "left", targetSessionId: "s1" }),
    single,
  );
  // Also when the lone pane sits behind a collapsed split.
  const wrapped: WorkspaceNode = {
    id: "split-wrap",
    type: "split",
    direction: "vertical",
    children: [{ id: "pane-only-2", type: "pane", sessionId: "s1" }],
    sizes: [1],
  };
  assert.equal(
    movePaneInWorkspace(wrapped, "s1", { direction: "vertical", position: "left" }),
    wrapped,
  );
});

test("movePaneInWorkspace is a no-op for an unknown session", () => {
  assert.equal(
    movePaneInWorkspace(root, "ghost", { direction: "vertical", position: "left", targetSessionId: "s1" }),
    root,
  );
});

test("movePaneInWorkspace keeps the source when its drop target closed during dragging", () => {
  const hint = { direction: "vertical", position: "right", targetSessionId: "s2" } as const;
  const afterTargetClosed = pruneWorkspaceNode(root, "s2");
  assert.ok(afterTargetClosed);
  assert.deepEqual(collectSessionIds(afterTargetClosed), ["s1", "s3"]);

  const moved = movePaneInWorkspace(afterTargetClosed, "s1", hint);
  assert.equal(moved, afterTargetClosed, "a stale drop must preserve the current tree");
  assert.deepEqual(collectSessionIds(moved), ["s1", "s3"], "the dragged terminal remains present");
});

test("movePaneInWorkspace preserves the original root for a missing explicit target", () => {
  const moved = movePaneInWorkspace(root, "s2", {
    direction: "horizontal", position: "bottom", targetSessionId: "missing",
  });
  assert.equal(moved, root);
  assert.deepEqual(collectSessionIds(moved), ["s1", "s2", "s3"]);
});
