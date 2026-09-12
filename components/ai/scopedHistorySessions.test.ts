import assert from "node:assert/strict";
import test from "node:test";

import type { AISession } from "../../infrastructure/ai/types.ts";
import {
  _getScopedHistoryCacheSizeForTests,
  getScopedHistorySessions,
} from "./scopedHistorySessions.ts";

function createSession(
  id: string,
  scope: AISession["scope"],
  updatedAt: number,
): AISession {
  return {
    id,
    title: id,
    agentId: "catty",
    scope,
    messages: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

test("workspace history remains visible after the original workspace target is gone", () => {
  const staleWorkspaceSession = createSession(
    "workspace-stale",
    { type: "workspace", targetId: "workspace-before-restart" },
    2,
  );

  const sessions = [
    staleWorkspaceSession,
    createSession("terminal-session", { type: "terminal", targetId: "terminal-1" }, 3),
  ];

  assert.deepEqual(
    getScopedHistorySessions(
      sessions,
      "workspace",
      "workspace-after-restart",
      undefined,
      new Set(),
    ),
    [staleWorkspaceSession],
  );
});

test("workspace history includes member-terminal chats and ranks them above stale workspaces", () => {
  const memberTerminalSession = createSession(
    "terminal-a-chat",
    { type: "terminal", targetId: "terminal-a" },
    1,
  );
  const staleWorkspaceSession = createSession(
    "workspace-stale",
    { type: "workspace", targetId: "workspace-before-restart" },
    99,
  );

  assert.deepEqual(
    getScopedHistorySessions(
      [staleWorkspaceSession, memberTerminalSession],
      "workspace",
      "workspace-merged",
      ["host-a"],
      new Set(),
      new Set(["terminal-a", "terminal-b"]),
    ).map((session) => session.id),
    ["terminal-a-chat", "workspace-stale"],
  );
});

test("terminal history without host ids remains visible after the original terminal target is gone", () => {
  const staleLocalSession = createSession(
    "terminal-local-stale",
    { type: "terminal", targetId: "terminal-before-restart" },
    2,
  );

  assert.deepEqual(
    getScopedHistorySessions(
      [staleLocalSession],
      "terminal",
      "terminal-after-restart",
      undefined,
      new Set(),
    ),
    [staleLocalSession],
  );
});

test("scoped history orders exact, host-matched, then older same-scope sessions", () => {
  const staleSameScopeSession = createSession(
    "same-scope-stale",
    { type: "terminal", targetId: "terminal-closed" },
    100,
  );
  const hostMatchedSession = createSession(
    "host-match",
    { type: "terminal", targetId: "terminal-other", hostIds: ["host-a"] },
    2,
  );
  const exactSession = createSession(
    "exact",
    { type: "terminal", targetId: "terminal-current" },
    1,
  );

  assert.deepEqual(
    getScopedHistorySessions(
      [staleSameScopeSession, hostMatchedSession, exactSession],
      "terminal",
      "terminal-current",
      ["host-a"],
      new Set(),
    ).map((session) => session.id),
    ["exact", "host-match", "same-scope-stale"],
  );
});

test("same-scope fallback excludes sessions already displayed by another terminal", () => {
  const displayedElsewhere = createSession(
    "displayed-elsewhere",
    { type: "terminal", targetId: "terminal-before-restart" },
    2,
  );

  assert.deepEqual(
    getScopedHistorySessions(
      [displayedElsewhere],
      "terminal",
      "terminal-after-restart",
      undefined,
      new Set(["displayed-elsewhere"]),
    ),
    [],
  );
});

test("workspace cache ignores unrelated active terminal churn", () => {
  const sessions = [createSession("workspace", { type: "workspace", targetId: "workspace-1" }, 1)];
  const first = getScopedHistorySessions(
    sessions,
    "workspace",
    "workspace-1",
    undefined,
    new Set(["terminal-0"]),
  );
  for (let index = 1; index < 1_000; index += 1) {
    assert.equal(getScopedHistorySessions(
      sessions,
      "workspace",
      "workspace-1",
      undefined,
      new Set([`terminal-${index}`]),
    ), first);
  }
  assert.equal(_getScopedHistoryCacheSizeForTests(sessions), 1);
});

test("terminal scoped history cache has a hard LRU bound", () => {
  const sessions = [createSession("terminal", { type: "terminal", targetId: "terminal-current" }, 1)];
  for (let index = 0; index < 1_000; index += 1) {
    getScopedHistorySessions(
      sessions,
      "terminal",
      "terminal-current",
      undefined,
      new Set([`other-session-${index}`]),
    );
  }
  assert.ok(_getScopedHistoryCacheSizeForTests(sessions) <= 64);
});

test("workspace history retains chats resumed by members from older terminals", () => {
  const resumed = createSession("resumed", {
    type: "terminal", targetId: "closed-terminal", hostIds: ["host-a"],
  }, 1);
  const unrelated = createSession("unrelated", {
    type: "terminal", targetId: "another-closed-terminal", hostIds: ["host-a"],
  }, 2);
  const staleWorkspace = createSession("stale-workspace", {
    type: "workspace", targetId: "old-workspace",
  }, 99);
  const sessions = [staleWorkspace, unrelated, resumed];
  const members = new Set(["terminal-a", "terminal-b"]);
  const selected = {
    "terminal:terminal-a": "resumed",
    "terminal:terminal-outside": "unrelated",
  };

  assert.ok(getScopedHistorySessions(
    sessions, "terminal", "terminal-a", ["host-a"], new Set(["unrelated"]),
  ).includes(resumed));
  assert.deepEqual(getScopedHistorySessions(
    sessions, "workspace", "merged", ["host-a"], new Set(Object.values(selected)),
    members, selected,
  ), [resumed, staleWorkspace]);
  // Returning to A makes the same stored conversation available again.
  assert.ok(getScopedHistorySessions(
    sessions, "terminal", "terminal-a", ["host-a"], new Set(["unrelated"]),
  ).includes(resumed));
  assert.equal(resumed.scope.targetId, "closed-terminal");
});

test("workspace history cache tracks member selections but ignores unrelated selections", () => {
  const sessions = [createSession("resumed", { type: "terminal", targetId: "closed" }, 1)];
  const members = new Set(["terminal-a"]);
  const history = (selected: Record<string, string | null>) => getScopedHistorySessions(
    sessions, "workspace", "merged", undefined, new Set(), members, selected,
  );
  const empty = history({});
  assert.deepEqual(empty, []);
  const inherited = history({ "terminal:terminal-a": "resumed" });
  assert.deepEqual(inherited, sessions);
  assert.equal(history({
    "terminal:terminal-a": "resumed", "terminal:outside": "other",
  }), inherited);
  assert.equal(history({ "terminal:terminal-a": null }), empty);
  assert.equal(history({ "workspace:unrelated": "resumed" }), empty);
  assert.equal(_getScopedHistoryCacheSizeForTests(sessions), 2);
});
