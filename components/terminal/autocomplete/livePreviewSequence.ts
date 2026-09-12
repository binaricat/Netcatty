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

/**
 * Live-preview rewrites inject Ctrl-U / backspaces into the PTY. Vendor
 * bastion and network-device CLIs treat those bytes as session-kill, so
 * network-device sessions keep the popup but skip the rewrite (#1193).
 */
export function shouldWriteAutocompleteLivePreview(
  livePreviewEnabled: boolean,
  isNetworkDevice = false,
): boolean {
  return livePreviewEnabled && !isNetworkDevice;
}

export function isWindowsShellLineInput(
  os: string,
  promptText?: string | null,
): boolean {
  if (os === "windows") return true;
  // Hosts default to os:"linux" and the flag is easy to leave wrong. Windows
  // shells do not kill the line on Ctrl-U; PSReadLine renders the raw byte
  // literally (e.g. `tkn^Uuv run ...`), so every highlighted suggestion piles
  // onto the command line (#3184). The detected prompt is authoritative when
  // the flag disagrees: a drive-letter path with a backslash (`PS C:\Users>`,
  // `C:\Windows>`) only occurs in a Windows shell prompt.
  return typeof promptText === "string" && /(?:^|\s)[A-Za-z]:\\/.test(promptText);
}

export function computeLivePreviewWrite(input: {
  currentLine: string;
  candidate: string;
  os: string;
  /** Detected prompt text; lets a mislabeled host OS flag still clear the line (#3184). */
  promptText?: string;
}): string {
  const { currentLine, candidate, os } = input;
  if (candidate === currentLine) return "";
  if (candidate.startsWith(currentLine)) {
    return candidate.slice(currentLine.length);
  }
  const clear = isWindowsShellLineInput(os, input.promptText)
    ? "\b".repeat(currentLine.length)
    : "\x15";
  return clear + candidate;
}
