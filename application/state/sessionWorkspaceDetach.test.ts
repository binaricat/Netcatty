import assert from "node:assert/strict";
import test from "node:test";
import type { TerminalSession, Workspace } from "../../domain/models";
import {
  applyCloseSessionToSessions,
  closeSessionsState,
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

test("closing the focused session hands focus to a remaining session (#3046)", () => {
  const result = closeSessionWorkspaceLayoutState(
    [workspace(["s1", "s2", "s3", "s4"])],
    "ws-1",
    "s1",
  );

  assert.equal(result.workspaces.length, 1);
  assert.equal(result.workspaces[0].focusedSessionId, "s2");
  assert.deepEqual(result.workspaces[0].focusSessionOrder, ["s2", "s3", "s4"]);
});

test("closing a non-focused session keeps the focused session", () => {
  const result = closeSessionWorkspaceLayoutState(
    [workspace(["s1", "s2", "s3", "s4"])],
    "ws-1",
    "s3",
  );

  assert.equal(result.workspaces.length, 1);
  assert.equal(result.workspaces[0].focusedSessionId, "s1");
  assert.deepEqual(result.workspaces[0].focusSessionOrder, ["s1", "s2", "s4"]);
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
      preferredTabId: "s-outside",
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

test("closing the last visible solo tab does not fall back to a hidden MCP session", () => {
  const visibleSession: TerminalSession = { ...session("s1", undefined) };
  const hiddenSession: TerminalSession = { ...session("s2", undefined), hiddenFromTabs: true };
  const layoutResult = closeSessionWorkspaceLayoutState([], undefined, "s1");
  const remainingSessions = [hiddenSession];

  assert.equal(
    resolveActiveTabAfterCloseSession({
      currentActiveTabId: visibleSession.id,
      closedSessionId: "s1",
      workspaceId: undefined,
      layoutResult,
      remainingSessions,
    }),
    "vault",
  );
});

test("closing a temporary solo tab restores the previously focused tab", () => {
  const standalone = (id: string, status: TerminalSession["status"] = "connected"): TerminalSession => ({
    ...session(id),
    workspaceId: undefined,
    status,
  });
  const remainingSessions = [
    standalone("s1", "disconnected"),
    standalone("s2"),
    standalone("s3"),
    standalone("s4"),
    standalone("s5", "disconnected"),
    standalone("s6"),
  ];
  const layoutResult = closeSessionWorkspaceLayoutState([], undefined, "s7");

  assert.equal(
    resolveActiveTabAfterCloseSession({
      currentActiveTabId: "s7",
      closedSessionId: "s7",
      workspaceId: undefined,
      layoutResult,
      remainingSessions,
      preferredTabId: "s5",
    }),
    "s5",
  );
});

test("closing a temporary solo tab ignores a preferred tab that no longer exists", () => {
  const standalone = (id: string): TerminalSession => ({
    ...session(id),
    workspaceId: undefined,
  });
  const remainingSessions = [standalone("s1"), standalone("s2"), standalone("s6")];
  const layoutResult = closeSessionWorkspaceLayoutState([], undefined, "s7");

  assert.equal(
    resolveActiveTabAfterCloseSession({
      currentActiveTabId: "s7",
      closedSessionId: "s7",
      workspaceId: undefined,
      layoutResult,
      remainingSessions,
      preferredTabId: "s5",
    }),
    "s6",
  );
});

test("closeSessionsState restores the previous tab instead of the newest remaining tab", () => {
  const standaloneSession = (id: string): TerminalSession => ({
    ...session(id),
    workspaceId: undefined,
  });

  const result = closeSessionsState({
    sessions: [
      standaloneSession("s1"),
      standaloneSession("s2"),
      standaloneSession("s5"),
      standaloneSession("s6"),
      standaloneSession("s7"),
    ],
    workspaces: [],
    sessionIds: ["s7"],
    currentActiveTabId: "s7",
    preferredTabId: "s5",
    tabOrder: ["s1", "s2", "s5", "s6", "s7"],
  });

  assert.equal(result.activeTabId, "s5");
  assert.deepEqual(result.sessions.map((candidate) => candidate.id), ["s1", "s2", "s5", "s6"]);
});

test("closing several standalone sessions removes the whole batch", () => {
  const standaloneSession = (id: string): TerminalSession => ({
    ...session(id),
    workspaceId: undefined,
  });

  const result = closeSessionsState({
    sessions: [standaloneSession("s1"), standaloneSession("s2"), standaloneSession("s3")],
    workspaces: [],
    sessionIds: ["s1", "s2", "s3"],
    currentActiveTabId: "s1",
    tabOrder: ["s1", "s2", "s3"],
  });

  assert.deepEqual(result.sessions, []);
  assert.deepEqual(result.workspaces, []);
  assert.equal(result.activeTabId, "vault");
});

test("closing a subset of standalone sessions keeps tabs outside the batch", () => {
  const standaloneSession = (id: string): TerminalSession => ({
    ...session(id),
    workspaceId: undefined,
  });

  const result = closeSessionsState({
    sessions: [standaloneSession("s1"), standaloneSession("s2"), standaloneSession("s3")],
    workspaces: [],
    sessionIds: ["s2", "s3"],
    currentActiveTabId: "s1",
    tabOrder: ["s1", "s2", "s3"],
  });

  assert.deepEqual(result.sessions.map((candidate) => candidate.id), ["s1"]);
  assert.equal(result.activeTabId, undefined);
});
