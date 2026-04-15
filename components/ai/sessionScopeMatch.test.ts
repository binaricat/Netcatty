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

test("host-matched terminal session is excluded when another active terminal already owns it", () => {
  const session = createSession("session-1", "terminal-other", ["host-a"]);

  assert.equal(
    getSessionScopeMatchRank(
      session,
      "terminal",
      "terminal-current",
      ["host-a"],
      new Set(["terminal-other"]),
    ),
    0,
  );
});

test("host-matched terminal session remains resumable when no active terminal owns it", () => {
  const session = createSession("session-1", "terminal-closed", ["host-a"]);

  assert.equal(
    getSessionScopeMatchRank(
      session,
      "terminal",
      "terminal-current",
      ["host-a"],
      new Set(["terminal-other"]),
    ),
    1,
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
