/**
 * Helpers for detecting Vercel AI SDK internal stream-state errors.
 *
 * Background — issue #1101 follow-up:
 *
 * When a third-party Anthropic-compat backend (DeepSeek's
 * `deepseek-v4-flash` is the canonical offender) streams thinking
 * deltas without first emitting a `reasoning-start` content-block
 * signal, the Vercel AI SDK's reasoning state machine has nothing
 * registered for the incoming `part.id` and enqueues an
 * `error` chunk on `fullStream` with the text
 * `reasoning part <id> not found` — once per orphan delta. The
 * analogous error exists for text parts.
 *
 * These chunks are *internal SDK bookkeeping noise*, not user-facing
 * errors. Worse, treating them as real errors (adding a placeholder
 * assistant message for each) breaks tool_use/tool_result contiguity
 * on the next turn: the Anthropic message grouper splits the
 * tool-result `role: 'tool'` messages from their parent tool_use
 * `role: 'assistant'`, and the backend responds with
 * `400 messages.N: tool_use ids were found without tool_result blocks
 * immediately after`.
 *
 * Filtering these specific errors at the chunk-handler boundary
 * stops the cascade: the orphan deltas are dropped silently (the SDK
 * continues processing other chunks), no fake assistant messages
 * land in history, and the next turn's request stays well-formed.
 */

const STATE_ERROR_PATTERN = /^(?:reasoning|text)\s+part\s+\S+\s+not\s+found$/i;

/**
 * Return true if `error` is one of the SDK's internal stream-state
 * tracking errors (e.g. an out-of-order reasoning delta). Accepts
 * the loose `unknown` shape that comes off the chunk so callers
 * don't need to narrow upstream.
 */
export function isSdkStreamStateError(error: unknown): boolean {
  if (typeof error === 'string') {
    return STATE_ERROR_PATTERN.test(error.trim());
  }
  if (error instanceof Error) {
    return STATE_ERROR_PATTERN.test(error.message.trim());
  }
  if (error && typeof error === 'object' && 'message' in error) {
    const msg = (error as { message?: unknown }).message;
    if (typeof msg === 'string') return STATE_ERROR_PATTERN.test(msg.trim());
  }
  return false;
}
