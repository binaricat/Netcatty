/**
 * Best-effort regex safety guard for user-provided patterns.
 *
 * Reject nested quantifier shapes such as `(a+)+`, `(a*)*`, `(a+){2,}`
 * that are common catastrophic-backtracking sources.
 */
export type RegexSafetyReason = "nested_quantifier";

export type RegexValidationIssue = "syntax_invalid" | "safety_rejected";

export type RegexSafetyCheckResult =
  | { safe: true }
  | { safe: false; reason: RegexSafetyReason };

export type RegexValidationResult =
  | { valid: true }
  | { valid: false; issue: RegexValidationIssue; reason?: RegexSafetyReason; errorMessage?: string };

export function checkRegexSafetyPattern(pattern: string): RegexSafetyCheckResult {
  const nestedUnboundedQuantifier = /\((?:\?:)?[^)]*(?:\+|\*|\{\d+,\}|\{,\d+\})[^)]*\)(?:\+|\*|\{\d+,\}|\{,\d+\})/;
  if (nestedUnboundedQuantifier.test(pattern)) {
    return { safe: false, reason: "nested_quantifier" };
  }
  return { safe: true };
}

export function validateUserRegexPattern(pattern: string, flags = "gi"): RegexValidationResult {
  try {
    // Syntax validation only.
    new RegExp(pattern, flags);
  } catch (err) {
    return {
      valid: false,
      issue: "syntax_invalid",
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  const safety = checkRegexSafetyPattern(pattern);
  if (safety.safe === false) {
    return {
      valid: false,
      issue: "safety_rejected",
      reason: safety.reason,
    };
  }

  return { valid: true };
}

export function isSafeRegexPattern(pattern: string): boolean {
  return checkRegexSafetyPattern(pattern).safe;
}
