const ESCAPE_SEQUENCE = "\\x" + "1b";
const BELL_SEQUENCE = "\\x" + "07";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const ANSI_PATTERN = new RegExp(`${ESCAPE_SEQUENCE}\\[[0-?]*[ -/]*[@-~]`, "g");
const OSC_PATTERN = new RegExp(
  `${ESCAPE_SEQUENCE}\\][^${BELL_SEQUENCE}]*(?:${BELL_SEQUENCE}|${ESCAPE_SEQUENCE}\\\\)`,
  "g",
);
// SGR conceal (parameter 8) hides the text it wraps. Refuse to treat concealed
// output as a real prompt so a remote can't disguise a fake prompt and harvest
// the autofilled password.
const CONCEAL_PATTERN = new RegExp(`${ESCAPE_SEQUENCE}\\[(?:[0-9]+;)*8(?:;[0-9]+)*m`);
// An explicit sudo prompt carries the sudo-specific "[sudo]" tag, so it is safe
// to fill even if sudo's creds were warm and other output followed. The
// "password for <user>" phrasing alone is NOT sudo-specific (psql emits
// "Password for user alice:", for one), so we require the tag.
const EXPLICIT_SUDO_PROMPT_PATTERN =
  /(?:^|[\r\n])[^\r\n]*?\[sudo\][^\r\n]*?(?:password|密\s*码|口\s*令)[^\r\n:：]*[:：]\s*$/i;
// A bare prompt is a line that on its own is just "Password:" / "密码:". PAM
// emits this on some distros, so we accept it inside the arm window. We reject
// PREFIXED prompts like "Enter password:" (mysql -p) or "user@host's password:"
// (ssh): those belong to programs sudo launches, and filling them would leak the
// sudo password to that program.
const BARE_PASSWORD_PATTERN = /^\s*(?:password|密\s*码|口\s*令)\s*[:：]\s*$/i;
const SUDO_COMMAND_PATTERN = /^\s*(?:builtin\s+|command\s+)?sudo(?:\s|$)/;

export const stripTerminalControlSequences = (data: string): string =>
  data.replace(OSC_PATTERN, "").replace(ANSI_PATTERN, "");

export const isSudoPasswordPrompt = (data: string): boolean => {
  if (CONCEAL_PATTERN.test(data)) return false;
  const text = stripTerminalControlSequences(data);
  if (EXPLICIT_SUDO_PROMPT_PATTERN.test(text)) return true;
  const lastLine = text.split(/[\r\n]/).pop() ?? text;
  return BARE_PASSWORD_PATTERN.test(lastLine);
};

export const shouldArmSudoPasswordAutofill = (command: string): boolean =>
  SUDO_COMMAND_PATTERN.test(command);

export type SudoPasswordAutofill = {
  armForCommand: (command: string) => void;
  handleOutput: (data: string) => string;
  updatePassword: (password?: string) => void;
};

const unwrapBracketedPaste = (data: string): string => {
  if (data.startsWith(BRACKETED_PASTE_START) && data.endsWith(BRACKETED_PASTE_END)) {
    return data.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length);
  }
  return data;
};

export const getSinglePastedCommand = (
  data: string,
): { command: string; lineEnding: string } | null => {
  const match = unwrapBracketedPaste(data).match(/^([^\r\n]+)(\r\n|\r|\n)$/);
  if (!match) return null;
  return {
    command: match[1],
    lineEnding: match[2],
  };
};

export const getSingleBracketedPasteLine = (data: string): string | null => {
  if (!data.startsWith(BRACKETED_PASTE_START) || !data.endsWith(BRACKETED_PASTE_END)) {
    return null;
  }
  const text = unwrapBracketedPaste(data);
  if (!text || /[\r\n]/.test(text)) return null;
  return text;
};

// Arm the autofill when a sudo command is submitted. The user's input is sent to
// the remote verbatim — we never rewrite it — so the terminal echo and cursor
// stay correct.
export const prepareSudoAutofillInput = (
  data: string,
  recordedCommand: string | null,
  sudoAutofill: SudoPasswordAutofill | null | undefined,
): string => {
  if (!sudoAutofill) return data;
  if (data === "\r" || data === "\n") {
    if (recordedCommand) sudoAutofill.armForCommand(recordedCommand);
    return data;
  }
  if (data.startsWith(BRACKETED_PASTE_START) && data.endsWith(BRACKETED_PASTE_END)) {
    return data;
  }
  const pastedCommand = getSinglePastedCommand(data);
  if (pastedCommand) sudoAutofill.armForCommand(pastedCommand.command);
  return data;
};

export const createSudoPasswordAutofill = (_options: {
  password?: string;
  write: (data: string) => void;
  now?: () => number;
}): SudoPasswordAutofill => {
  const options = {
    now: () => Date.now(),
    ..._options,
  };
  let password = options.password ?? "";
  const armWindowMs = 10_000;
  let tail = "";
  let armedUntil = Number.NEGATIVE_INFINITY;

  const disarm = () => {
    armedUntil = Number.NEGATIVE_INFINITY;
    tail = "";
  };

  return {
    armForCommand: (command: string) => {
      // Any non-sudo command (or no saved password) clears a pending arm, so a
      // later command's own "Password:" prompt is never mistaken for sudo's.
      if (!password || !shouldArmSudoPasswordAutofill(command)) {
        disarm();
        return;
      }
      armedUntil = options.now() + armWindowMs;
      tail = "";
    },
    handleOutput: (data: string) => {
      if (!password || armedUntil === Number.NEGATIVE_INFINITY) return data;
      if (options.now() > armedUntil) {
        disarm();
        return data;
      }
      tail = `${tail}${data}`.slice(-1024);
      const lastLine = tail.split(/[\r\n]/).pop() ?? tail;
      if (isSudoPasswordPrompt(lastLine)) {
        options.write(`${password}\n`);
        disarm();
      }
      return data;
    },
    updatePassword: (nextPassword?: string) => {
      password = nextPassword ?? "";
      if (!password) disarm();
    },
  };
};
