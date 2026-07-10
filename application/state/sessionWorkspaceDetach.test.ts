import assert from "node:assert/strict";
import test from "node:test";
import type { TerminalSession, Workspace } from "../../domain/models";
import {
  applyCloseSessionToSessions,
  closeSessionWorkspaceLayoutState,
  detachSessionFromWorkspaceState,
  replaceDissolvedWorkspaceTabOrder,
  resolveActiveTabAfterCloseSession,
} from "./sessionWorkspaceDetach";

const session = (id: string, workspaceId = "ws-1"): TerminalSession => ({
  id,
  hostId: id,
  hostLabel: id,
  status: "connected",
  workspaceId,
});

const workspace = (sessionIds: string[]): Workspace => ({
  id: "ws-1",
  title: "Workspace",
  focusedSessionId: sessionIds[0],
  focusSessionOrder: sessionIds,
  root: sessionIds.length === 1
    ? { id: "pane-1", type: "pane", sessionId: sessionIds[0] }
    : {
        id: "split-1",
        type: "split",
        direction: "vertical",
        children: sessionIds.map((sessionId, index) => ({
          id: `pane-${index + 1}`,
          type: "pane" as const,
          sessionId,
        })),
        sizes: sessionIds.map(() => 1),
      },
});

test("detach dissolves the original workspace when one session remains", () => {
  const result = detachSessionFromWorkspaceState({
    sessions: [session("s1"), session("s2")],
    workspaces: [workspace(["s1", "s2"])],
    sessionId: "s1",
  });

  assert.equal(result.changed, true);
  assert.equal(result.activeTabId, "s1");
  assert.deepEqual(result.sessions.map((s) => [s.id, s.workspaceId]), [
    ["s1", undefined],
    ["s2", undefined],
  ]);
  assert.equal(result.workspaces.length, 0);
  assert.equal(result.dissolvedWorkspaceId, "ws-1");
  assert.deepEqual(result.replacementTabIds, ["s1", "s2"]);
});

test("detach preserves the other sessions in a multi-pane workspace", () => {
  const result = detachSessionFromWorkspaceState({
    sessions: [session("s1"), session("s2"), session("s3")],
    workspaces: [workspace(["s1", "s2", "s3"])],
    sessionId: "s2",
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.sessions.map((s) => [s.id, s.workspaceId]), [
    ["s1", "ws-1"],
    ["s2", undefined],
    ["s3", "ws-1"],
  ]);
  assert.deepEqual(result.workspaces[0].focusSessionOrder, ["s1", "s3"]);
  assert.equal(result.workspaces[0].focusedSessionId, "s1");
  assert.deepEqual(
    result.workspaces[0].root.type === "split"
      ? result.workspaces[0].root.children.map((child) => child.type === "pane" ? child.sessionId : null)
      : [],
    ["s1", "s3"],
  );
});

test("dissolved workspace replacement preserves its tab position", () => {
  assert.deepEqual(
    replaceDissolvedWorkspaceTabOrder(["log-1", "ws-1", "session-3"], "ws-1", ["s1", "s2"]),
    ["log-1", "s1", "s2", "session-3"],
  );
});

test("dissolved workspace replacement removes duplicate replacement ids", () => {
  assert.deepEqual(
    replaceDissolvedWorkspaceTabOrder(["s1", "ws-1", "session-3"], "ws-1", ["s1", "s2"]),
    ["s1", "s2", "session-3"],
  );
});

test("dissolved workspace replacement is idempotent", () => {
  const once = replaceDissolvedWorkspaceTabOrder(["log-1", "ws-1", "session-3"], "ws-1", ["s1", "s2"]);

  assert.deepEqual(
    replaceDissolvedWorkspaceTabOrder(once, "ws-1", ["s1", "s2"]),
    once,
  );
});

test("single remaining session preserves dissolved workspace tab position", () => {
  assert.deepEqual(
    replaceDissolvedWorkspaceTabOrder(["log-1", "ws-1", "session-3"], "ws-1", ["s2"]),
    ["log-1", "s2", "session-3"],
  );
});

test("closing a workspace session dissolves the workspace when one terminal remains", () => {
  const result = closeSessionWorkspaceLayoutState([workspace(["s1", "s2"])], "ws-1", "s1");

  assert.equal(result.dissolvedWorkspaceId, "ws-1");
  assert.equal(result.lastRemainingSessionId, "s2");
  assert.deepEqual(result.workspaces, []);
  assert.deepEqual(
    replaceDissolvedWorkspaceTabOrder(
      ["log-1", result.dissolvedWorkspaceId!, "session-3"],
      result.dissolvedWorkspaceId,
      result.lastRemainingSessionId ? [result.lastRemainingSessionId] : undefined,
    ),
    ["log-1", "s2", "session-3"],
  );
});

test("closing one split pane keeps the other terminal as an orphan tab", () => {
  const layoutResult = closeSessionWorkspaceLayoutState(
    [workspace(["s1", "s2"])],
    "ws-1",
    "s1",
  );
  const nextSessions = applyCloseSessionToSessions(
    [session("s1"), session("s2")],
    "s1",
    layoutResult,
  );

  assert.deepEqual(nextSessions.map((s) => [s.id, s.workspaceId]), [
    ["s2", undefined],
  ]);
  assert.equal(
    resolveActiveTabAfterCloseSession({
      currentActiveTabId: "ws-1",
      closedSessionId: "s1",
      workspaceId: "ws-1",
      layoutResult,
      remainingSessions: nextSessions,
    }),
    "s2",
  );
});

test("closing the last workspace session does not invent a surviving terminal", () => {
  const layoutResult = closeSessionWorkspaceLayoutState(
    [workspace(["s1"])],
    "ws-1",
    "s1",
  );
  const nextSessions = applyCloseSessionToSessions(
    [session("s1")],
    "s1",
    layoutResult,
  );

  assert.deepEqual(nextSessions, []);
  assert.equal(layoutResult.removedWorkspaceId, "ws-1");
  assert.equal(layoutResult.lastRemainingSessionId, undefined);
  assert.equal(
    resolveActiveTabAfterCloseSession({
      currentActiveTabId: "ws-1",
      closedSessionId: "s1",
      workspaceId: "ws-1",
      layoutResult,
      remainingSessions: nextSessions,
    }),
    "vault",
  );
});
