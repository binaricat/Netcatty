import test from "node:test";
import assert from "node:assert/strict";

import type {
  AISession,
} from "../../infrastructure/ai/types.ts";
import { pruneInactiveScopedSessions } from "./aiScopeCleanup.ts";

function createSession(id: string, scope: AISession["scope"], externalSessionId?: string): AISession {
  return {
    id,
    title: id,
    agentId: "catty",
    scope,
    messages: [],
    externalSessionId,
    createdAt: 1,
    updatedAt: 1,
  };
}

test("pruneInactiveScopedSessions reports inactive targets without deleting persisted history", () => {
  const sessions = [
    createSession("terminal-restorable", {
      type: "terminal",
      targetId: "closed-restorable",
      hostIds: ["host-1"],
    }, "ext-1"),
    createSession("terminal-local", {
      type: "terminal",
      targetId: "closed-local",
      hostIds: ["local-shell"],
    }, "ext-2"),
    createSession("workspace-closed", {
      type: "workspace",
      targetId: "closed-workspace",
    }, "ext-3"),
    createSession("terminal-open", {
      type: "terminal",
      targetId: "open-terminal",
      hostIds: ["host-2"],
    }, "ext-4"),
  ];

  const next = pruneInactiveScopedSessions(
    sessions,
    new Set(["open-terminal"]),
  );

  assert.deepEqual(next.orphanedSessionIds, [
    "terminal-restorable",
    "terminal-local",
    "workspace-closed",
  ]);
  assert.equal(next.sessions, sessions);
});

test("pruneInactiveScopedSessions preserves inactive workspace and local terminal history after restart", () => {
  const sessions = [
    createSession("terminal-local", {
      type: "terminal",
      targetId: "closed-local",
      hostIds: ["local-shell"],
    }, "ext-local"),
    createSession("workspace-closed", {
      type: "workspace",
      targetId: "closed-workspace",
    }, "ext-workspace"),
  ];

  const next = pruneInactiveScopedSessions(
    sessions,
    new Set(),
  );

  assert.deepEqual(next.orphanedSessionIds, [
    "terminal-local",
    "workspace-closed",
  ]);
  assert.equal(next.sessions, sessions);
});

test("pruneInactiveScopedSessions preserves original sessions when orphaned restorable chats are already detached", () => {
  const sessions = [
    createSession("terminal-restorable", {
      type: "terminal",
      targetId: "closed-restorable",
      hostIds: ["host-1"],
    }),
    createSession("terminal-open", {
      type: "terminal",
      targetId: "open-terminal",
      hostIds: ["host-2"],
    }, "ext-4"),
  ];

  const next = pruneInactiveScopedSessions(
    sessions,
    new Set(["open-terminal"]),
  );

  assert.deepEqual(next.orphanedSessionIds, ["terminal-restorable"]);
  assert.equal(next.sessions, sessions);
});

test("pruneInactiveScopedSessions treats sessions displayed elsewhere as in-use, not orphaned", () => {
  // terminal-restorable's original scope (terminal-closed-A) is gone, but
  // the user resumed it into terminal-open-B from history. The session's
  // externalSessionId must be preserved and it must not appear in the
  // orphaned list, otherwise the active chat loses external agent continuity.
  const resumedElsewhere = createSession("terminal-restorable", {
    type: "terminal",
    targetId: "terminal-closed-A",
    hostIds: ["host-1"],
  }, "ext-resumed");

  const trulyOrphaned = createSession("terminal-stale", {
    type: "terminal",
    targetId: "terminal-closed-C",
    hostIds: ["host-2"],
  }, "ext-stale");

  const sessions = [resumedElsewhere, trulyOrphaned];

  const next = pruneInactiveScopedSessions(
    sessions,
    new Set(["terminal-open-B"]),
    new Set(["terminal-restorable"]),
  );

  // Only the one not being displayed anywhere should show up as orphaned.
  assert.deepEqual(next.orphanedSessionIds, ["terminal-stale"]);
  // The resumed session must retain its externalSessionId.
  const resumedNext = next.sessions.find((s) => s.id === "terminal-restorable");
  assert.equal(resumedNext?.externalSessionId, "ext-resumed");
});
