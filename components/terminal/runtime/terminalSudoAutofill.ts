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
// output as a real prompt so a remote can't disguise a fake prompt and trick the
// user into revealing the password.
const CONCEAL_PATTERN = new RegExp(`${ESCAPE_SEQUENCE}\\[(?:[0-9]+;)*8(?:;[0-9]+)*m`);
// A line that ends in a colon and mentions password/密码/口令. Intentionally
// broad: filling requires the user to confirm (press Enter), so over-matching
// only shows a dismissable hint and never leaks a password to a child program.
const SUDO_PROMPT_PATTERN =
  /(?:^|[\r\n])[^\r\n]*?(?:\bpassword\b|密\s*码|口\s*令)[^\r\n:：]*[:：]\s*$/i;
// An explicit sudo prompt carries the sudo-specific "[sudo]" tag. No other tool
// prompts this way, so we hint on it WITHOUT requiring an arm — keeping the hint
// reliable even when command recording (arming) didn't fire for a manually
// typed command (#1284; manual typing's recordedCommand is flaky).
// Match [sudo] or [sudo: ...] variants (e.g. Chinese locale: [sudo: authenticate] 密码：, #1286).
const EXPLICIT_SUDO_PROMPT_PATTERN =
  /(?:^|[\r\n])[^\r\n]*?\[sudo[^\]]*\][^\r\n]*?(?:\bpassword\b|密\s*码|口\s*令)[^\r\n:：]*[:：]\s*$/i;
const SUDO_COMMAND_PATTERN = /^\s*(?:builtin\s+|command\s+)?sudo(?:\s|$)/;

export const stripTerminalControlSequences = (data: string): string =>
  data.replace(OSC_PATTERN, "").replace(ANSI_PATTERN, "");

export const isSudoPasswordPrompt = (data: string): boolean => {
  if (CONCEAL_PATTERN.test(data)) return false;
  return SUDO_PROMPT_PATTERN.test(stripTerminalControlSequences(data));
};

export const isExplicitSudoPrompt = (data: string): boolean => {
  if (CONCEAL_PATTERN.test(data)) return false;
  return EXPLICIT_SUDO_PROMPT_PATTERN.test(stripTerminalControlSequences(data));
};

export const shouldArmSudoPasswordAutofill = (command: string): boolean =>
  SUDO_COMMAND_PATTERN.test(command);

export type SudoPasswordAutofill = {
  armForCommand: (command: string) => void;
  handleOutput: (data: string) => string;
  confirmFill: () => void;
  cancelHint: () => void;
  isPromptPending: () => boolean;
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

// Confirm-to-fill model: when a sudo command is armed and a password prompt is
// seen, we DON'T send the password — we raise a hint (onHint(true)) so the UI can
// offer "press Enter to paste". The password is only written when the user
// confirms via confirmFill(). This makes over-broad detection safe: a misfire
// just shows a dismissable hint instead of leaking the password.
export const createSudoPasswordAutofill = (_options: {
  password?: string;
  write: (data: string) => void;
  /** Show/hide the inline hint. Returns whether the hint actually rendered;
   *  false (e.g. no overlay available) means we must not arm a confirmation. */
  onHint?: (active: boolean) => boolean;
  now?: () => number;
}): SudoPasswordAutofill => {
  const options = {
    now: () => Date.now(),
    onHint: () => false,
    ..._options,
  };
  let password = options.password ?? "";
  const armWindowMs = 10_000;
  let tail = "";
  let armedUntil = Number.NEGATIVE_INFINITY;
  let pending = false;

  const disarm = () => {
    armedUntil = Number.NEGATIVE_INFINITY;
    tail = "";
    if (pending) {
      pending = false;
      options.onHint(false);
    }
  };

  return {
    armForCommand: (command: string) => {
      // Clear any prior arm/hint first: a non-sudo command must not leave a
      // stale hint that a later prompt could satisfy.
      disarm();
      if (!password || !shouldArmSudoPasswordAutofill(command)) return;
      armedUntil = options.now() + armWindowMs;
      tail = "";
    },
    handleOutput: (data: string) => {
      if (!password) return data;
      tail = `${tail}${data}`.slice(-1024);
      // Fast path for bulk output: a prompt line ends in a colon, so a chunk
      // with no colon can't be completing one. Skip the regex work unless a hint
      // is pending (then we must keep watching for the prompt moving on).
      if (!pending && !data.includes(":") && !data.includes("：")) return data;
      const lastLine = tail.split(/[\r\n]/).pop() ?? tail;
      const armActive =
        armedUntil !== Number.NEGATIVE_INFINITY && options.now() <= armedUntil;
      // Explicit "[sudo] …" prompts are sudo-specific → hint regardless of arm,
      // so it's reliable even when arming didn't fire (#1284). Bare "Password:"
      // only hints inside the arm window, to avoid noise on unrelated prompts
      // (ssh, mysql, …).
      const isPrompt =
        isExplicitSudoPrompt(lastLine) || (armActive && isSudoPasswordPrompt(lastLine));
      if (pending) {
        // The prompt moved on: a new line arrived and the latest line is no
        // longer a password prompt (sudo timed out / failed / returned to the
        // shell). Clear the pending hint — otherwise a later Enter would send
        // the password to whatever is now reading input.
        if (!isPrompt && /[\r\n]/.test(data)) disarm();
        return data;
      }
      if (isPrompt) {
        // Only mark pending if the hint actually rendered. If the overlay is
        // unavailable (e.g. autocomplete disabled), don't intercept Enter — the
        // user would have no visible cue and could leak the password.
        if (options.onHint(true)) {
          pending = true;
        }
      }
      return data;
    },
    confirmFill: () => {
      if (!pending) return;
      options.write(`${password}\n`);
      disarm();
    },
    cancelHint: () => {
      if (!pending) return;
      disarm();
    },
    isPromptPending: () => pending,
    updatePassword: (nextPassword?: string) => {
      password = nextPassword ?? "";
      if (!password) disarm();
    },
  };
};
