/**
 * Fail-safe consistency check for inline (ghost-text) suggestions.
 *
 * Ghost text renders `suggestion.substring(trackedInput.length)` after the
 * cursor, where `trackedInput` is what the client thinks the user has typed.
 * On hosts with non-standard echo (hardware bastion hosts / network OS such as
 * `ecOS#`, issue #1013, previously #756 / #906) that tracked value drifts out
 * of sync with what is actually on the terminal line, and the ghost ends up
 * painted over characters the user already typed (`int` + ghost `terface` →
 * `intterface`).
 *
 * This detects the one direction that produces visible corruption: the real
 * line being AHEAD of the tracked input (it contains the tracked input
 * followed by more, untracked characters). SSH echo latency is the opposite
 * case — the line is a prefix-behind of the tracked input — and is
 * intentionally NOT flagged, so the ghost stays responsive on slow links.
 *
 * Returns true when the caller should hide the ghost.
 */
export function lineHasUntrackedTrailingInput(
  trackedInput: string,
  lineBeforeCursor: string,
): boolean {
  // Single chars match too loosely to judge reliably; let them through.
  if (trackedInput.length < 2) return false;
  // Column↔string mapping is only unambiguous for narrow (ASCII) input, so the
  // existing wide-char (CJK / emoji) handling is left untouched.
  if (!/^[\x20-\x7e]+$/.test(trackedInput)) return false;

  // Use the last occurrence so a prompt or command that repeats the same token
  // earlier on the line doesn't shadow the freshly-typed input.
  const idx = lineBeforeCursor.lastIndexOf(trackedInput);
  if (idx < 0) {
    // Tracked input isn't on screen yet — the echo is still catching up
    // (latency). Keep the ghost; reality being behind never corrupts.
    return false;
  }

  // Non-whitespace characters between the tracked input and the cursor mean the
  // device echoed input we never tracked → the ghost would overlap real text.
  return lineBeforeCursor.slice(idx + trackedInput.length).trimEnd().length > 0;
}
