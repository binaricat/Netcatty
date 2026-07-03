/**
 * Best-effort regex safety guard for user-provided patterns.
 *
 * Reject nested quantifier shapes such as `(a+)+`, `(a*)*`, `(a+){2,}`
 * that are common catastrophic-backtracking sources.
 */
export type RegexSafetyReason = "nested_quantifier";

export type RegexSafetyCheckResult =
  | { safe: true }
  | { safe: false; reason: RegexSafetyReason };

export function checkRegexSafetyPattern(pattern: string): RegexSafetyCheckResult {
  const nestedUnboundedQuantifier = /\((?:\?:)?[^)]*(?:\+|\*|\{\d+,\}|\{,\d+\})[^)]*\)(?:\+|\*|\{\d+,\}|\{,\d+\})/;
  if (nestedUnboundedQuantifier.test(pattern)) {
    return { safe: false, reason: "nested_quantifier" };
  }
  return { safe: true };
}
