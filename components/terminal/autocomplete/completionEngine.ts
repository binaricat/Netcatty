/**
 * Context-aware completion engine.
 * Combines multiple data sources:
 * 1. Context-aware path completions and @withfig/autocomplete specs
 * 2. Command history
 * 3. Fuzzy history matching (fallback)
 *
 * Parses the current command line to determine context (command, subcommand,
 * option, or argument position) and provides appropriate suggestions.
 */

import {
  queryHistory,
  queryRecentHistoryByCommand,
  fuzzyQueryHistory,
  type HistoryQueryOptions,
} from "./commandHistoryStore";
import {
  loadSpec,
  hasSpec,
  getAvailableSpecs,
  normalizeCommandName,
  resolveNames,
  type FigSpec,
  type FigSubcommand,
  type FigOption,
} from "./figSpecLoader";
import {
  shouldDoPathCompletion,
  getPathSuggestions,
  resolvePathComponents,
} from "./remotePathCompleter";
import { getSnippetSuggestions } from "./snippetCompleter";
import type { AutocompleteHistoryScope, Snippet } from "../../../domain/models";
import type { AutocompleteCwdSource } from "./terminalAutocompleteLayout";

/** Source indicator for where a suggestion came from */
export type SuggestionSource = "history" | "command" | "subcommand" | "option" | "arg" | "path" | "snippet" | "plugin";

export interface CompletionSuggestion {
  /** The text to insert */
  text: string;
  /** Display text (may differ from insert text) */
  displayText: string;
  /** Optional description */
  description?: string;
  /** Source of this suggestion */
  source: SuggestionSource;
  /** Relevance score (higher = more relevant) */
  score: number;
  /** For history entries: execution frequency */
  frequency?: number;
  /** Matching rule used by recent history surfaced during path completion. */
  historyMatch?: "path-argument";
  /** For path suggestions: file type */
  fileType?: "file" | "directory" | "symlink";
  /** For snippet suggestions: the source snippet (used by the accept path). */
  snippet?: Snippet;
  /** For plugin suggestions: the owning Provider contribution. */
  providerId?: string;
}

export interface CompletionContext {
  /** Full command line text */
  commandLine: string;
  /** Current word being typed */
  currentWord: string;
  /** Index of the current word in the parsed tokens */
  wordIndex: number;
  /** Parsed command tokens */
  tokens: string[];
  /** The base command name (first token) */
  commandName: string;
  /** Whether the current position is after a recognized option that expects an argument */
  isOptionArg: boolean;
}

/**
 * Soft wait for remote/local path listings. History, fig specs, and snippets are
 * local and should paint without waiting on high-latency SSH exec (#2830).
 * Timed-out listings still finish in the background: cacheable paths warm the
 * shared cache, and cache-bypassed relative SSH paths notify via onLateResult
 * so the UI can merge path suggestions when the listing finally resolves.
 */
export const PATH_COMPLETION_BUDGET_MS = 150;

type PathSuggestionEntry = { name: string; type: "file" | "directory" | "symlink" };

/** @internal Exported for unit tests covering the soft path-listing budget. */
export async function getPathSuggestionsWithinBudget(
  pathPromise: Promise<PathSuggestionEntry[]>,
  budgetMs: number,
  onLateResult?: (entries: PathSuggestionEntry[]) => void,
): Promise<PathSuggestionEntry[]> {
  if (!Number.isFinite(budgetMs) || budgetMs < 0) {
    return pathPromise;
  }
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const raced = await Promise.race([
      // Settle rejections here so a late failure after timeout cannot surface
      // as an unhandled rejection from the losing Promise.race branch.
      pathPromise.then(
        (entries) => ({ kind: "entries" as const, entries }),
        () => ({ kind: "entries" as const, entries: [] as PathSuggestionEntry[] }),
      ),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timeoutId = setTimeout(() => resolve({ kind: "timeout" }), budgetMs);
      }),
    ]);
    if (raced.kind === "entries") return raced.entries;
    // Keep the listing in flight. Cacheable paths warm the shared cache for a
    // later keystroke; bypassed relative SSH paths have no cache, so surface
    // the late result to the caller instead of discarding it.
    void pathPromise.then(
      (entries) => {
        if (entries.length > 0) onLateResult?.(entries);
      },
      () => {},
    );
    return [];
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function buildPathCompletionSuggestions(
  ctx: CompletionContext,
  pathEntries: PathSuggestionEntry[],
  cwd: string | undefined,
): CompletionSuggestion[] {
  if (pathEntries.length === 0) return [];
  const { pathPrefix, quoteSuffix } = resolvePathComponents(ctx.currentWord, cwd);
  const isQuotedPath = ctx.currentWord.startsWith('"') || ctx.currentWord.startsWith("'");
  const suggestions: CompletionSuggestion[] = [];
  for (const entry of pathEntries) {
    const insertName = isQuotedPath || !/[\\$'"|!<>;#~` ]/.test(entry.name)
      ? entry.name
      : shellEscape(entry.name);
    const suffix = entry.type === "directory" ? "/" : "";
    const fullPath = pathPrefix + insertName + suffix + quoteSuffix;
    suggestions.push({
      text: rebuildCommand(ctx.tokens, ctx.wordIndex, fullPath),
      displayText: entry.name + suffix,
      source: "path",
      score: 750,
      fileType: entry.type,
    });
  }
  return suggestions;
}

interface SpecSuggestionResult {
  suggestions: CompletionSuggestion[];
  pathArgs?: FigSubcommand["args"];
}

export function shellEscape(name: string): string {
  if (!name) return name;
  if (/[\\$'"|!<>;#~` ]/.test(name)) {
    return `'${name.replace(/'/g, "'\\''")}'`;
  }
  return name;
}

/**
 * Parse a command line string into tokens, handling quoting.
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      current += ch;
      continue;
    }

    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      current += ch;
      continue;
    }

    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      current += ch;
      continue;
    }

    if (ch === " " && !inSingleQuote && !inDoubleQuote) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  // Always include the last token (even if empty, to indicate trailing space)
  tokens.push(current);

  return tokens;
}

/**
 * Parse the current command line into a CompletionContext.
 */
export function parseCommandLine(input: string): CompletionContext {
  const tokens = tokenize(input);
  const wordIndex = tokens.length - 1;
  const currentWord = tokens[wordIndex] || "";
  const commandName = tokens.length > 0 ? normalizeCommandName(tokens[0]) : "";

  return {
    commandLine: input,
    currentWord,
    wordIndex,
    tokens,
    commandName,
    isOptionArg: false,
  };
}

/**
 * Main completion function. Returns sorted suggestions from all sources.
 * Ghost text should use completions[0].text instead of a separate query.
 */
export async function getCompletions(
  input: string,
  options: {
    hostId?: string;
    hostGroup?: string;
    os?: "linux" | "windows" | "macos";
    maxResults?: number;
    /** Session ID for remote path completion */
    sessionId?: string;
    /** Connection protocol (ssh, local, telnet, serial) */
    protocol?: string;
    /** Current working directory (from OSC 7) */
    cwd?: string;
    cwdSource?: AutocompleteCwdSource;
    /** Custom snippets to surface at the command position */
    snippets?: Snippet[];
    /** Which history pool to query (default: current host only). */
    historyScope?: AutocompleteHistoryScope;
    /**
     * Soft budget for path listings (ms). Local suggestions return when this
     * elapses even if remote `find` is still running. Use `Infinity` in tests
     * that need the full remote listing.
     */
    pathBudgetMs?: number;
    /**
     * Invoked when a path listing finishes after the soft budget elapsed.
     * Needed for cache-bypassed relative SSH cwd lookups, which cannot warm
     * the shared directory cache for a later keystroke.
     */
    onLatePathSuggestions?: (suggestions: CompletionSuggestion[]) => void;
  } = {},
): Promise<CompletionSuggestion[]> {
  const { hostId, maxResults = 15, historyScope = "host" } = options;
  const pathBudgetMs = options.pathBudgetMs ?? PATH_COMPLETION_BUDGET_MS;

  if (!input || input.trim().length === 0) return [];

  const ctx = parseCommandLine(input);
  const specResult: SpecSuggestionResult = ctx.commandName && ctx.wordIndex >= 0
    ? await getSpecSuggestions(ctx)
    : { suggestions: [] };
  const suggestions: CompletionSuggestion[] = [];
  const seenSuggestionTexts = new Set<string>();
  const pathCheck = ctx.commandName && ctx.wordIndex >= 1
    ? shouldDoPathCompletion(ctx, specResult.pathArgs)
    : { shouldComplete: false, foldersOnly: false };
  const preferPathSuggestions = pathCheck.shouldComplete;
  const resultLimit = preferPathSuggestions ? Math.max(maxResults, 24) : maxResults;

  // History queries honor historyScope; snippets still stay host-scoped.
  const historyHostId = historyScope === "global" ? undefined : hostId;

  // 1. History suggestions (full command line prefix match)
  // Cap history to leave room for spec suggestions in the popup
  const historyOpts: HistoryQueryOptions = {
    hostId: historyHostId,
    limit: preferPathSuggestions ? 0 : 5,
  };

  const historyMatches = queryHistory(input, historyOpts);
  for (const entry of historyMatches) {
    const suggestion = {
      text: entry.command,
      displayText: entry.command,
      source: "history",
      score: 1000 + entry.frequency,
      frequency: entry.frequency,
    } satisfies CompletionSuggestion;
    suggestions.push(suggestion);
    seenSuggestionTexts.add(suggestion.text);
  }

  if (preferPathSuggestions && ctx.commandName) {
    // When path completion is active (file-related commands like cat, vim, cd),
    // recent history is still useful but should rank below actual path matches
    // from the current directory.
    const recentHistory = queryRecentHistoryByCommand({
      commandName: ctx.commandName,
      excludeCommand: input,
      argumentPrefix: normalizeHistoryPathPrefix(ctx.currentWord),
      hostId: historyHostId,
      limit: 5,
    });
    for (let index = 0; index < recentHistory.length; index++) {
      const entry = recentHistory[index];
      if (seenSuggestionTexts.has(entry.command)) continue;
      const suggestion = {
        text: entry.command,
        displayText: entry.command,
        source: "history",
        score: 720 - index,
        frequency: entry.frequency,
        historyMatch: "path-argument",
      } satisfies CompletionSuggestion;
      suggestions.push(suggestion);
      seenSuggestionTexts.add(suggestion.text);
    }
  }

  const canQueryPaths = options.protocol === "local" || options.sessionId !== undefined;

  const pathEntries = canQueryPaths && pathCheck.shouldComplete
    ? await getPathSuggestionsWithinBudget(
      getPathSuggestions(ctx, {
        sessionId: options.sessionId,
        protocol: options.protocol,
        os: options.os,
        cwd: options.cwd,
        cwdSource: options.cwdSource,
        foldersOnly: pathCheck.foldersOnly,
      }),
      pathBudgetMs,
      (lateEntries) => {
        if (!options.onLatePathSuggestions) return;
        const latePathSuggestions = buildPathCompletionSuggestions(
          ctx,
          lateEntries,
          options.cwd,
        );
        if (latePathSuggestions.length > 0) {
          options.onLatePathSuggestions(latePathSuggestions);
        }
      },
    )
    : [];

  for (const suggestion of specResult.suggestions) {
    suggestions.push(suggestion);
    seenSuggestionTexts.add(suggestion.text);
  }

  for (const suggestion of buildPathCompletionSuggestions(ctx, pathEntries, options.cwd)) {
    suggestions.push(suggestion);
    seenSuggestionTexts.add(suggestion.text);
  }

  // 3. Fuzzy history fallback while typing the command name. Once arguments
  // are present, history completion is prefix-only: fuzzy matching the whole
  // line can borrow characters from later paths and keep an incompatible
  // middle argument visible (issue #3088).
  if (
    ctx.wordIndex === 0 &&
    !preferPathSuggestions &&
    suggestions.length < 3 &&
    input.length >= 2
  ) {
    const fuzzyMatches = fuzzyQueryHistory(input, {
      ...historyOpts,
      limit: 5,
    });
    for (const entry of fuzzyMatches) {
      if (seenSuggestionTexts.has(entry.command)) continue;
      const suggestion = {
        text: entry.command,
        displayText: entry.command,
        source: "history",
        score: 500 + entry.frequency,
        frequency: entry.frequency,
      } satisfies CompletionSuggestion;
      suggestions.push(suggestion);
      seenSuggestionTexts.add(suggestion.text);
    }
  }

  // Snippets: only at the command position (typing the command name).
  // Push without the early seen-text skip: snippets score above history, so if
  // a snippet's label collides with an existing history entry's text, the
  // score-sort + final dedup below keeps the snippet (the higher-scored one).
  if (options.snippets && options.snippets.length > 0 && ctx.wordIndex === 0) {
    for (const snippetSuggestion of getSnippetSuggestions(input, options.snippets, {
      hostId,
      hostGroup: options.hostGroup,
    })) {
      suggestions.push(snippetSuggestion);
    }
  }

  // Sort by score descending
  suggestions.sort((a, b) => b.score - a.score);

  // Deduplicate
  const seen = new Set<string>();
  const unique: CompletionSuggestion[] = [];
  for (const s of suggestions) {
    if (seen.has(s.text)) continue;
    seen.add(s.text);
    unique.push(s);
    if (unique.length >= resultLimit) break;
  }

  return unique;
}

function normalizeHistoryPathPrefix(token: string): string {
  return token
    .trim()
    .replace(/^['"]/, "")
    .replace(/['"]$/, "")
    .replace(/\\ /g, " ");
}

/**
 * Get suggestions from Fig spec + return resolved args (for path detection reuse).
 */
async function getSpecSuggestions(ctx: CompletionContext): Promise<SpecSuggestionResult> {
  const suggestions: CompletionSuggestion[] = [];

  const specAvailable = await hasSpec(ctx.commandName);
  if (!specAvailable) {
    if (ctx.wordIndex === 0 && ctx.currentWord.length >= 1) {
      return { suggestions: await getCommandNameSuggestions(ctx.currentWord) };
    }
    return { suggestions };
  }

  const spec = await loadSpec(ctx.commandName);
  if (!spec) return { suggestions };

  // If we're still typing the command name (partial match, not yet complete)
  if (ctx.wordIndex === 0) {
    const typedLower = ctx.currentWord.toLowerCase();
    const specNames = resolveNames(spec.name);
    const isExactMatch = specNames.some((n) => n.toLowerCase() === typedLower);
    if (!isExactMatch) return { suggestions };

    // Show subcommands as preview (user typed full command but no space yet)
    if (spec.subcommands) {
      for (const sub of spec.subcommands) {
        const names = resolveNames(sub.name);
        suggestions.push({
          text: ctx.currentWord + " " + names[0],
          displayText: names[0],
          description: sub.description,
          source: "subcommand",
          score: 800,
        });
        if (suggestions.length >= 10) break;
      }
    }
    return { suggestions };
  }

  // Navigate the spec tree based on typed tokens
  const resolved = resolveSpecContext(spec, ctx.tokens.slice(1, ctx.wordIndex));
  const currentToken = ctx.currentWord;

  // Check if currentToken exactly matches a subcommand — if so, navigate into it
  // and show its children as preview (e.g., "git commit" shows commit's options)
  if (currentToken && resolved.subcommands) {
    const exactMatch = resolved.subcommands.find((s) => {
      const names = resolveNames(s.name);
      return names.includes(currentToken);
    });
    if (exactMatch) {
      // Navigate into the matched subcommand and show its children
      const childResolved = resolveSpecContext(spec, ctx.tokens.slice(1, ctx.wordIndex + 1));

      // Show child subcommands
      if (childResolved.subcommands) {
        for (const sub of childResolved.subcommands) {
          const names = resolveNames(sub.name);
          suggestions.push({
            text: ctx.commandLine + " " + names[0],
            displayText: names[0],
            description: sub.description,
            source: "subcommand",
            score: 800,
          });
          if (suggestions.length >= 10) break;
        }
      }
      // Show child options
      appendOptionPreviewSuggestions(
        suggestions,
        ctx.commandLine,
        childResolved.options?.length ? childResolved.options : childResolved.fallbackOptions,
        15,
      );
      return { suggestions };
    }
  }

  // Suggest subcommands (prefix match, excluding exact matches)
  if (resolved.subcommands) {
    for (const sub of resolved.subcommands) {
      const names = resolveNames(sub.name);
      for (const name of names) {
        if (name.startsWith(currentToken) && name !== currentToken) {
          suggestions.push({
            text: rebuildCommand(ctx.tokens, ctx.wordIndex, name),
            displayText: name,
            description: sub.description,
            source: "subcommand",
            score: 800,
          });
        }
      }
    }
  }

  // Suggest options
  const hasDirectOptionSuggestions = appendOptionSuggestions(
    suggestions,
    ctx,
    currentToken,
    resolved.options,
  );
  if (!hasDirectOptionSuggestions) {
    appendOptionSuggestions(suggestions, ctx, currentToken, resolved.fallbackOptions);
  }

  // Suggest argument values from suggestions in the spec
  if (resolved.args) {
    const args = Array.isArray(resolved.args) ? resolved.args : [resolved.args];
    for (const arg of args) {
      if (arg.suggestions) {
        for (const sug of arg.suggestions) {
          const sugName = typeof sug === "string" ? sug : (Array.isArray(sug.name) ? sug.name[0] : sug.name);
          const sugDesc = typeof sug === "string" ? undefined : sug.description;
          if (sugName.startsWith(currentToken) && sugName !== currentToken) {
            suggestions.push({
              text: rebuildCommand(ctx.tokens, ctx.wordIndex, sugName),
              displayText: sugName,
              description: sugDesc,
              source: "arg",
              score: 600,
            });
          }
        }
      }
    }
  }

  return {
    suggestions,
    pathArgs: resolved.args,
  };
}

/**
 * Get command name suggestions by matching against available specs.
 * Uses the already-imported getAvailableSpecs directly (no dynamic self-import).
 */
async function getCommandNameSuggestions(prefix: string): Promise<CompletionSuggestion[]> {
  const specs = await getAvailableSpecs();
  const lower = prefix.toLowerCase();
  const suggestions: CompletionSuggestion[] = [];

  for (const name of specs) {
    // Skip sub-path specs like "aws/s3", "dotnet/dotnet-build" — not direct shell commands
    if (name.includes("/")) continue;
    if (name.startsWith(lower) && name !== lower) {
      suggestions.push({
        text: name,
        displayText: name,
        source: "command",
        score: 600,
      });
      if (suggestions.length >= 10) break;
    }
  }

  return suggestions;
}

interface ResolvedContext {
  subcommands?: FigSubcommand[];
  options?: FigOption[];
  fallbackOptions?: FigOption[];
  args?: FigSubcommand["args"];
}

/**
 * Walk the spec tree following the typed tokens to find the current context.
 * Handles options with arguments (e.g., --name value) by skipping the value token.
 */
function resolveSpecContext(spec: FigSpec, consumedTokens: string[]): ResolvedContext {
  let current: FigSubcommand = spec;
  let inheritedOptions: FigOption[] = [];
  let skipNext = false;
  let lastOptionArgs: FigSubcommand["args"] | undefined;

  for (const token of consumedTokens) {
    // Skip this token if it's the argument value of a previous option
    if (skipNext) {
      skipNext = false;
      lastOptionArgs = undefined;
      continue;
    }

    // Handle option flags
    if (token.startsWith("-")) {
      // Check if this option expects an argument
      const opt = [...(current.options ?? []), ...inheritedOptions].find((candidate) => {
        const names = resolveNames(candidate.name);
        return names.includes(token);
      });
      if (opt?.args) {
        // This option expects an argument — the next token is its value
        const args = Array.isArray(opt.args) ? opt.args : [opt.args];
        if (args.length > 0 && !args[0].isOptional) {
          skipNext = true;
          lastOptionArgs = opt.args; // Track for the case where next token is currentWord
        }
      }
      continue;
    }

    // Try to find a matching subcommand
    if (current.subcommands) {
      const sub = current.subcommands.find((s) => {
        const names = resolveNames(s.name);
        return names.includes(token);
      });
      if (sub) {
        inheritedOptions = mergeOptionLists(inheritedOptions, current.options);
        current = sub;
        continue;
      }
    }

    // If no subcommand matched, we're at the args level
    break;
  }

  // If skipNext is still true, the currentWord is an option's arg value
  // (e.g., "git archive --format |" — currentWord is the format value)
  // Return the option's args instead of the subcommand's args.
  if (skipNext && lastOptionArgs) {
    return {
      subcommands: undefined,
      options: undefined,
      fallbackOptions: inheritedOptions.length > 0 ? inheritedOptions : undefined,
      args: lastOptionArgs,
    };
  }

  return {
    subcommands: current.subcommands,
    options: current.options ? [...current.options] : undefined,
    fallbackOptions: inheritedOptions.length > 0 ? inheritedOptions : undefined,
    args: current.args,
  };
}

function mergeOptionLists(
  left: FigOption[] | undefined,
  right: FigOption[] | undefined,
): FigOption[] {
  const merged: FigOption[] = [];
  const seen = new Set<string>();

  for (const option of [...(left ?? []), ...(right ?? [])]) {
    const key = resolveNames(option.name).sort().join("\0");
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(option);
  }

  return merged;
}

function appendOptionSuggestions(
  suggestions: CompletionSuggestion[],
  ctx: CompletionContext,
  currentToken: string,
  options: FigOption[] | undefined,
): boolean {
  if (!options || options.length === 0) return false;

  let added = false;
  for (const opt of options) {
    const names = resolveNames(opt.name);
    for (const name of names) {
      if (name.startsWith(currentToken) && name !== currentToken) {
        suggestions.push({
          text: rebuildCommand(ctx.tokens, ctx.wordIndex, name),
          displayText: name,
          description: opt.description,
          source: "option",
          score: 700,
        });
        added = true;
      }
    }
  }

  return added;
}

function appendOptionPreviewSuggestions(
  suggestions: CompletionSuggestion[],
  commandLine: string,
  options: FigOption[] | undefined,
  limit: number,
): void {
  if (!options || options.length === 0 || suggestions.length >= limit) return;

  for (const opt of options) {
    const names = resolveNames(opt.name);
    suggestions.push({
      text: commandLine + " " + names[0],
      displayText: names[0],
      description: opt.description,
      source: "option",
      score: 700,
    });
    if (suggestions.length >= limit) break;
  }
}

/**
 * Rebuild the full command text with a replacement at a specific token index.
 */
function rebuildCommand(tokens: string[], replaceIndex: number, replacement: string): string {
  const rebuilt = [...tokens];
  rebuilt[replaceIndex] = replacement;
  return rebuilt.join(" ");
}
