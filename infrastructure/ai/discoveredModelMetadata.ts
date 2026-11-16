import { sanitizeContextWindow } from './contextCompaction';

/**
 * Read a context window from one entry of a provider `/models` payload.
 *
 * Vendors disagree on where the window lives: OpenAI-compatible lists that
 * carry it at all usually flatten it (`context_length`, `context_window`, …),
 * while OpenCode Go nests it under `limit.context` alongside `limit.output`.
 * Keep both shapes working so discovery can show real limits for either.
 */
export function readDiscoveredModelContextWindow(
  model: Record<string, unknown>,
): number | undefined {
  const limit = model.limit && typeof model.limit === 'object'
    ? model.limit as Record<string, unknown>
    : undefined;
  return sanitizeContextWindow(
    model.context_length
      ?? model.context_window
      ?? model.contextWindow
      ?? model.context
      ?? model.max_context_tokens
      ?? limit?.context,
  );
}
