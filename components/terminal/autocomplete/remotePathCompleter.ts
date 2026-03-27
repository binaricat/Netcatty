/**
 * Remote path completion for terminal autocomplete.
 * Lists files/directories on the remote (or local) machine
 * when the user types commands that expect path arguments.
 */

import type { CompletionContext } from "./completionEngine";
import type { FigArg } from "./figSpecLoader";

/** Directory entry returned from IPC */
export interface DirEntry {
  name: string;
  type: "file" | "directory" | "symlink";
}

/** Bridge interface for directory listing */
interface PathBridge {
  listAutocompleteRemoteDir?: (
    sessionId: string,
    path: string,
    foldersOnly: boolean,
    filterPrefix?: string,
    limit?: number,
  ) => Promise<{ success: boolean; entries: DirEntry[] }>;
  listAutocompleteLocalDir?: (
    path: string,
    foldersOnly: boolean,
    filterPrefix?: string,
    limit?: number,
  ) => Promise<{ success: boolean; entries: DirEntry[] }>;
}

function getBridge(): PathBridge | undefined {
  return (window as Window & { netcatty?: PathBridge }).netcatty;
}

// Cache directory listings for 5 seconds. Full-directory cache is shared between
// popup suggestions and cascading sub-directory panels; filtered cache avoids
// repeated round-trips while the user keeps typing within the same directory.
const fullDirCache = new Map<string, { entries: DirEntry[]; timestamp: number }>();
const filteredDirCache = new Map<string, { entries: DirEntry[]; timestamp: number }>();
const inFlightRequests = new Map<string, Promise<DirEntry[]>>();
const CACHE_TTL_MS = 5000;
const MAX_CACHE_SIZE = 30;
const MAX_FILTERED_CACHE_SIZE = 60;

/** Commands that commonly accept file/directory path arguments */
const PATH_COMMANDS = new Set([
  "cd", "ls", "ll", "la", "dir", "cat", "less", "more", "head", "tail",
  "vim", "vi", "nvim", "nano", "emacs", "code", "subl",
  "cp", "mv", "rm", "mkdir", "rmdir", "touch", "chmod", "chown", "chgrp",
  "stat", "file", "source", ".", "bat", "rg", "find", "tree",
  "tar", "zip", "unzip", "gzip", "gunzip",
  "scp", "rsync", "diff",
  "python", "python3", "node", "ruby", "perl", "bash", "sh", "zsh",
]);

/** Commands that only accept directories (not files) */
const FOLDER_ONLY_COMMANDS = new Set(["cd", "mkdir", "rmdir", "pushd"]);

/**
 * Check if the current command context expects a path argument.
 */
export function shouldDoPathCompletion(
  ctx: CompletionContext,
  resolvedArgs?: FigArg | FigArg[],
): { shouldComplete: boolean; foldersOnly: boolean } {
  const currentWord = stripWrappingQuotes(ctx.currentWord);

  // 1. Typed path trigger: if current word starts with path-like prefix, always complete
  if (currentWord.startsWith("/") || currentWord.startsWith("./") ||
      currentWord.startsWith("../") || currentWord.startsWith("~/") ||
      currentWord === "." || currentWord === ".." || currentWord === "~") {
    const foldersOnly = FOLDER_ONLY_COMMANDS.has(ctx.commandName);
    return { shouldComplete: true, foldersOnly };
  }

  // 2. Fig spec template check
  if (resolvedArgs) {
    const args = Array.isArray(resolvedArgs) ? resolvedArgs : [resolvedArgs];
    for (const arg of args) {
      const templates = Array.isArray(arg.template) ? arg.template : arg.template ? [arg.template] : [];
      if (templates.includes("filepaths") || templates.includes("folders")) {
        return {
          shouldComplete: true,
          foldersOnly: templates.includes("folders") && !templates.includes("filepaths"),
        };
      }
      // Generators field often indicates path completion (e.g., cd)
      if (arg.generators) {
        const foldersOnly = FOLDER_ONLY_COMMANDS.has(ctx.commandName);
        return { shouldComplete: true, foldersOnly };
      }
    }
  }

  // 3. Hardcoded command list (for commands without fig specs)
  if (ctx.wordIndex >= 1 && PATH_COMMANDS.has(ctx.commandName)) {
    // Only if we're past the command name and not typing an option
    if (!currentWord.startsWith("-")) {
      return {
        shouldComplete: true,
        foldersOnly: FOLDER_ONLY_COMMANDS.has(ctx.commandName),
      };
    }
  }

  return { shouldComplete: false, foldersOnly: false };
}

/**
 * Parse the current word into directory-to-list and filter prefix.
 */
export function resolvePathComponents(
  currentWord: string,
  cwd: string | undefined,
): { dirToList: string; filterPrefix: string; pathPrefix: string; quoteSuffix: string } {
  const quotePrefix = getLeadingQuote(currentWord);
  const quoteSuffix = getTrailingMatchingQuote(currentWord, quotePrefix);
  const unquotedWord = stripWrappingQuotes(currentWord);

  // Handle empty input — list CWD
  if (!unquotedWord || unquotedWord === "." || unquotedWord === "~" || unquotedWord === "..") {
    const dir = unquotedWord === "~"
      ? "~"
      : unquotedWord === ".."
        ? resolveDirLookup("../", cwd)
        : (cwd || ".");
    const visiblePrefix = unquotedWord ? `${quotePrefix}${unquotedWord}/` : quotePrefix;
    return { dirToList: dir, filterPrefix: "", pathPrefix: visiblePrefix, quoteSuffix };
  }

  // Find the last path separator
  const lastSlash = unquotedWord.lastIndexOf("/");

  if (lastSlash >= 0) {
    const dirPart = unquotedWord.substring(0, lastSlash + 1); // includes trailing /
    const filterPart = unquotedWord.substring(lastSlash + 1);
    const decodedDirPart = decodeShellPathFragment(dirPart);
    const decodedFilterPart = decodeShellPathFragment(filterPart);

    const dirToList = resolveDirLookup(decodedDirPart, cwd);

    return { dirToList, filterPrefix: decodedFilterPart, pathPrefix: quotePrefix + dirPart, quoteSuffix };
  }

  // No slash — filter CWD entries by the typed prefix
  return {
    dirToList: cwd || ".",
    filterPrefix: decodeShellPathFragment(unquotedWord),
    pathPrefix: quotePrefix,
    quoteSuffix,
  };
}

export function normalizePathTokenForLookup(token: string, cwd?: string): string {
  const { dirToList, filterPrefix } = resolvePathComponents(token, cwd);
  if (!filterPrefix) return dirToList;

  if (!dirToList || dirToList === ".") {
    return filterPrefix;
  }

  const needsSeparator = !dirToList.endsWith("/");
  return `${dirToList}${needsSeparator ? "/" : ""}${filterPrefix}`;
}

/**
 * Get path completion suggestions.
 */
export async function getPathSuggestions(
  ctx: CompletionContext,
  options: {
    sessionId?: string;
    protocol?: string;
    cwd?: string;
    foldersOnly: boolean;
  },
): Promise<{ name: string; type: DirEntry["type"] }[]> {
  const { sessionId, protocol, cwd, foldersOnly } = options;
  const { dirToList, filterPrefix } = resolvePathComponents(ctx.currentWord, cwd);

  const entries = await listDirectoryEntries(dirToList, {
    sessionId,
    protocol,
    foldersOnly,
    filterPrefix,
    limit: 100,
  });

  return sortPathEntries(entries);
}

/**
 * List directory contents via IPC, with shared caching and in-flight dedup.
 */
export async function listDirectoryEntries(
  dirPath: string,
  options: {
    sessionId?: string;
    protocol?: string;
    foldersOnly: boolean;
    filterPrefix?: string;
    limit?: number;
  },
): Promise<DirEntry[]> {
  const {
    sessionId,
    protocol,
    foldersOnly,
    filterPrefix = "",
    limit = 100,
  } = options;
  const normalizedPrefix = filterPrefix.toLowerCase();
  const maxEntries = clampLimit(limit);
  const baseKey = `${protocol || "auto"}:${sessionId || "local"}:${dirPath}:${foldersOnly}`;
  const fullCacheKey = `${baseKey}:all`;
  const filteredCacheKey = `${baseKey}:prefix:${normalizedPrefix}:${maxEntries}`;

  // Full directory cache can satisfy both full and filtered lookups.
  const fullCached = fullDirCache.get(fullCacheKey);
  if (isFresh(fullCached)) {
    return filterEntries(fullCached.entries, normalizedPrefix, maxEntries);
  }

  if (normalizedPrefix) {
    const filteredCached = filteredDirCache.get(filteredCacheKey);
    if (isFresh(filteredCached)) {
      return filteredCached.entries;
    }
  }

  const inFlightFull = inFlightRequests.get(fullCacheKey);
  if (inFlightFull) {
    return filterEntries(await inFlightFull, normalizedPrefix, maxEntries);
  }

  const requestKey = normalizedPrefix ? filteredCacheKey : fullCacheKey;
  const inFlight = inFlightRequests.get(requestKey);
  if (inFlight) return inFlight;

  // Make IPC call
  const promise = (async (): Promise<DirEntry[]> => {
    try {
      const bridge = getBridge();
      if (!bridge) return [];

      let result: { success: boolean; entries: DirEntry[] };

      if (protocol === "local" || !sessionId) {
        if (!bridge.listAutocompleteLocalDir) return [];
        result = await bridge.listAutocompleteLocalDir(
          dirPath,
          foldersOnly,
          normalizedPrefix || undefined,
          maxEntries,
        );
      } else {
        if (!bridge.listAutocompleteRemoteDir) return [];
        result = await bridge.listAutocompleteRemoteDir(
          sessionId,
          dirPath,
          foldersOnly,
          normalizedPrefix || undefined,
          maxEntries,
        );
      }

      if (result.success) {
        const timestamp = Date.now();
        if (normalizedPrefix) {
          filteredDirCache.set(requestKey, { entries: result.entries, timestamp });
          evictOldest(filteredDirCache, MAX_FILTERED_CACHE_SIZE);
          return result.entries;
        }

        fullDirCache.set(requestKey, { entries: result.entries, timestamp });
        evictOldest(fullDirCache, MAX_CACHE_SIZE);
        return result.entries;
      }

      return [];
    } catch {
      return [];
    } finally {
      inFlightRequests.delete(requestKey);
    }
  })();

  inFlightRequests.set(requestKey, promise);
  return promise;
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 100;
  return Math.max(1, Math.min(200, Math.floor(limit)));
}

function resolveDirLookup(pathToken: string, cwd: string | undefined): string {
  if (!pathToken) return cwd || ".";
  if (pathToken.startsWith("/")) return normalizePosixLikePath(pathToken);
  if (pathToken === "~" || pathToken.startsWith("~/")) return normalizePosixLikePath(pathToken);
  if (cwd) return normalizePosixLikePath(`${cwd}/${pathToken}`);
  return normalizePosixLikePath(pathToken);
}

function normalizePosixLikePath(input: string): string {
  if (!input) return ".";

  const hasLeadingSlash = input.startsWith("/");
  const hasTildeRoot = input === "~" || input.startsWith("~/");
  const hasTrailingSlash = input.length > 1 && input.endsWith("/");
  const fixedRootSegments = hasTildeRoot ? 1 : 0;
  const raw = hasLeadingSlash
    ? input.slice(1)
    : hasTildeRoot
      ? input.slice(2)
      : input;
  const segments = hasTildeRoot ? ["~"] : [];

  for (const segment of raw.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (
        segments.length > fixedRootSegments &&
        segments[segments.length - 1] !== ".."
      ) {
        segments.pop();
      } else if (!hasLeadingSlash || hasTildeRoot) {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }

  let result: string;
  if (hasLeadingSlash) {
    result = "/" + segments.join("/");
    if (result === "/") return result;
  } else if (segments.length > 0) {
    result = segments.join("/");
  } else if (hasTildeRoot) {
    result = "~";
  } else {
    result = ".";
  }

  if (hasTrailingSlash && result !== "/" && result !== "." && result !== "~") {
    result += "/";
  } else if (hasTrailingSlash && result === "~") {
    result = "~/";
  }

  return result;
}

function isFresh(
  cached: { entries: DirEntry[]; timestamp: number } | undefined,
): cached is { entries: DirEntry[]; timestamp: number } {
  return Boolean(cached && Date.now() - cached.timestamp < CACHE_TTL_MS);
}

function filterEntries(entries: DirEntry[], filterPrefix: string, limit: number): DirEntry[] {
  if (!filterPrefix) return entries.slice(0, limit);

  const filtered: DirEntry[] = [];
  for (const entry of entries) {
    if (entry.name.toLowerCase().startsWith(filterPrefix)) {
      filtered.push(entry);
      if (filtered.length >= limit) break;
    }
  }
  return filtered;
}

function evictOldest(
  cache: Map<string, { entries: DirEntry[]; timestamp: number }>,
  maxSize: number,
): void {
  while (cache.size > maxSize) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

function decodeShellPathFragment(value: string): string {
  let result = "";
  let escaped = false;

  for (const ch of value) {
    if (escaped) {
      result += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    result += ch;
  }

  if (escaped) result += "\\";
  return result;
}

function getLeadingQuote(value: string): string {
  return value.startsWith('"') || value.startsWith("'") ? value[0] : "";
}

function getTrailingMatchingQuote(value: string, quotePrefix: string): string {
  return quotePrefix && value.endsWith(quotePrefix) ? quotePrefix : "";
}

function stripWrappingQuotes(value: string): string {
  if (!value) return value;
  let result = value;
  if (result.startsWith('"') || result.startsWith("'")) {
    result = result.slice(1);
  }
  if (result.endsWith('"') || result.endsWith("'")) {
    result = result.slice(0, -1);
  }
  return result;
}

function sortPathEntries(entries: DirEntry[]): DirEntry[] {
  return [...entries].sort((left, right) => {
    const leftRank = left.type === "directory" ? 0 : left.type === "symlink" ? 1 : 2;
    const rightRank = right.type === "directory" ? 0 : right.type === "symlink" ? 1 : 2;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
}
