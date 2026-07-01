/**
 * Snippet completion source. Surfaces custom snippets in terminal autocomplete
 * when the user is typing the command name. Matches against the snippet label
 * and the first line of its command (case-insensitive; prefix matches rank
 * above substring matches). Each suggestion carries the full Snippet so the
 * accept path can run it through the canonical executeSnippetCommand.
 */
import type { Snippet } from "../../../domain/models";
import type { CompletionSuggestion } from "./completionEngine";

const SNIPPET_BASE_SCORE = 2000; // Above history (1000+freq) per "snippet > history".
const SNIPPET_PREFIX_BONUS = 100;

function snippetAvailableForAutocomplete(snippet: Snippet, hostId?: string): boolean {
  if (snippet.targetsAllHosts) return true;
  if (snippet.targets && snippet.targets.length > 0) {
    return hostId !== undefined && snippet.targets.includes(hostId);
  }
  return true;
}

export function getSnippetSuggestions(
  input: string,
  snippets: Snippet[],
  options: { hostId?: string } = {},
): CompletionSuggestion[] {
  const needle = input.trim().toLowerCase();
  if (!needle || !Array.isArray(snippets)) return [];

  const out: CompletionSuggestion[] = [];
  for (const snippet of snippets) {
    if (!snippetAvailableForAutocomplete(snippet, options.hostId)) continue;
    const label = (snippet.label || "").toLowerCase();
    const firstLine = (snippet.command || "").split("\n")[0].trim().toLowerCase();

    const labelPrefix = label.startsWith(needle);
    const matches = labelPrefix || label.includes(needle) || firstLine.startsWith(needle);
    if (!matches) continue;

    out.push({
      text: snippet.label,
      displayText: snippet.label,
      description: snippet.command,
      source: "snippet",
      score: SNIPPET_BASE_SCORE + (labelPrefix ? SNIPPET_PREFIX_BONUS : 0),
      snippet,
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}
