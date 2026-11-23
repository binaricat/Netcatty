import {
  MAX_PROMPT_SECURITY_TAIL_CHARS,
  isBashPs2ContinuationLine,
  isConfirmedTerminalShellPrompt,
  isSensitiveTerminalChallenge,
  isUntrustedTerminalInputPrompt,
  splitTerminalLogicalLines,
  stripTerminalControlSequences,
  type ConfirmedPromptOptions,
} from './terminalPromptSecurity.shared.cjs';

const ESCAPE_SEQUENCE = "\\x" + "1b";
const CURSOR_POSITION_PATTERN = new RegExp(`${ESCAPE_SEQUENCE}\\[\\d*(?:;(\\d*))?[Hf]`, 'gu');

/**
 * Keep enough raw output to recognize authentication prompts split across
 * transport chunks without retaining terminal history or unbounded data.
 */
export function appendTerminalPromptSecurityTail(previous: string, chunk: string): string {
  const combined = `${previous}${chunk}`;
  const boundary = Math.max(combined.lastIndexOf('\n'), combined.lastIndexOf('\r'));
  return combined.slice(boundary + 1).slice(-MAX_PROMPT_SECURITY_TAIL_CHARS);
}

function nextHeredocPromptOrigin(origin: string, completedLine: string): string {
  const plain = stripTerminalControlSequences(completedLine).trim();
  // A blank line ends the continuation. A PS2 echo (">" or "> ...") does not.
  if (isBashPs2ContinuationLine(plain)) return origin;
  return plain.slice(0, MAX_PROMPT_SECURITY_TAIL_CHARS);
}

/**
 * Current logical line with controls stripped for classification, plus the
 * heredoc opener when the line is a bare ">". `current` stays raw so partial
 * control sequences can be completed by the next transport chunk.
 */
export function foldTerminalPromptSecurityOutput(
  state: { origin: string; current: string; pendingCr?: boolean },
  chunk: string,
): { origin: string; current: string; promptText: string; pendingCr: boolean } {
  let pendingCr = state.pendingCr === true;
  let input = chunk;
  if (pendingCr && input.startsWith('\n')) {
    input = input.slice(1);
    pendingCr = false;
  }
  const combined = `${state.current}${input}`.replace(
    CURSOR_POSITION_PATTERN,
    (sequence, column: string | undefined) => Number(column || 1) <= 1 ? '\r' : sequence,
  );
  let origin = state.origin;
  for (const line of splitTerminalLogicalLines(combined).slice(0, -1)) {
    origin = nextHeredocPromptOrigin(origin, line);
  }
  const current = appendTerminalPromptSecurityTail('', combined);
  const plain = stripTerminalControlSequences(current);
  const promptText = plain.trim() === '>' && origin
    ? `${origin}\n${plain}`
    : plain;
  if (input.endsWith('\r')) pendingCr = true;
  else if (input.length > 0) pendingCr = false;
  return { origin, current, promptText, pendingCr };
}

export function shouldUsePluginTerminalCompletionProvider(input: {
  sensitiveInputActive: boolean;
  promptText: string;
  allowHostStyleGreaterThan?: boolean;
}): boolean {
  return !input.sensitiveInputActive
    && !isSensitiveTerminalChallenge(input.promptText)
    && isConfirmedTerminalShellPrompt(input.promptText, {
      allowHostStyleGreaterThan: input.allowHostStyleGreaterThan,
    });
}

export {
  MAX_PROMPT_SECURITY_TAIL_CHARS,
  isConfirmedTerminalShellPrompt,
  isSensitiveTerminalChallenge,
  isUntrustedTerminalInputPrompt,
  type ConfirmedPromptOptions,
};
