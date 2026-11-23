import assert from "node:assert/strict";
import test from "node:test";
import type { TerminalSession, Workspace } from "../../domain/models";
import type { AIChatRecencyEntry } from "../../domain/aiSessionRecency";
import {
  applyCloseSessionToSessions,
  closeSessionsState,
  closeSessionWorkspaceLayoutState,
  detachSessionFromWorkspaceState,
  resolveActiveTabAfterCloseSession,
} from "./sessionWorkspaceDetach";

const session = (id: string, workspaceId = "ws-1"): TerminalSession => ({
  id,
  hostId: id,
  hostLabel: id,
  username: "user",
  hostname: id,
  status: "connected",
  workspaceId,
});

const chat = (id: string, targetId: string, updatedAt: number): AIChatRecencyEntry => ({
  id,
  scope: { type: "terminal", targetId },
  updatedAt,
});

const workspace = (sessionIds: string[], overrides: Partial<Workspace> = {}): Workspace => ({
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
  ...overrides,
});

const rootPaneSessionIds = (workspace: Workspace): string[] => (
  workspace.root.type === "pane"
    ? [workspace.root.sessionId]
    : workspace.root.children.map((child) => child.type === "pane" ? child.sessionId : "")
      .filter((id): id is string => Boolean(id))
);

test("detaching to one member keeps the workspace alive (#4098 phase 2)", () => {
  const result = detachSessionFromWorkspaceState({
    sessions: [session("s1"), session("s2")],
    workspaces: [workspace(["s1", "s2"])],
    sessionId: "s1",
  });

  assert.equal(result.changed, true);
  assert.equal(result.activeTabId, "s1");
  assert.deepEqual(result.sessions.map((s) => [s.id, s.workspaceId]), [
    ["s1", undefined],
    // The survivor keeps its workspace binding — no orphan promotion.
    ["s2", "ws-1"],
  ]);
  assert.equal(result.workspaces.length, 1);
  assert.equal(result.workspaces[0].id, "ws-1");
  assert.deepEqual(rootPaneSessionIds(result.workspaces[0]), ["s2"]);
});

test("detaching the last member keeps the workspace with an empty root (#4098 phase 2)", () => {
  const result = detachSessionFromWorkspaceState({
    sessions: [session("s1")],
    workspaces: [workspace(["s1"])],
    sessionId: "s1",
  });

  assert.equal(result.changed, true);
  assert.equal(result.workspaces.length, 1);
  assert.equal(result.workspaces[0].id, "ws-1");
  assert.equal(result.workspaces[0].root.type, "split");
  assert.deepEqual(
    result.workspaces[0].root.type === "split" ? result.workspaces[0].root.children : null,
    [],
  );
  assert.equal(result.workspaces[0].focusedSessionId, undefined);
});

test("closing one member keeps the workspace and its surviving member bound (#4098 phase 2)", () => {
  const result = closeSessionsState({
    sessions: [session("s1"), session("s2")],
    workspaces: [workspace(["s1", "s2"])],
    sessionIds: ["s1"],
    currentActiveTabId: "ws-1",
    tabOrder: ["ws-1"],
  });

  assert.equal(result.workspaces.length, 1);
  assert.equal(result.workspaces[0].id, "ws-1");
  assert.deepEqual(result.sessions.map((s) => [s.id, s.workspaceId]), [["s2", "ws-1"]]);
  // The workspace tab is still live, so the active tab does not move.
  assert.equal(result.activeTabId, undefined);
});

test("member loss hands focus to the most-recently-active survivor, not sessions[0]", () => {
  const result = closeSessionWorkspaceLayoutState(
    [workspace(["s1", "s2", "s3"])],
    "ws-1",
    "s1",
    [chat("chat-s2", "s2", 4), chat("chat-s3", "s3", 9)],
  );

  assert.equal(result.workspaces.length, 1);
  // remainingSessionIds[0] is s2, but s3's chat is the most recent.
  assert.equal(result.workspaces[0].focusedSessionId, "s3");
});

test("reordering focus order does not change the survivor retarget", () => {
  const result = closeSessionWorkspaceLayoutState(
    [workspace(["s1", "s2", "s3"], { focusSessionOrder: ["s3", "s2", "s1"] })],
    "ws-1",
    "s1",
    [chat("chat-s2", "s2", 4), chat("chat-s3", "s3", 9)],
  );

  assert.equal(result.workspaces[0].focusedSessionId, "s3");
});

test("closing a non-focused member keeps the focused member", () => {
  const result = closeSessionWorkspaceLayoutState(
    [workspace(["s1", "s2", "s3"])],
    "ws-1",
    "s3",
  );

  assert.equal(result.workspaces.length, 1);
  assert.equal(result.workspaces[0].focusedSessionId, "s1");
  assert.deepEqual(result.workspaces[0].focusSessionOrder, ["s1", "s2"]);
});

test("with no AI recency signal focus stays on a surviving terminal", () => {
  const result = closeSessionWorkspaceLayoutState(
    [workspace(["s1", "s2"])],
    "ws-1",
    "s1",
  );

  assert.equal(result.workspaces.length, 1);
  assert.equal(result.workspaces[0].focusedSessionId, "s2");
});

test("closing ALL members keeps the workspace alive with an empty root (#4098 phase 2)", () => {
  const result = closeSessionsState({
    sessions: [session("s1"), session("s2")],
    workspaces: [workspace(["s1", "s2"])],
    sessionIds: ["s1", "s2"],
    currentActiveTabId: "ws-1",
    tabOrder: ["ws-1"],
  });

  assert.deepEqual(result.sessions, []);
  assert.equal(result.workspaces.length, 1);
  assert.equal(result.workspaces[0].id, "ws-1");
  assert.equal(result.workspaces[0].root.type, "split");
  assert.deepEqual(
    result.workspaces[0].root.type === "split" ? result.workspaces[0].root.children : null,
    [],
  );
  // The workspace tab survives, so the active tab is left alone.
  assert.equal(result.activeTabId, undefined);
});

test("closing a solo workspace member still replaces the closed tab's activity via fallbacks", () => {
  const layoutResult = closeSessionWorkspaceLayoutState(
    [workspace(["s1"])],
    "ws-1",
    "s1",
  );
  const nextSessions = applyCloseSessionToSessions([session("s1")], "s1");

  assert.deepEqual(nextSessions, []);
  // The workspace tab survives, so an active workspace tab needs no fallback.
  assert.equal(
    resolveActiveTabAfterCloseSession({
      currentActiveTabId: "ws-1",
      closedSessionId: "s1",
      workspaceId: "ws-1",
      layoutResult,
      remainingSessions: nextSessions,
    }),
    null,
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
