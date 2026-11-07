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
  panelViewsEqual,
  resolveDisplayedPanelView,
  resolveDisplayedSession,
  shouldForceDraftViewSync,
} from "./aiPanelViewState.ts";

function createSession(id: string, updatedAt = 1): AISession {
  return {
    id,
    title: `Session ${id}`,
    messages: [],
    createdAt: 1,
    updatedAt,
    agentId: "catty",
    scope: {
      type: "terminal",
      targetId: "terminal-1",
    },
  };
}

test("panelViewsEqual treats draft views as equal even when refs differ", () => {
  assert.equal(
    panelViewsEqual({ mode: "draft" }, { mode: "draft" }),
    true,
  );
});

test("panelViewsEqual distinguishes session targets", () => {
  assert.equal(
    panelViewsEqual(
      { mode: "session", sessionId: "session-1" },
      { mode: "session", sessionId: "session-2" },
    ),
    false,
  );
});

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

test("shouldForceDraftViewSync keeps explicit session while it is still in scoped history", () => {
  const explicit: AIPanelView = { mode: "session", sessionId: "just-created" };
  const normalized: AIPanelView = { mode: "draft" };
  // Predicate mirrors scoped historySessions (not the global store).
  const scopedHistory = new Set(["just-created"]);

  assert.equal(
    shouldForceDraftViewSync(explicit, normalized, (id) => scopedHistory.has(id)),
    false,
  );
});

test("shouldForceDraftViewSync forces draft when explicit session is gone", () => {
  const explicit: AIPanelView = { mode: "session", sessionId: "deleted" };
  const normalized: AIPanelView = { mode: "draft" };

  assert.equal(
    shouldForceDraftViewSync(explicit, normalized, () => false),
    true,
  );
});

test("shouldForceDraftViewSync demotes when session is only in global store, not scoped history", () => {
  const explicit: AIPanelView = { mode: "session", sessionId: "other-scope" };
  const normalized: AIPanelView = { mode: "draft" };
  // Global store still has it; scoped history (what normalize uses) does not.
  const globalStore = new Set(["other-scope"]);
  const scopedHistory = new Set<string>();

  assert.equal(
    shouldForceDraftViewSync(explicit, normalized, (id) => scopedHistory.has(id)),
    true,
  );
  assert.equal(
    shouldForceDraftViewSync(explicit, normalized, (id) => globalStore.has(id)),
    false,
  );
});

test("shouldForceDraftViewSync is a no-op when views already match", () => {
  const view: AIPanelView = { mode: "session", sessionId: "session-1" };

  assert.equal(
    shouldForceDraftViewSync(view, view, () => true),
    false,
  );
});

test("missing explicit panel view resumes the most recent matching history when no draft exists", () => {
  const sessions = [createSession("session-2"), createSession("session-1")];

  assert.deepEqual(
    resolveDisplayedPanelView(undefined, false, sessions, undefined, "workspace"),
    { mode: "session", sessionId: "session-2" },
  );
});

test("auto-resume prefers the anchored chat over recency and position (#4098 phase 2)", () => {
  const sessions = [createSession("session-2", 9), createSession("session-1", 4)];

  assert.deepEqual(
    resolveDisplayedPanelView(undefined, false, sessions, undefined, "workspace", "session-1"),
    { mode: "session", sessionId: "session-1" },
  );
});

test("auto-resume without an anchor picks the most recently updated chat, not sessions[0]", () => {
  const sessions = [createSession("session-2", 4), createSession("session-1", 9)];

  assert.deepEqual(
    resolveDisplayedPanelView(undefined, false, sessions, undefined, "workspace"),
    { mode: "session", sessionId: "session-1" },
  );
});

test("a stale anchor that left the scope falls through to recency", () => {
  const sessions = [createSession("session-2", 4), createSession("session-1", 9)];

  assert.deepEqual(
    resolveDisplayedPanelView(undefined, false, sessions, undefined, "workspace", "deleted-chat"),
    { mode: "session", sessionId: "session-1" },
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

test("missing explicit panel view prefers the draft when unsent input exists without an active chat", () => {
  const sessions = [createSession("session-2"), createSession("session-1")];

  assert.deepEqual(
    resolveDisplayedPanelView(undefined, true, sessions, null, "workspace"),
    { mode: "draft" },
  );
});

test("workspace unsent draft keeps the persisted active chat after merge seed", () => {
  // Merge often seeds activeSessionIdMap without writing panelView. Typing a
  // follow-up must not demote to draft or send will createSession().
  const sessions = [createSession("session-2"), createSession("session-1")];

  assert.deepEqual(
    resolveDisplayedPanelView(undefined, true, sessions, "session-1", "workspace"),
    { mode: "session", sessionId: "session-1" },
  );
});

test("explicit new-chat draft still wins over a stale persisted id", () => {
  const sessions = [createSession("session-2"), createSession("session-1")];

  assert.deepEqual(
    resolveDisplayedPanelView(
      { mode: "draft" },
      true,
      sessions,
      "session-1",
      "workspace",
    ),
    { mode: "draft" },
  );
});

test("draft state is used when there is no implicit history to resume", () => {
  assert.deepEqual(
    resolveDisplayedPanelView(undefined, true, [], null, "workspace"),
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
