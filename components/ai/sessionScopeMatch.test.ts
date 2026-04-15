import assert from "node:assert/strict";
import test from "node:test";

import type { AISession } from "../../infrastructure/ai/types.ts";
import { getSessionScopeMatchRank } from "./sessionScopeMatch.ts";

function createSession(id: string, targetId: string, hostIds: string[]): AISession {
  return {
    id,
    title: id,
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    agentId: "catty",
    scope: {
      type: "terminal",
      targetId,
      hostIds,
    },
  };
}

test("host-matched terminal session is excluded when another active terminal already displays it", () => {
  const session = createSession("session-1", "terminal-other", ["host-a"]);

  assert.equal(
    getSessionScopeMatchRank(
      session,
      "terminal",
      "terminal-current",
      ["host-a"],
      new Set(["session-1"]),
    ),
    0,
  );
});

test("host-matched terminal session remains resumable when no terminal is displaying it", () => {
  const session = createSession("session-1", "terminal-closed", ["host-a"]);

  assert.equal(
    getSessionScopeMatchRank(
      session,
      "terminal",
      "terminal-current",
      ["host-a"],
      new Set(["session-other"]),
    ),
    1,
  );
});

test("ownership is tracked by session id, not scope.targetId", () => {
  // Session was created in terminal-A but a different terminal (B) is now
  // displaying it after the user resumed it from history. Opening a third
  // terminal (C) should not see this session as owned, because the new
  // ownership check is keyed on session id, not the stale targetId.
  const session = createSession("session-1", "terminal-A", ["host-a"]);

  assert.equal(
    getSessionScopeMatchRank(
      session,
      "terminal",
      "terminal-C",
      ["host-a"],
      // terminal-B is displaying session-1; pass session-1 as an
      // active-id so C sees it as in-use
      new Set(["session-1"]),
    ),
    0,
  );
});

test("session targeting the current scope is an exact match (rank 2)", () => {
  const session = createSession("session-1", "terminal-current", ["host-a"]);

  assert.equal(
    getSessionScopeMatchRank(
      session,
      "terminal",
      "terminal-current",
      ["host-a"],
      new Set(),
    ),
    2,
  );
});

test("scope type mismatch returns 0 regardless of target or hosts", () => {
  const session = createSession("session-1", "terminal-current", ["host-a"]);

  assert.equal(
    getSessionScopeMatchRank(
      session,
      "workspace",
      "terminal-current",
      ["host-a"],
    ),
    0,
  );
});
