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
 * Pre-compiled RegExp cache for command blocklist patterns.
 *
 * The blocklist is a best-effort defense-in-depth measure. It is NOT a
 * security boundary — determined users or sophisticated prompt injection
 * can bypass regex-based filtering. The primary security boundary is the
 * permission / confirmation system and OS-level sandboxing.
 */
const compiledDefaultBlocklist: Array<{ pattern: string; regex: RegExp }> = DEFAULT_COMMAND_BLOCKLIST.flatMap(
  (pattern) => {
    try {
      if (!isSafeRegex(pattern)) {
        console.warn(`[Safety] Skipping default blocklist pattern with nested quantifiers (ReDoS risk): ${pattern}`);
        return [];
      }
      return [{ pattern, regex: new RegExp(pattern, 'i') }];
    } catch {
      return [];
    }
  },
);

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
 * Default blocklist patterns are pre-compiled at module load time.
 * User-provided patterns are compiled once and cached.
 */
export function checkCommandSafety(
  command: string,
  blocklist: string[] = DEFAULT_COMMAND_BLOCKLIST,
): { blocked: boolean; matchedPattern?: string } {
  // Fast path: use pre-compiled regexes for the default blocklist
  if (blocklist === DEFAULT_COMMAND_BLOCKLIST) {
    for (const { pattern, regex } of compiledDefaultBlocklist) {
      if (regex.test(command)) {
        return { blocked: true, matchedPattern: pattern };
      }
    }
    return { blocked: false };
  }

  // User-provided blocklist: compile once and cache each pattern
  for (const pattern of blocklist) {
    const regex = getCompiledPattern(pattern);
    if (regex && regex.test(command)) {
      return { blocked: true, matchedPattern: pattern };
    }
  }
  return { blocked: false };
}
