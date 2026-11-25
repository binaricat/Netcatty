/**
 * User-configurable inline character limit for built-in AI (Catty) tool results.
 *
 * Outputs up to this limit are returned inline to the model; larger outputs
 * spill to `ToolOutputStore` behind a `tool_output_read` handle. Keeping the
 * setting bounded protects renderer memory, IPC serialization, and request
 * budgets from runaway outputs while letting users with large-context models
 * inspect complete command and file results without excessive pagination.
 */

export const DEFAULT_AI_TOOL_OUTPUT_MAX_CHARS = 24_000;
export const MIN_AI_TOOL_OUTPUT_MAX_CHARS = 2_000;
export const MAX_AI_TOOL_OUTPUT_MAX_CHARS = 200_000;

export function normalizeAiToolOutputMaxChars(value: unknown): number {
  if (typeof value === 'boolean' || value === null || value === undefined || value === '') {
    return DEFAULT_AI_TOOL_OUTPUT_MAX_CHARS;
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_AI_TOOL_OUTPUT_MAX_CHARS;
  return Math.min(
    MAX_AI_TOOL_OUTPUT_MAX_CHARS,
    Math.max(MIN_AI_TOOL_OUTPUT_MAX_CHARS, Math.round(numeric)),
  );
}

/**
 * Derive the inline stderr budget from the configured tool output limit.
 * Keeps parity with the legacy 12,000-char default when the limit is 24,000,
 * and scales proportionally up or down within `[MIN, limit]`.
 */
export function resolveTerminalStderrMaxChars(maxOutputChars: number): number {
  const normalized = normalizeAiToolOutputMaxChars(maxOutputChars);
  return Math.min(
    normalized,
    Math.max(MIN_AI_TOOL_OUTPUT_MAX_CHARS, Math.floor(normalized / 2)),
  );
}
