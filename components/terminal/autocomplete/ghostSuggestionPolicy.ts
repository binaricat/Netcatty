export type GhostSuggestionDecision =
  | { type: "keep" }
  | { type: "show"; suggestion: string }
  | { type: "hide" };

/**
 * Prefer a stable ghost suggestion while the user's typed input still
 * falls within the currently shown prediction. This avoids a "jitter"
 * effect where freshly fetched suggestions keep replacing the same
 * visual prediction one character at a time.
 */
export function decideGhostSuggestion(
  activeSuggestion: string | null,
  input: string,
  nextSuggestion: string | null,
): GhostSuggestionDecision {
  if (activeSuggestion && activeSuggestion.startsWith(input)) {
    return { type: "keep" };
  }
  if (nextSuggestion && nextSuggestion.startsWith(input)) {
    return { type: "show", suggestion: nextSuggestion };
  }
  return { type: "hide" };
}
