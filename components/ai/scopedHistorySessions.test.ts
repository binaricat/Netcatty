import assert from "node:assert/strict";
import test from "node:test";

import type { AISession } from "../../infrastructure/ai/types.ts";
import { getScopedHistorySessions } from "./scopedHistorySessions.ts";

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
