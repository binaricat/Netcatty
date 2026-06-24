import test from "node:test";
import assert from "node:assert/strict";

import type { TmuxManageAction } from "../../domain/systemManager/types.ts";
import { runConfirmedTmuxDetachAction } from "./TmuxSessionCard.tsx";
import { runTmuxSessionAction, scheduleDeferredTerminalFocus } from "./tmuxActionFocus.ts";

test("tmux detach action requests terminal focus after a successful action", async () => {
  const calls: string[] = [];
  const action: TmuxManageAction = { action: "detachSession", sessionName: "work" };
  const timeouts: Array<{ delay: number; callback: () => void }> = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    timeouts.push({ delay: delay ?? 0, callback });
    return timeouts.length;
  }) as typeof globalThis.setTimeout;

  try {
    const result = await runTmuxSessionAction({
      sessionId: "session-1",
      action,
      tmuxAction: async (payload) => {
        assert.deepEqual(payload, { sessionId: "session-1", ...action });
        calls.push("tmuxAction");
        return { success: true };
      },
      onSessionsChanged: async () => {
        calls.push("sessionsChanged");
      },
      onRequestTerminalFocus: () => {
        calls.push("focus");
      },
    });

    assert.deepEqual(result, { success: true });
    assert.deepEqual(calls, ["tmuxAction", "sessionsChanged"]);
    assert.deepEqual(timeouts.map(({ delay }) => delay), [0, 50, 150]);
    for (const { callback } of timeouts) callback();
    assert.deepEqual(calls, ["tmuxAction", "sessionsChanged", "focus", "focus", "focus"]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  }
});

test("scheduleDeferredTerminalFocus runs the callback on deferred timers", () => {
  const calls: string[] = [];
  const timeouts: Array<{ delay: number; callback: () => void }> = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    timeouts.push({ delay: delay ?? 0, callback });
    return timeouts.length;
  }) as typeof globalThis.setTimeout;

  try {
    scheduleDeferredTerminalFocus(() => calls.push("focus"));
    assert.deepEqual(timeouts.map(({ delay }) => delay), [0, 50, 150]);
    for (const { callback } of timeouts) callback();
    assert.deepEqual(calls, ["focus", "focus", "focus"]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  }
});

test("tmux detach confirmation runs the action path that requests terminal focus", async () => {
  const calls: string[] = [];
  const timeouts: Array<{ delay: number; callback: () => void }> = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    timeouts.push({ delay: delay ?? 0, callback });
    return timeouts.length;
  }) as typeof globalThis.setTimeout;

  try {
    const handled = await runConfirmedTmuxDetachAction({
      sessionName: "work",
      confirmMessage: "detach work?",
      confirm: (message) => {
        calls.push(`confirm:${message}`);
        return true;
      },
      runAction: (action) => runTmuxSessionAction({
        sessionId: "session-1",
        action,
        tmuxAction: async () => {
          calls.push("tmuxAction");
          return { success: true };
        },
        onSessionsChanged: async () => {
          calls.push("sessionsChanged");
        },
        onRequestTerminalFocus: () => {
          calls.push("focus");
        },
      }).then(() => undefined),
    });

    assert.equal(handled, true);
    assert.deepEqual(calls, ["confirm:detach work?", "tmuxAction", "sessionsChanged"]);
    for (const { callback } of timeouts) callback();
    assert.deepEqual(calls, ["confirm:detach work?", "tmuxAction", "sessionsChanged", "focus", "focus", "focus"]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  }
});

test("tmux detach action does not request terminal focus when the action fails", async () => {
  const calls: string[] = [];

  const result = await runTmuxSessionAction({
    sessionId: "session-1",
    action: { action: "detachSession", sessionName: "work" },
    tmuxAction: async () => ({ success: false, error: "failed" }),
    onSessionsChanged: async () => {
      calls.push("sessionsChanged");
    },
    onRequestTerminalFocus: () => {
      calls.push("focus");
    },
  });

  assert.deepEqual(result, { success: false, error: "failed" });
  assert.deepEqual(calls, []);
});

test("tmux non-detach actions do not request terminal focus after success", async () => {
  const calls: string[] = [];

  await runTmuxSessionAction({
    sessionId: "session-1",
    action: { action: "renameSession", sessionName: "work", newName: "renamed" },
    tmuxAction: async () => ({ success: true }),
    onSessionsChanged: async () => {
      calls.push("sessionsChanged");
    },
    onRequestTerminalFocus: () => {
      calls.push("focus");
    },
  });

  assert.deepEqual(calls, ["sessionsChanged"]);
});
