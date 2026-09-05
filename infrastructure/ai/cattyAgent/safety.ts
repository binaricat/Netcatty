import commandBlocklistTable from '../../../lib/commandBlocklist.json';
import { DEFAULT_COMMAND_BLOCKLIST } from '../types';

/**
 * Check if a regex pattern is safe from ReDoS attacks.
 *
 * Rejects patterns with nested quantifiers like `(a+)+`, `(a*)*`, `(a+)*`
 * which can cause catastrophic backtracking / CPU exhaustion.
 */
function isSafeRegex(pattern: string): boolean {
  // Detect nested quantifiers: a group containing a quantifier, followed by another quantifier.
  // Matches patterns like (x+)+, (x*)+, (x+)*, (x{2,})+ etc.
  const nestedQuantifier = /\([^)]*[+*}]\)[+*?{]/;
  if (nestedQuantifier.test(pattern)) {
    return false;
  }
  // Also catch overlapping alternations with quantifiers inside quantified groups
  // e.g. (a|a)+  — not always dangerous but a common ReDoS vector
  const overlappingAlt = /\([^)]*\|[^)]*\)[+*]{/;
  if (overlappingAlt.test(pattern)) {
    return false;
  }
  return true;
}

/**
 * Pre-compiled RegExp cache for default blocklist patterns, grouped by the
 * shell family the pattern targets.
 *
 * The blocklist is a best-effort defense-in-depth measure. It is NOT a
 * security boundary — determined users or sophisticated prompt injection
 * can bypass regex-based filtering. The primary security boundary is the
 * permission / confirmation system and OS-level sandboxing.
 */
interface CompiledPattern { pattern: string; regex: RegExp }

const compileGroup = (patterns: string[]): CompiledPattern[] =>
  patterns.flatMap((pattern) => {
    try {
      if (!isSafeRegex(pattern)) {
        console.warn(`[Safety] Skipping default blocklist pattern with nested quantifiers (ReDoS risk): ${pattern}`);
        return [];
      }
      return [{ pattern, regex: new RegExp(pattern, 'i') }];
    } catch {
      return [];
    }
  });

const compiledCommonGroup = compileGroup(commandBlocklistTable.common);
const compiledPosixNativeGroup = compileGroup(commandBlocklistTable.posixNative);
const compiledPosixGroup = compileGroup(commandBlocklistTable.posix);
const compiledPowershellGroup = compileGroup(commandBlocklistTable.powershell);
const compiledGroups = {
  common: compiledCommonGroup,
  posixNative: compiledPosixNativeGroup,
  posix: compiledPosixGroup,
  powershell: compiledPowershellGroup,
};
const compiledAllGroups = [
  compiledCommonGroup,
  compiledPosixNativeGroup,
  compiledPosixGroup,
  compiledPowershellGroup,
];
const DEFAULT_PATTERN_SET = new Set(DEFAULT_COMMAND_BLOCKLIST);

/**
 * Default-blocklist groups that apply for a shell kind, from common
 * (shell-independent) patterns to per-family ones. Unknown / empty kinds
 * intentionally fall back to every group so callers that cannot classify a
 * session keep the strict behavior.
 */
function selectDefaultGroups(shellKind?: string): CompiledPattern[][] {
  const groupNames = commandBlocklistTable.shellGroups[
    String(shellKind ?? '').toLowerCase() as keyof typeof commandBlocklistTable.shellGroups
  ];
  if (!groupNames) return compiledAllGroups;

  return groupNames.map((name) => compiledGroups[name as keyof typeof compiledGroups]);
}

function checkCommandAgainstGroups(
  command: string,
  blocklist: string[],
  groups: CompiledPattern[][],
): { blocked: boolean; matchedPattern?: string } {
  const enabledPatterns = new Set(blocklist);

  // Settings entries that are not built-in defaults are user patterns and
  // remain shell-independent.
  for (const pattern of blocklist) {
    if (DEFAULT_PATTERN_SET.has(pattern)) continue;
    const regex = getCompiledPattern(pattern);
    if (regex && regex.test(command)) {
      return { blocked: true, matchedPattern: pattern };
    }
  }

  // Shell selection narrows the built-in entries that are enabled in the
  // configured list. It must not restore a default the user removed/edited.
  for (const group of groups) {
    for (const { pattern, regex } of group) {
      if (enabledPatterns.has(pattern) && regex.test(command)) {
        return { blocked: true, matchedPattern: pattern };
      }
    }
  }
  return { blocked: false };
}

/** Cache for user-provided (non-default) blocklist patterns. */
const userPatternCache = new Map<string, RegExp | null>();

function getCompiledPattern(pattern: string): RegExp | null {
  if (userPatternCache.has(pattern)) {
    return userPatternCache.get(pattern)!;
  }
  if (!isSafeRegex(pattern)) {
    console.warn(`[Safety] Skipping user blocklist pattern with nested quantifiers (ReDoS risk): ${pattern}`);
    userPatternCache.set(pattern, null);
    return null;
  }
  try {
    const regex = new RegExp(pattern, 'i');
    userPatternCache.set(pattern, regex);
    return regex;
  } catch {
    userPatternCache.set(pattern, null);
    return null;
  }
}

/**
 * Check if a command matches any pattern in the blocklist.
 * Returns the matching pattern if blocked, null if safe.
 *
 * The caller's list remains authoritative. User patterns apply on every shell,
 * while enabled default patterns are narrowed by shell kind. Unknown shell
 * kinds fall back to every enabled default group.
 *
 * Default blocklist patterns are pre-compiled at module load time.
 * User-provided patterns are compiled once and cached.
 */
export function checkCommandSafety(
  command: string,
  blocklist: string[] = DEFAULT_COMMAND_BLOCKLIST,
  shellKind?: string,
): { blocked: boolean; matchedPattern?: string } {
  return checkCommandAgainstGroups(command, blocklist, selectDefaultGroups(shellKind));
}

/**
 * Apply user patterns and enabled shell-independent defaults only. This is the
 * safe pre-filter for renderer metadata that does not yet know the remote shell;
 * the live bridge performs the final shell-selected check after probing.
 */
export function checkCommandSafetyCommonOnly(
  command: string,
  blocklist: string[] = DEFAULT_COMMAND_BLOCKLIST,
): { blocked: boolean; matchedPattern?: string } {
  return checkCommandAgainstGroups(command, blocklist, [compiledCommonGroup]);
}
