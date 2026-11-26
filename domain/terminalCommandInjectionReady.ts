export interface ShellPromptReadiness {
  sensitiveInputActive?: boolean;
  hasLiveTerminal: boolean;
  alternateScreenActive: boolean;
  isAtPrompt: boolean;
  userInputLength: number;
  pendingTypedInputLength?: number;
  afterCursorInputLength?: number;
}

/**
 * Prompt is showing on the primary screen and is not a password/TUI.
 * A typed draft is allowed; archive clicks insert at the cursor.
 */
export function isShellPromptReadyForInsertion(options: ShellPromptReadiness): boolean {
  if (options.sensitiveInputActive) return false;
  if (!options.hasLiveTerminal) return false;
  if (options.alternateScreenActive) return false;
  if (!options.isAtPrompt) return false;
  return true;
}

/**
 * Whether an automated PTY write (e.g. SFTP "open path in terminal") may run
 * at a clean interactive shell prompt -- not mid-line, not in an editor/TUI.
 */
export function isIdleShellReadyForCommandInjection(options: ShellPromptReadiness): boolean {
  if (!isShellPromptReadyForInsertion(options)) return false;
  if (options.userInputLength > 0) return false;
  if ((options.pendingTypedInputLength ?? 0) > 0) return false;
  if ((options.afterCursorInputLength ?? 0) > 0) return false;
  return true;
}
