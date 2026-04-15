import test from "node:test";
import assert from "node:assert/strict";

import {
  activateDraftView,
  bumpDraftMutationVersionState,
  bumpDraftUploadGenerationState,
  clearScopeDraftState,
  createEmptyDraft,
  ensureDraftForScopeState,
  getDraftMutationVersionState,
  getDraftUploadGenerationState,
  pruneTerminalScopeState,
  pruneTerminalTransientState,
  resolvePanelView,
  setDraftView,
  setSessionView,
  updateDraftForScope,
} from "./aiDraftState.ts";

test("createEmptyDraft seeds selected agent and empty inputs", () => {
  const draft = createEmptyDraft("agent-alpha");

  assert.equal(draft.agentId, "agent-alpha");
  assert.equal(draft.text, "");
  assert.deepEqual(draft.attachments, []);
  assert.deepEqual(draft.selectedUserSkillSlugs, []);
  assert.equal(typeof draft.updatedAt, "number");
});

test("resolvePanelView defaults to draft when no explicit view exists", () => {
  assert.deepEqual(resolvePanelView({}, "terminal:123"), { mode: "draft" });
});

test("setDraftView records draft mode", () => {
  assert.deepEqual(setDraftView({}, "terminal:123"), {
    "terminal:123": { mode: "draft" },
  });
});

test("activateDraftView clears the terminal scope's active session owner", () => {
  const activeSessionIdMap = {
    "terminal:123": "session-123",
    "workspace:abc": "session-workspace",
  };
  const panelViewByScope = {
    "terminal:123": { mode: "session", sessionId: "session-123" },
    "workspace:abc": { mode: "session", sessionId: "session-workspace" },
  } satisfies Record<string, { mode: "draft" } | { mode: "session"; sessionId: string }>;

  const next = activateDraftView(
    activeSessionIdMap,
    panelViewByScope,
    "terminal:123",
  );

  assert.deepEqual(next.activeSessionIdMap, {
    "workspace:abc": "session-workspace",
  });
  assert.deepEqual(next.panelViewByScope, {
    "terminal:123": { mode: "draft" },
    "workspace:abc": panelViewByScope["workspace:abc"],
  });
});

test("activateDraftView is a no-op when the scope already has explicit draft view", () => {
  const activeSessionIdMap = {
    "workspace:abc": "session-workspace",
  };
  const panelViewByScope = {
    "terminal:123": { mode: "draft" },
    "workspace:abc": { mode: "session", sessionId: "session-workspace" },
  } satisfies Record<string, { mode: "draft" } | { mode: "session"; sessionId: string }>;

  const next = activateDraftView(
    activeSessionIdMap,
    panelViewByScope,
    "terminal:123",
  );

  assert.equal(next.activeSessionIdMap, activeSessionIdMap);
  assert.equal(next.panelViewByScope, panelViewByScope);
});

test("setSessionView records target session id", () => {
  assert.deepEqual(setSessionView({}, "workspace:abc", "session-123"), {
    "workspace:abc": { mode: "session", sessionId: "session-123" },
  });
});

test("clearScopeDraftState removes both the draft and current panel view", () => {
  const draftsByScope = {
    "terminal:1": createEmptyDraft("agent-alpha"),
    "workspace:2": createEmptyDraft("agent-beta"),
  };
  const panelViewByScope = {
    "terminal:1": { mode: "session", sessionId: "session-123" },
    "workspace:2": { mode: "draft" },
  } satisfies Record<string, { mode: "draft" } | { mode: "session"; sessionId: string }>;

  const next = clearScopeDraftState(draftsByScope, panelViewByScope, "terminal:1");

  assert.deepEqual(next.draftsByScope, {
    "workspace:2": draftsByScope["workspace:2"],
  });
  assert.deepEqual(next.panelViewByScope, {
    "workspace:2": panelViewByScope["workspace:2"],
  });
});

test("clearScopeDraftState is a no-op when the scope is already cleared", () => {
  const draftsByScope = {
    "workspace:2": createEmptyDraft("agent-beta"),
  };
  const panelViewByScope = {
    "workspace:2": { mode: "draft" },
  } satisfies Record<string, { mode: "draft" } | { mode: "session"; sessionId: string }>;

  const next = clearScopeDraftState(draftsByScope, panelViewByScope, "terminal:closed");

  assert.equal(next.draftsByScope, draftsByScope);
  assert.equal(next.panelViewByScope, panelViewByScope);
});

test("updateDraftForScope creates a draft on first write and keeps other scopes untouched", () => {
  const draftsByScope = {
    "workspace:2": createEmptyDraft("agent-beta"),
  };

  const next = updateDraftForScope(
    draftsByScope,
    "terminal:1",
    "agent-alpha",
    (draft) => ({
      ...draft,
      text: "hello world",
    }),
  );

  assert.equal(next["terminal:1"].agentId, "agent-alpha");
  assert.equal(next["terminal:1"].text, "hello world");
  assert.equal(next["workspace:2"], draftsByScope["workspace:2"]);
});

test("ensureDraftForScopeState adds the missing scope without dropping siblings", () => {
  const draftsByScope = {
    "workspace:2": createEmptyDraft("agent-beta"),
  };

  const next = ensureDraftForScopeState(
    draftsByScope,
    "terminal:1",
    "agent-alpha",
  );

  assert.equal(next["terminal:1"].agentId, "agent-alpha");
  assert.equal(next["terminal:1"].text, "");
  assert.equal(next["workspace:2"], draftsByScope["workspace:2"]);
});

test("ensureDraftForScopeState returns the original ref when the scope already exists", () => {
  const draftsByScope = {
    "terminal:1": createEmptyDraft("agent-alpha"),
  };

  const next = ensureDraftForScopeState(
    draftsByScope,
    "terminal:1",
    "agent-beta",
  );

  assert.equal(next, draftsByScope);
});

test("draft mutation version increments on every mutation for the same scope", () => {
  const scopeKey = "terminal:1";
  const initialVersion = getDraftMutationVersionState({}, scopeKey);
  const nextVersions = bumpDraftMutationVersionState({}, scopeKey);
  const finalVersions = bumpDraftMutationVersionState(nextVersions, scopeKey);

  assert.equal(initialVersion, 0);
  assert.equal(getDraftMutationVersionState(nextVersions, scopeKey), 1);
  assert.equal(getDraftMutationVersionState(finalVersions, scopeKey), 2);
});

test("draft upload generation only increments when the draft lifecycle rolls over", () => {
  const scopeKey = "terminal:1";
  const initialGeneration = getDraftUploadGenerationState({}, scopeKey);
  const nextGenerations = bumpDraftUploadGenerationState({}, scopeKey);
  const finalGenerations = bumpDraftUploadGenerationState(nextGenerations, scopeKey);

  assert.equal(initialGeneration, 0);
  assert.equal(getDraftUploadGenerationState(nextGenerations, scopeKey), 1);
  assert.equal(getDraftUploadGenerationState(finalGenerations, scopeKey), 2);
});

test("pruneTerminalScopeState removes closed terminal drafts and views only", () => {
  const draftsByScope = {
    "terminal:closed": createEmptyDraft("agent-alpha"),
    "terminal:open": createEmptyDraft("agent-beta"),
    "workspace:keep": createEmptyDraft("agent-gamma"),
  };
  const panelViewByScope = {
    "terminal:closed": { mode: "draft" },
    "terminal:open": { mode: "session", sessionId: "session-open" },
    "workspace:keep": { mode: "session", sessionId: "session-workspace" },
  } satisfies Record<string, { mode: "draft" } | { mode: "session"; sessionId: string }>;

  const next = pruneTerminalScopeState(
    draftsByScope,
    panelViewByScope,
    new Set(["open"]),
  );

  assert.deepEqual(next.draftsByScope, {
    "terminal:open": draftsByScope["terminal:open"],
    "workspace:keep": draftsByScope["workspace:keep"],
  });
  assert.deepEqual(next.panelViewByScope, {
    "terminal:open": panelViewByScope["terminal:open"],
    "workspace:keep": panelViewByScope["workspace:keep"],
  });
});

test("pruneTerminalScopeState returns original refs when nothing is pruned", () => {
  const draftsByScope = {
    "terminal:open": createEmptyDraft("agent-alpha"),
    "workspace:keep": createEmptyDraft("agent-beta"),
  };
  const panelViewByScope = {
    "terminal:open": { mode: "draft" },
    "workspace:keep": { mode: "session", sessionId: "session-1" },
  } satisfies Record<string, { mode: "draft" } | { mode: "session"; sessionId: string }>;

  const next = pruneTerminalScopeState(
    draftsByScope,
    panelViewByScope,
    new Set(["open"]),
  );

  assert.equal(next.draftsByScope, draftsByScope);
  assert.equal(next.panelViewByScope, panelViewByScope);
});

test("pruneTerminalTransientState clears closed terminal active session, draft, and view state only", () => {
  const activeSessionIdMap = {
    "terminal:closed": "session-closed",
    "terminal:open": "session-open",
    "workspace:keep": "session-workspace",
  };
  const draftsByScope = {
    "terminal:closed": createEmptyDraft("agent-alpha"),
    "terminal:open": createEmptyDraft("agent-beta"),
    "workspace:keep": createEmptyDraft("agent-gamma"),
  };
  const panelViewByScope = {
    "terminal:closed": { mode: "draft" },
    "terminal:open": { mode: "session", sessionId: "session-open" },
    "workspace:keep": { mode: "session", sessionId: "session-workspace" },
  } satisfies Record<string, { mode: "draft" } | { mode: "session"; sessionId: string }>;

  const next = pruneTerminalTransientState(
    activeSessionIdMap,
    draftsByScope,
    panelViewByScope,
    new Set(["open"]),
  );

  assert.deepEqual(next.activeSessionIdMap, {
    "terminal:open": "session-open",
    "workspace:keep": "session-workspace",
  });
  assert.deepEqual(next.draftsByScope, {
    "terminal:open": draftsByScope["terminal:open"],
    "workspace:keep": draftsByScope["workspace:keep"],
  });
  assert.deepEqual(next.panelViewByScope, {
    "terminal:open": panelViewByScope["terminal:open"],
    "workspace:keep": panelViewByScope["workspace:keep"],
  });
});

test("pruneTerminalTransientState returns original refs when no terminal scopes close", () => {
  const activeSessionIdMap = {
    "terminal:open": "session-open",
    "workspace:keep": "session-workspace",
  };
  const draftsByScope = {
    "terminal:open": createEmptyDraft("agent-alpha"),
    "workspace:keep": createEmptyDraft("agent-beta"),
  };
  const panelViewByScope = {
    "terminal:open": { mode: "draft" },
    "workspace:keep": { mode: "session", sessionId: "session-workspace" },
  } satisfies Record<string, { mode: "draft" } | { mode: "session"; sessionId: string }>;

  const next = pruneTerminalTransientState(
    activeSessionIdMap,
    draftsByScope,
    panelViewByScope,
    new Set(["open"]),
  );

  assert.equal(next.activeSessionIdMap, activeSessionIdMap);
  assert.equal(next.draftsByScope, draftsByScope);
  assert.equal(next.panelViewByScope, panelViewByScope);
});
