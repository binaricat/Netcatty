export interface ConfirmedPromptOptions {
  /** Network-device shells commonly use a bare host name followed by `>`. */
  allowHostStyleGreaterThan?: boolean;
  /**
   * True when the terminal is on the alternate screen (DEC 1049). Used to
   * tell vim's command-line `:` from a custom `sudo -p ':'` prompt.
   */
  alternateScreen?: boolean;
}

export const MAX_PROMPT_SECURITY_TAIL_CHARS: number;
export function stripTerminalControlSequences(value: string): string;
export function isSensitiveTerminalChallenge(value: string): boolean;
export function isConfirmedTerminalShellPrompt(
  promptText: string,
  options?: ConfirmedPromptOptions,
): boolean;
export function splitTerminalLogicalLines(value: string): string[];
export function isBashPs2ContinuationLine(line: string): boolean;
export function isUntrustedTerminalInputPrompt(
  value: string,
  options?: ConfirmedPromptOptions,
): boolean;
export function isJumpServerMenuPrompt(value: string): boolean;
export function isJumpServerMenuLine(value: string): boolean;
export function extractTerminalPromptHostname(value: string): string | null;
