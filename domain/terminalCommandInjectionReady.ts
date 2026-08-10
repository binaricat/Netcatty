/**
 * Whether an automated PTY write (e.g. SFTP "open path in terminal") may run
 * at a clean interactive shell prompt -- not mid-line, not in an editor/TUI.
 */
export function isIdleShellReadyForCommandInjection(options: {
  sensitiveInputActive?: boolean;
  hasLiveTerminal: boolean;
  alternateScreenActive: boolean;
  isAtPrompt: boolean;
  userInputLength: number;
  pendingTypedInputLength?: number;
}): boolean {
  if (options.sensitiveInputActive) return false;
  if (!options.hasLiveTerminal) return false;
  if (options.alternateScreenActive) return false;
  if (!options.isAtPrompt) return false;
  if (options.userInputLength > 0) return false;
  if ((options.pendingTypedInputLength ?? 0) > 0) return false;
  return true;
}
