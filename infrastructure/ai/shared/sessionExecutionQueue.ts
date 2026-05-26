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
 * `chainBySessionKey` exposes that behavior as a tiny utility: callers
 * pass a stable key (e.g. `${chatSessionId}:${terminalSessionId}`) and a
 * thunk; the thunk is appended to that key's promise chain, so it only
 * starts after every previously-queued thunk has settled.
 */

const queues = new Map<string, Promise<unknown>>();

/**
 * Run `task` after every previously-queued task with the same `key` has
 * settled. Returns the task's resolved value (or rejects if the task
 * throws). A failure in one task does not poison the queue head for
 * subsequent callers — the chain only waits on settlement, not success.
 *
 * Exported for tests.
 */
export function chainBySessionKey<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  // Wait for `prev` to settle (regardless of outcome), then run `task`.
  // Using two-argument `.then(onFulfilled, onRejected)` here makes the
  // chain treat fulfillment and rejection identically, so a thrown task
  // doesn't propagate down the queue.
  const ours = prev.then(task, task);
  // Store a non-rejecting version as the new tail so the next caller
  // chains cleanly even if `ours` ends up rejecting.
  const tail: Promise<unknown> = ours.catch(() => undefined);
  queues.set(key, tail);
  // Best-effort cleanup once we're the last in line — keeps the map from
  // growing without bound across many short-lived sessions. A later
  // caller that arrived between `queues.set` and the finally would have
  // already overwritten the tail; we only clear when we're still it.
  void tail.finally(() => {
    if (queues.get(key) === tail) {
      queues.delete(key);
    }
  });
  return ours;
}

/**
 * Test-only: drop all queued work for a key. The promise chain itself is
 * not cancelled (no API for that without instrumenting every task), but
 * future callers will start a fresh chain.
 */
export function resetSessionExecutionQueueForTests(): void {
  queues.clear();
}
