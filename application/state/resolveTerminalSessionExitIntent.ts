export type TerminalSessionExitEvent = {
  exitCode?: number;
  signal?: number;
  error?: string;
  reason?: "exited" | "error" | "timeout" | "closed";
};

export type TerminalSessionExitIntent =
  | { kind: "markDisconnected" };

export function resolveTerminalSessionExitIntent(
  _evt: TerminalSessionExitEvent,
): TerminalSessionExitIntent {
  // Backend exits can be remote idle timeouts, shell termination, or transport closes.
  // Explicit user closes bypass this policy and call the close-session path directly.
  return { kind: "markDisconnected" };
}
