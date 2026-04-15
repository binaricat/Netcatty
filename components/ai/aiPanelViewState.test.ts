import assert from "node:assert/strict";
import test from "node:test";

import type {
  AIPanelView,
  AISession,
} from "../../infrastructure/ai/types.ts";
import {
  applyDraftEntrySelection,
  applyHistorySessionSelection,
  normalizePanelView,
  resolveDisplayedPanelView,
  resolveDisplayedSession,
} from "./aiPanelViewState.ts";

function createSession(id: string): AISession {
  return {
    id,
    title: `Session ${id}`,
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    agentId: "catty",
    scope: {
      type: "terminal",
      targetId: "terminal-1",
    },
  };
}

test("draft view never falls back to most recent history", () => {
  const panelView: AIPanelView = { mode: "draft" };
  const sessions = [createSession("session-2"), createSession("session-1")];

  assert.equal(resolveDisplayedSession(panelView, sessions), null);
});

test("session view returns the selected session", () => {
  const selectedSession = createSession("session-2");
  const panelView: AIPanelView = { mode: "session", sessionId: selectedSession.id };
  const sessions = [createSession("session-1"), selectedSession];

  assert.equal(resolveDisplayedSession(panelView, sessions), selectedSession);
});

test("missing session target resolves to null instead of history fallback", () => {
  const panelView: AIPanelView = { mode: "session", sessionId: "missing-session" };
  const sessions = [createSession("session-2"), createSession("session-1")];

  assert.equal(resolveDisplayedSession(panelView, sessions), null);
});

test("missing session target normalizes back to draft view", () => {
  const panelView: AIPanelView = { mode: "session", sessionId: "missing-session" };
  const sessions = [createSession("session-2"), createSession("session-1")];

  assert.deepEqual(normalizePanelView(panelView, sessions), { mode: "draft" });
});

test("missing explicit panel view resumes the most recent matching history when no draft exists", () => {
  const sessions = [createSession("session-2"), createSession("session-1")];

  assert.deepEqual(
    resolveDisplayedPanelView(undefined, false, sessions, undefined, "workspace"),
    { mode: "session", sessionId: "session-2" },
  );
});

test("missing explicit panel view restores the persisted active session instead of the newest", () => {
  const sessions = [createSession("session-2"), createSession("session-1")];

  assert.deepEqual(
    resolveDisplayedPanelView(undefined, false, sessions, "session-1", "workspace"),
    { mode: "session", sessionId: "session-1" },
  );
});

test("persisted session id that no longer exists in history falls back to newest", () => {
  const sessions = [createSession("session-2"), createSession("session-1")];

  assert.deepEqual(
    resolveDisplayedPanelView(undefined, false, sessions, "deleted-session", "workspace"),
    { mode: "session", sessionId: "session-2" },
  );
});

test("null persisted session id falls back to newest history entry", () => {
  const sessions = [createSession("session-2"), createSession("session-1")];

  assert.deepEqual(
    resolveDisplayedPanelView(undefined, false, sessions, null, "workspace"),
    { mode: "session", sessionId: "session-2" },
  );
});

test("terminal scope without explicit view always starts from draft even when history exists", () => {
  const sessions = [createSession("session-2"), createSession("session-1")];

  assert.deepEqual(
    resolveDisplayedPanelView(undefined, false, sessions, "session-1", "terminal"),
    { mode: "draft" },
  );
});

test("missing explicit panel view prefers the draft when unsent input exists", () => {
  const sessions = [createSession("session-2"), createSession("session-1")];

  assert.deepEqual(
    resolveDisplayedPanelView(undefined, true, sessions),
    { mode: "draft" },
  );
});

test("draft state is used when there is no implicit history to resume", () => {
  assert.deepEqual(
    resolveDisplayedPanelView(undefined, true, []),
    { mode: "draft" },
  );
});

test("history selection switches to the chosen session without touching draft state", () => {
  const calls: string[] = [];

  applyHistorySessionSelection("session-2", {
    showSessionView: (sessionId) => {
      calls.push(`view:${sessionId}`);
    },
    setActiveSessionId: (sessionId) => {
      calls.push(`active:${sessionId}`);
    },
    closeHistory: () => {
      calls.push("close-history");
    },
  });

  assert.deepEqual(calls, [
    "view:session-2",
    "active:session-2",
    "close-history",
  ]);
});

test("draft entry ensures a draft exists before switching the panel to draft mode", () => {
  const calls: string[] = [];

  applyDraftEntrySelection({
    ensureDraft: () => {
      calls.push("ensure-draft");
    },
    showDraftView: () => {
      calls.push("show-draft");
    },
  });

  assert.deepEqual(calls, [
    "ensure-draft",
    "show-draft",
  ]);
});

test("draft entry can preserve the current session view while ensuring draft state", () => {
  const calls: string[] = [];

  applyDraftEntrySelection({
    ensureDraft: () => {
      calls.push("ensure-draft");
    },
    showDraftView: () => {
      calls.push("show-draft");
    },
    preserveSessionView: true,
  });

  assert.deepEqual(calls, [
    "ensure-draft",
  ]);
});
