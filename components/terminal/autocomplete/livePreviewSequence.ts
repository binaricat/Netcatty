/**
 * Compute the keystrokes to send so the terminal input line becomes exactly
 * `candidate`, given what is currently on the line. Drives the popup
 * autocomplete live-preview (#1005): moving the selection renders the chosen
 * suggestion into the command line, and switching / reverting rewrites it.
 *
 * - Forward prefix (candidate continues the line): append only the new tail.
 * - Otherwise: clear the current input, then write the full candidate. POSIX
 *   shells use Ctrl-U (kill-line); Windows (cmd/PowerShell) uses backspaces
 *   sized to the current line length.
 */
export function computeLivePreviewWrite(input: {
  currentLine: string;
  candidate: string;
  os: string;
}): string {
  const { currentLine, candidate, os } = input;
  if (candidate === currentLine) return "";
  if (candidate.startsWith(currentLine)) {
    return candidate.slice(currentLine.length);
  }
  const clear = os === "windows" ? "\b".repeat(currentLine.length) : "\x15";
  return clear + candidate;
}
