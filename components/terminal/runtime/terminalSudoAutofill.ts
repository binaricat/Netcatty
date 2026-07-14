import type { PasswordPromptAssistMode } from "../../../domain/models";

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
// A line that mentions password/密码/口令 and optionally ends in a colon.
// Intentionally broad: filling requires the user to confirm (press Enter), so
// over-matching only shows a dismissable hint and never leaks a password to a
// child program.  The colon is optional because Kylin's sudo prompt doesn't
// use one (#1293).
const SUDO_PROMPT_PATTERN =
  /(?:^|[\r\n])[^\r\n]*?(?:\bpassword\b|密\s*码|口\s*令)[^\r\n:：]*(?:[:：]\s*)?$/i;
// An explicit sudo prompt carries the sudo-specific "[sudo]" tag. No other tool
// prompts this way, so we hint on it WITHOUT requiring an arm — keeping the hint
// reliable even when command recording (arming) didn't fire for a manually
// typed command (#1284; manual typing's recordedCommand is flaky).
// Match [sudo] or [sudo: ...] variants (e.g. Chinese locale: [sudo: authenticate] 密码：, #1286).
// Colon is optional for Kylin (#1293).
const EXPLICIT_SUDO_PROMPT_PATTERN =
  /(?:^|[\r\n])[^\r\n]*?\[sudo[^\]]*\][^\r\n]*?(?:\bpassword\b|密\s*码|口\s*令)[^\r\n:：]*(?:[:：]\s*)?$/i;
// Arm for direct sudo *and* su commands (#2156). `su(?:do)?` matches `su` or
// `sudo` as a whole word (trailing space/end), so `sum`/`suspend`/`suuser` stay
// out. Bare su prompts are just "Password:", so they only hint inside the arm
// window — same safety model as a non-[sudo] password line after sudo.
const SUDO_OR_SU_COMMAND_PATTERN =
  /^\s*(?:builtin\s+|command\s+)?su(?:do)?(?:\s|$)/;

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
  SUDO_OR_SU_COMMAND_PATTERN.test(command);

/** Public picker row — never includes the secret. */
export type PasswordPromptPickerItem = {
  id: string;
  label: string;
  username?: string;
};

/** Internal candidate with password for confirm-to-fill. */
export type SudoPasswordAutofillCandidate = PasswordPromptPickerItem & {
  password: string;
};

export type PasswordPromptPickerState = {
  items: PasswordPromptPickerItem[];
  selectedIndex: number;
};

export type SudoPasswordAutofill = {
  armForCommand: (command: string) => void;
  handleOutput: (data: string) => string;
  /** Confirm with the selected (or host) password, or a specific candidate id. */
  confirmFill: (candidateId?: string) => void;
  cancelHint: () => void;
  isPromptPending: () => boolean;
  /** Picker mode: move selection while the list is open. */
  moveSelection: (delta: number) => void;
  updatePassword: (password?: string) => void;
  updateCandidates: (candidates: SudoPasswordAutofillCandidate[]) => void;
  updateMode: (mode: PasswordPromptAssistMode) => void;
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

// Arm the autofill when a sudo/su command is submitted. The user's input is sent
// to the remote verbatim — we never rewrite it — so the terminal echo and cursor
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

const toPickerItems = (
  candidates: SudoPasswordAutofillCandidate[],
): PasswordPromptPickerItem[] =>
  candidates.map(({ id, label, username }) => ({ id, label, username }));

// Confirm-to-fill model: when a sudo/su command is armed and a password prompt is
// seen, we DON'T send the password — we raise a hint or picker so the UI can
// offer confirmation. The password is only written when the user confirms via
// confirmFill(). This makes over-broad detection safe: a misfire just shows a
// dismissable UI instead of leaking the password.
export const createSudoPasswordAutofill = (_options: {
  mode?: PasswordPromptAssistMode;
  /** Hint-mode default password (host session password). */
  password?: string;
  /** Picker-mode candidates (host + keychain password identities). */
  candidates?: SudoPasswordAutofillCandidate[];
  write: (data: string) => void;
  /** Show/hide the inline hint. Returns whether the hint actually rendered. */
  onHint?: (active: boolean) => boolean;
  /**
   * Show/hide the credential picker. Returns whether the picker actually
   * rendered. `state` is null when hiding.
   */
  onPicker?: (active: boolean, state: PasswordPromptPickerState | null) => boolean;
  now?: () => number;
}): SudoPasswordAutofill => {
  const options = {
    now: () => Date.now(),
    onHint: (_active: boolean) => false,
    onPicker: (_active: boolean, _state: PasswordPromptPickerState | null) => false,
    ..._options,
  };
  let mode: PasswordPromptAssistMode = options.mode ?? "hint";
  let password = options.password ?? "";
  let candidates: SudoPasswordAutofillCandidate[] = options.candidates ?? [];
  const armWindowMs = 10_000;
  let tail = "";
  let armedUntil = Number.NEGATIVE_INFINITY;
  let pending = false;
  let selectedIndex = 0;
  let pendingUi: "hint" | "picker" | null = null;

  const hasFillMaterial = (): boolean => {
    if (mode === "off") return false;
    // Hint mode only uses the session host password — never an arbitrary
    // keychain identity (that would silently send the wrong secret on Enter).
    // Picker mode uses the full candidate list.
    if (mode === "hint") return Boolean(password);
    return candidates.length > 0 || Boolean(password);
  };

  /** Hint / single-password path: session password only (not candidates[0]). */
  const defaultPassword = (): string => password || "";

  const notifyPicker = (active: boolean): boolean => {
    if (!active) {
      return options.onPicker(false, null);
    }
    return options.onPicker(true, {
      items: toPickerItems(candidates),
      selectedIndex,
    });
  };

  const hideUi = () => {
    if (pendingUi === "hint") options.onHint(false);
    if (pendingUi === "picker") options.onPicker(false, null);
    pendingUi = null;
  };

  const disarm = () => {
    armedUntil = Number.NEGATIVE_INFINITY;
    tail = "";
    selectedIndex = 0;
    if (pending) {
      pending = false;
      hideUi();
    }
  };

  const showAssist = (): boolean => {
    if (mode === "off" || !hasFillMaterial()) return false;
    if (mode === "picker") {
      if (candidates.length > 0) {
        selectedIndex = Math.min(selectedIndex, candidates.length - 1);
        if (notifyPicker(true)) {
          pendingUi = "picker";
          return true;
        }
        return false;
      }
      // Picker with only a host password and no multi-candidate list: fall
      // back to the single-password hint so the user still gets assist.
      if (!defaultPassword()) return false;
      if (options.onHint(true)) {
        pendingUi = "hint";
        return true;
      }
      return false;
    }
    // hint mode: host session password only
    if (!defaultPassword()) return false;
    if (options.onHint(true)) {
      pendingUi = "hint";
      return true;
    }
    return false;
  };

  return {
    armForCommand: (command: string) => {
      // Clear any prior arm/hint first: a non-sudo/su command must not leave a
      // stale hint that a later prompt could satisfy.
      disarm();
      if (!hasFillMaterial() || !shouldArmSudoPasswordAutofill(command)) return;
      armedUntil = options.now() + armWindowMs;
      tail = "";
    },
    handleOutput: (data: string) => {
      if (!hasFillMaterial()) return data;
      tail = `${tail}${data}`.slice(-1024);
      // Fast path for bulk output: a prompt line ends in a colon, so a chunk
      // with no colon can't be completing one. Skip the regex work unless a hint
      // is pending (then we must keep watching for the prompt moving on).
      // Also check for password keywords because Kylin's sudo prompt doesn't
      // end with a colon (#1293).
      if (
        !pending &&
        !data.includes(":") &&
        !data.includes("：") &&
        !/(?:\bpassword\b|密码|口令)/i.test(data)
      ) {
        return data;
      }
      const lastLine = tail.split(/[\r\n]/).pop() ?? tail;
      const armActive =
        armedUntil !== Number.NEGATIVE_INFINITY && options.now() <= armedUntil;
      // Explicit "[sudo] …" prompts are sudo-specific → assist regardless of arm,
      // so it's reliable even when arming didn't fire (#1284). Bare "Password:"
      // only assists inside the arm window, to avoid noise on unrelated prompts
      // (ssh, mysql, …).
      const isPrompt =
        isExplicitSudoPrompt(lastLine) || (armActive && isSudoPasswordPrompt(lastLine));
      if (pending) {
        // The prompt moved on: a new line arrived and the latest line is no
        // longer a password prompt (sudo timed out / failed / returned to the
        // shell). Clear the pending UI — otherwise a later Enter would send
        // the password to whatever is now reading input.
        if (!isPrompt && /[\r\n]/.test(data)) disarm();
        return data;
      }
      if (isPrompt) {
        // Only mark pending if the UI actually rendered. If the overlay is
        // unavailable, don't intercept Enter — the user would have no visible
        // cue and could leak the password.
        if (showAssist()) {
          pending = true;
        }
      }
      return data;
    },
    confirmFill: (candidateId?: string) => {
      if (!pending) return;
      let secret = "";
      if (candidateId) {
        secret = candidates.find((c) => c.id === candidateId)?.password ?? "";
      } else if (pendingUi === "picker" && candidates.length > 0) {
        secret = candidates[selectedIndex]?.password ?? "";
      } else {
        // Hint path: only the explicit session password.
        secret = defaultPassword();
      }
      if (!secret) {
        disarm();
        return;
      }
      options.write(`${secret}\n`);
      disarm();
    },
    cancelHint: () => {
      if (!pending) return;
      disarm();
    },
    isPromptPending: () => pending,
    moveSelection: (delta: number) => {
      if (!pending || pendingUi !== "picker" || candidates.length === 0) return;
      const next =
        (selectedIndex + delta + candidates.length * 10) % candidates.length;
      if (next === selectedIndex) return;
      selectedIndex = next;
      notifyPicker(true);
    },
    updatePassword: (nextPassword?: string) => {
      password = nextPassword ?? "";
      if (!hasFillMaterial()) disarm();
    },
    updateCandidates: (next) => {
      candidates = next ?? [];
      if (selectedIndex >= candidates.length) {
        selectedIndex = Math.max(0, candidates.length - 1);
      }
      if (!hasFillMaterial()) {
        disarm();
        return;
      }
      if (pending && pendingUi === "picker") {
        notifyPicker(true);
      }
    },
    updateMode: (nextMode) => {
      mode = nextMode;
      if (!hasFillMaterial()) {
        disarm();
        return;
      }
      // Mode change while pending: re-show the appropriate UI.
      if (pending) {
        hideUi();
        if (!showAssist()) {
          pending = false;
        }
      }
    },
  };
};
