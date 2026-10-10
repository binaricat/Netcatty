/**
 * Snippet completion source. Surfaces custom snippets in terminal autocomplete
 * when the user is typing the command name. Matches against the snippet label
 * and the first line of its command (case-insensitive; prefix matches rank
 * above substring matches). Chinese labels also match via pinyin / initials
 * through the shared search matcher (#2813). Each suggestion carries the full
 * Snippet so the accept path can run it through the canonical executeSnippetCommand.
 */
import type { Snippet } from "../../../domain/models";
import { snippetAppliesToHost } from "../../../domain/snippetTargets";
import { matchesSearchQuery, matchesWordPrefixQuery } from "../../../lib/searchMatcher";
import type { CompletionSuggestion } from "./completionEngine";

const SNIPPET_BASE_SCORE = 2000; // Above history (1000+freq) per "snippet > history".
const SNIPPET_PREFIX_BONUS = 100;

function snippetAvailableForAutocomplete(
  snippet: Snippet,
  host: { hostId?: string; hostGroup?: string },
): boolean {
  if (snippet.targetsAllHosts) return true;
  const hasScopedTargets = Boolean(
    snippet.targets?.length || snippet.targetGroups !== undefined,
  );
  if (!hasScopedTargets) return true;
  if (!host.hostId) return false;
  return snippetAppliesToHost(snippet, { id: host.hostId, group: host.hostGroup });
}

export function getSnippetSuggestions(
  input: string,
  snippets: Snippet[],
  options: { hostId?: string; hostGroup?: string; prefixOnly?: boolean } = {},
): CompletionSuggestion[] {
  const needle = input.trim().toLowerCase();
  if (!needle || !Array.isArray(snippets)) return [];

  const out: CompletionSuggestion[] = [];
  for (const snippet of snippets) {
    if (!snippetAvailableForAutocomplete(snippet, options)) continue;
    const label = (snippet.label || "").toLowerCase();
    const firstLine = (snippet.command || "").split("\n")[0].trim().toLowerCase();

    const labelPrefix = label.startsWith(needle);
    // Literal prefix/substring first (cheap); fall back to shared smart matcher
    // so Chinese titles surface for pinyin / initials the same way host search does.
    // In prefixOnly mode (argument position), matches must start at a word
    // boundary to avoid flooding mid-argument popups; pinyin still applies.
    const matches = options.prefixOnly
      ? labelPrefix
        || firstLine.startsWith(needle)
        || matchesWordPrefixQuery(needle, snippet.label, firstLine)
      : labelPrefix
        || label.includes(needle)
        || firstLine.startsWith(needle)
        || matchesSearchQuery(needle, snippet.label, firstLine);
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
