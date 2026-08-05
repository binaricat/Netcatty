const ESCAPE_SEQUENCE = "\\x" + "1b";
const BELL_SEQUENCE = "\\x" + "07";
const ANSI_CONTROL_PATTERN = new RegExp(`${ESCAPE_SEQUENCE}\\[[0-?]*[ -/]*[@-~]`, 'gu');
const OSC_CONTROL_PATTERN = new RegExp(
  `${ESCAPE_SEQUENCE}\\][^${BELL_SEQUENCE}]*(?:${BELL_SEQUENCE}|${ESCAPE_SEQUENCE}\\\\)`,
  'gu',
);
const MAX_PROMPT_SECURITY_TAIL_CHARS = 2_048;

const SENSITIVE_ENGLISH_LABEL = [
  String.raw`pass(?:word|phrase|code)`,
  String.raw`one[\s-]?time(?:\s+(?:password|passcode|code|token))?`,
  String.raw`\botp\b`,
  String.raw`verification(?:\s+(?:code|token|passcode))?`,
  String.raw`authentication\s+(?:code|token|passcode)`,
  String.raw`security\s+(?:code|token|passcode|pin)`,
  String.raw`\bpin\b`,
  String.raw`\btoken\b`,
  String.raw`2fa`,
  String.raw`two[\s-]?factor`,
  String.raw`multi[\s-]?factor`,
  String.raw`\bmfa\b`,
  String.raw`second\s+factor`,
  String.raw`secondary(?:\s+\w+){0,3}\s+passw(?:ord)?`,
  String.raw`second(?:\s+\w+){0,3}\s+passw(?:ord)?`,
  String.raw`additional(?:\s+\w+){0,3}\s+passw(?:ord)?`,
  String.raw`re[-\s]?enter\s+passw(?:ord)?`,
  String.raw`confirm\s+passw(?:ord)?`,
  String.raw`\bedr\b`,
  String.raw`\bduo\b`,
].join('|');

const SENSITIVE_CJK_LABEL = [
  '\u5bc6\u7801',
  '\u53e3\u4ee4',
  '\u52a8\u6001',
  '\u4e00\u6b21\u6027',
  '\u9a8c\u8bc1\u7801',
  '\u9a8c\u8bc1\u4fe1\u606f',
  '\u4ee4\u724c',
  '\u53cc\u56e0\u7d20',
  '\u591a\u56e0\u7d20',
  '\u77ed\u4fe1\u9a8c\u8bc1',
  '\u624b\u673a\u9a8c\u8bc1',
  '\u4e8c\u6b21',
  '\u5b89\u5168\u5bc6\u7801',
  '\u6311\u6218\u7801',
].join('|');

const SENSITIVE_LABEL_PATTERN = new RegExp(
  `(?:${SENSITIVE_ENGLISH_LABEL}|${SENSITIVE_CJK_LABEL})`,
  'iu',
);

function stripTerminalControlSequences(value: string): string {
  return value.replace(OSC_CONTROL_PATTERN, '').replace(ANSI_CONTROL_PATTERN, '');
}

function lastLogicalLine(value: string): string {
  const plain = stripTerminalControlSequences(value);
  const boundary = Math.max(plain.lastIndexOf('\n'), plain.lastIndexOf('\r'));
  return plain.slice(boundary + 1).slice(-MAX_PROMPT_SECURITY_TAIL_CHARS);
}

/**
 * Keep enough raw output to recognize authentication prompts split across
 * transport chunks without retaining terminal history or unbounded data.
 */
export function appendTerminalPromptSecurityTail(previous: string, chunk: string): string {
  const combined = `${previous}${chunk}`;
  const boundary = Math.max(combined.lastIndexOf('\n'), combined.lastIndexOf('\r'));
  return combined.slice(boundary + 1).slice(-MAX_PROMPT_SECURITY_TAIL_CHARS);
}

/**
 * Detect a prompt-shaped authentication challenge. Vocabulary intentionally
 * matches the SSH keyboard-interactive boundary and also covers PIN/auth-code
 * variants used by local, Mosh, bastion, and device sessions.
 */
export function isSensitiveTerminalChallenge(value: string): boolean {
  const line = lastLogicalLine(value).trim();
  if (!line) return false;
  const label = SENSITIVE_LABEL_PATTERN.exec(line);
  if (!label) return false;
  const prefix = line.slice(0, label.index ?? 0).trim();
  const suffix = line.slice((label.index ?? 0) + label[0].length);
  if (suffix.trim().length === 0) {
    return prefix.length === 0
      || /(?:^|\s)(?:enter|input|provide|type|scan|please|your|current|new|old)\s*$/iu.test(prefix)
      || /(?:\u8f93\u5165|\u8bf7\u8f93\u5165|\u8bf7)\s*$/u.test(prefix);
  }
  if (/^\s+(?:for|of)\s+[^\r\n]{1,96}$/iu.test(suffix)) return true;
  return /^[^\r\n:：>›»]{0,96}[:：>›»]\s*[^\r\n]{0,1024}$/u.test(suffix);
}

type ConfirmedPromptOptions = {
  /** Network-device shells commonly use a bare host name followed by `>`. */
  allowHostStyleGreaterThan?: boolean;
};

/**
 * Positive policy for data that may cross the ordinary completion Provider
 * boundary. Generic prompt parsing remains permissive for host UX/history,
 * while third-party Providers require a recognizable shell/device prompt.
 */
export function isConfirmedTerminalShellPrompt(
  promptText: string,
  options: ConfirmedPromptOptions = {},
): boolean {
  const prompt = lastLogicalLine(promptText).trim();
  if (!prompt || isSensitiveTerminalChallenge(prompt)) return false;
  if (/[❯❮→➜➤⟩»›]/u.test(prompt)) return true;
  for (const character of prompt) {
    const code = character.charCodeAt(0);
    if (code >= 0xE000 && code <= 0xF8FF) return true;
  }
  if (/[$#%]$/u.test(prompt)) return true;
  if (!prompt.endsWith('>')) return false;
  if (/^(?:PS\s+)?[A-Za-z]:[\\/].*>$/u.test(prompt)) return true;
  if (/[@\\/~:]\S*>$/u.test(prompt)) return true;
  return options.allowHostStyleGreaterThan === true
    && /^[A-Za-z0-9_.-]+(?:\([^)]{1,128}\))?>$/u.test(prompt);
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

/**
 * Body text before a `$` / `#` / `%` terminator that is plausible as a shell
 * PS1 (bare marker, user@host, path, shell-version, or lowercase identity).
 * Rejects English challenge labels that only happen to end with those markers
 * (`Challenge #`, `Account $`).
 */
function isPlausibleShellPromptBody(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) return true;
  if (/@|[/\\~:]/u.test(trimmed)) return true;
  if (/^(?:bash|zsh|sh|fish|ksh|csh|tcsh|dash)(?:-[\d.]+)?$/iu.test(trimmed)) return true;
  // Single lowercase identity token: root, ubuntu, pi — not Title-Case labels.
  return /^[a-z0-9_.-]+$/u.test(trimmed);
}

/**
 * True when a confirmed shell/device prompt is followed by typed text on the
 * same logical line (e.g. `user@host:~$ lsof -i:`). Trailing `:` / `>` in that
 * typed text is ordinary command input, not an authentication boundary.
 *
 * Requires a real prompt boundary (terminator + whitespace) so mid-label
 * shapes like `Challenge #1:` stay fail-closed. For `$`/`#`/`%`, also requires
 * a plausible PS1 body so `Challenge # 1:` / `Account $ code:` stay untrusted.
 */
function hasTypedInputAfterConfirmedPrompt(
  line: string,
  options: ConfirmedPromptOptions = {},
): boolean {
  for (let i = 0; i < line.length - 1; i += 1) {
    const ch = line[i];
    // Only terminators that can end a confirmed prompt without relying on a
    // glyph appearing later in the typed command.
    if (ch !== '$' && ch !== '#' && ch !== '%' && ch !== '>') continue;
    const rest = line.slice(i + 1);
    // Prompt terminators are followed by whitespace before typed input.
    if (!/^\s+\S/u.test(rest)) continue;
    const candidate = line.slice(0, i + 1);
    if (!isConfirmedTerminalShellPrompt(candidate, options)) continue;
    if ((ch === '$' || ch === '#' || ch === '%') && !isPlausibleShellPromptBody(candidate.slice(0, -1))) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Fail closed for prompt-shaped input boundaries that are not positively
 * identified as an ordinary shell/device prompt. This protects custom PAM,
 * bastion, and appliance challenges whose labels contain no known vocabulary.
 */
export function isUntrustedTerminalInputPrompt(
  value: string,
  options: ConfirmedPromptOptions = {},
): boolean {
  const prompt = lastLogicalLine(value).trim();
  if (!prompt) return false;
  if (isSensitiveTerminalChallenge(prompt)) return true;
  if (!/[:：>›»]\s*$/u.test(prompt)) return false;
  // Mid-command punctuation after a real shell prompt must keep broadcasting
  // (#2709). Standalone `Label:` / `Custom>` challenges still fail closed.
  if (hasTypedInputAfterConfirmedPrompt(prompt, options)) return false;
  return !isConfirmedTerminalShellPrompt(prompt, options);
}

export { MAX_PROMPT_SECURITY_TAIL_CHARS };
