/**
 * Per-session execution queue for tool calls that target the same terminal
 * session.
 *
 * Background — issue #1101 problem 3:
 *
 * Vercel AI SDK dispatches every tool_use block emitted in one assistant
 * turn through `Promise.all(toolCalls.map(execute))`, so an LLM that asks
 * for three commands "at once" sends three simultaneous `bridge.aiExec()`
 * calls at the underlying PTY. The main-process session mutex
 * (`mcpServerBridge.reserveSessionExecution`) only lets one through and
 * rejects the rest with `{ ok: false, error: "Session already has another
 * command in progress..." }`. The LLM then sees two synthetic errors plus
 * one real result for a turn it expected to be all-or-nothing — and the
 * Anthropic API has occasionally rejected the resulting trace with a
 * `tool_use ids were found without tool_result blocks` 400.
 *
 * The cleanest fix is to never let those calls race in the first place:
 * serialize at the renderer-side tool execute boundary so the bridge sees
 * one command per session at a time. The bridge mutex stays as
 * defense-in-depth for non-LLM IPC paths (terminal_start, MCP, etc.).
 *
 * The queue exposes both a high-level `chainBySessionKey(key, task)` for
 * simple "run this when it's our turn" callers, and a lower-level
 * `reserveSessionSlot(key)` for callers that need to do non-blocking work
 * (e.g. await an approval prompt) *while* their queue slot is held — so
 * the queue order matches the LLM's emission order independent of when
 * each call's approval lands.
 */

const queues = new Map<string, Promise<unknown>>();

/**
 * A reserved slot in a session's execution queue. The slot is added to
 * the queue tail synchronously when {@link reserveSessionSlot} is called,
 * so call order is fixed at reservation time — regardless of how long
 * each caller spends on pre-work (approval prompts, abort checks, etc.)
 * before they actually start.
 *
 * Lifecycle:
 *   1. `reserveSessionSlot(key)` — synchronously snaps a place in line.
 *   2. caller does whatever pre-work they want, in parallel with siblings.
 *   3. `await slot.ready` — blocks until the previous slot has released.
 *   4. caller does the serialized work.
 *   5. `slot.release()` — frees the next slot. Idempotent.
 *
 * The slot **must** be released exactly once (typically from a `finally`)
 * even if the caller decides to skip the serialized work — otherwise
 * subsequent slots queued behind it never start.
 */
export interface SessionExecutionSlot {
  /** Resolves when this slot is at the head of its queue. */
  readonly ready: Promise<void>;
  /** Releases this slot. Safe to call multiple times. */
  release(): void;
}

export function reserveSessionSlot(key: string): SessionExecutionSlot {
  const prev = queues.get(key) ?? Promise.resolve();

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  // The new tail of this key's queue: previous tail → our `done`.
  // Wrap in a non-rejecting chain so a thrown task never poisons later
  // callers waiting on this tail.
  const tail: Promise<unknown> = prev.then(() => done).catch(() => undefined);
  queues.set(key, tail);

  // Best-effort cleanup once we're the last in line — keeps the map
  // from growing without bound across many short-lived sessions. A
  // later caller that arrived between `queues.set` and this finally
  // will already have replaced the tail; we only clear when we're
  // still it.
  void tail.finally(() => {
    if (queues.get(key) === tail) {
      queues.delete(key);
    }
  });

  let released = false;
  return {
    ready: prev.then(
      () => undefined,
      () => undefined,
    ),
    release(): void {
      if (released) return;
      released = true;
      resolveDone();
    },
  };
}

/**
 * Run `task` after every previously-reserved slot with the same `key`
 * has released. Returns the task's resolved value (or rejects if the
 * task throws). A failure in one task does not poison the queue head
 * for subsequent callers — the chain only waits on settlement, not
 * success.
 *
 * For callers that need to interleave pre-work with the queue wait
 * (e.g. approval prompts that should run in parallel even though the
 * actual command must run serially), use {@link reserveSessionSlot}
 * directly.
 */
export async function chainBySessionKey<T>(key: string, task: () => Promise<T>): Promise<T> {
  const slot = reserveSessionSlot(key);
  try {
    await slot.ready;
    return await task();
  } finally {
    slot.release();
  }
}

/** Test-only: inspect the live queue. */
export function getSessionExecutionQueueSizeForTests(): number {
  return queues.size;
}

/** Test-only: drop all queued work. */
export function resetSessionExecutionQueueForTests(): void {
  queues.clear();
}
