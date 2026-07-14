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
// Arm for direct sudo *and* su commands (#2156). Trailing space/end keeps
// `sum`/`suspend`/`suuser` out. `sudo` is checked before bare `su`.
const SUDO_COMMAND_PATTERN = /^\s*(?:builtin\s+|command\s+)?sudo(?:\s|$)/;
const SU_COMMAND_PATTERN = /^\s*(?:builtin\s+|command\s+)?su(?:\s|$)/;
const SUDO_OR_SU_COMMAND_PATTERN =
  /^\s*(?:builtin\s+|command\s+)?su(?:do)?(?:\s|$)/;
// Used after confirm-to-fill: only re-open assist on a real auth retry, not on a
// subsequent child-program password prompt (e.g. `sudo mysql -p`).
const AUTH_RETRY_FAILURE_PATTERN =
  /sorry,\s*try\s*again|incorrect\s+password|authentication\s+failure|auth(?:entication)?\s+fail|密码(?:错误|不正确)|认证失败|鉴权失败|口令错误/i;
// Sudo without the [sudo] tag (Kylin #1293) still scopes the prompt to the user
// ("password for alice", "输入密码"). Generic child-program prompts are excluded:
// "Enter password:", "Password for user postgres:", etc.
const SUDO_SCOPED_BARE_PROMPT_PATTERN =
  /(?:password\s+for\b|的密码|输入密码|input\s+password)/i;
const CHILD_PROGRAM_PASSWORD_PROMPT_PATTERN =
  /(?:enter\s+password\b|password\s+for\s+user\b)/i;

type ArmedCommandKind = "sudo" | "su";

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

export const resolveArmedCommandKind = (command: string): ArmedCommandKind | null => {
  if (SUDO_COMMAND_PATTERN.test(command)) return "sudo";
  if (SU_COMMAND_PATTERN.test(command)) return "su";
  return null;
};

/** Sudo prompts without [sudo] that still look like sudo/PAM, not mysql/psql. */
export const isSudoScopedBarePasswordPrompt = (data: string): boolean => {
  if (CONCEAL_PATTERN.test(data)) return false;
  const plain = stripTerminalControlSequences(data);
  if (!isSudoPasswordPrompt(plain)) return false;
  if (CHILD_PROGRAM_PASSWORD_PROMPT_PATTERN.test(plain)) return false;
  return SUDO_SCOPED_BARE_PROMPT_PATTERN.test(plain);
};

/**
 * su typically prints a short bare Password: / 密码： line.
 * Reject SSH/scp style "user@host's password:" and long child prompts even
 * while an su command arm is still active (e.g. passwordless su -c ssh).
 */
export const isSuBarePasswordPrompt = (data: string): boolean => {
  if (CONCEAL_PATTERN.test(data)) return false;
  const plain = stripTerminalControlSequences(data).replace(/\s+/g, " ").trim();
  if (!plain) return false;
  if (CHILD_PROGRAM_PASSWORD_PROMPT_PATTERN.test(plain)) return false;
  // SSH/scp/rsync remote password prompts always include user@host.
  if (plain.includes("@")) return false;
  if (!isSudoPasswordPrompt(plain)) return false;
  // Whole line should be essentially the password word (+ optional colon).
  // Keep a small budget for locale variants like "Password: " / "密码：".
  if (plain.length > 24) return false;
  return /^(?:password|passwd|密\s*码|口\s*令)\s*[:：]?\s*$/i.test(plain);
};

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
  /** Dismiss the open UI without clearing the su/sudo arm (Esc). */
  cancelHint: () => void;
  isPromptPending: () => boolean;
  /** True only while the multi-credential picker UI is open (not the hint). */
  isPickerPending: () => boolean;
  /**
   * True when the user dismissed the UI with Esc but the command arm is still
   * live and the last line still looks like a password prompt — Esc/↑/↓ can
   * re-open the assist without re-running su/sudo.
   */
  canReshowAssist: () => boolean;
  /** Re-open assist after a soft dismiss. Returns whether the UI showed. */
  tryReshowAssist: () => boolean;
  /**
   * Picker mode: move selection while the list is open.
   * Returns true when the selection changed so callers can consume the key.
   */
  moveSelection: (delta: number) => boolean;
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
  let armedKind: ArmedCommandKind | null = null;
  let pending = false;
  let selectedIndex = 0;
  let pendingUi: "hint" | "picker" | null = null;
  /** True after confirmFill until we see success (non-prompt output) or expire. */
  let postFillRetry = false;
  /**
   * User hit Esc while a prompt assist was open. Keep the arm so they can
   * re-open (Esc/arrows) or so a real re-prompt can auto-show again — but do
   * not immediately re-fire on the same static Password: line with no new
   * output.
   */
  let dismissedWhileArmed = false;

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

  const isArmActiveNow = (): boolean =>
    armedUntil !== Number.NEGATIVE_INFINITY && options.now() <= armedUntil;

  const lastPromptLine = (): string => tail.split(/[\r\n]/).pop() ?? tail;

  const disarm = () => {
    armedUntil = Number.NEGATIVE_INFINITY;
    armedKind = null;
    postFillRetry = false;
    dismissedWhileArmed = false;
    tail = "";
    selectedIndex = 0;
    if (pending) {
      pending = false;
      hideUi();
    }
  };

  const tryShowForCurrentTail = (): boolean => {
    const armActive = isArmActiveNow();
    const lastLine = lastPromptLine();
    // Explicit [sudo] may show host-password hint without an arm; full picker
    // still requires armed su (allowFullPickerForLine).
    if (!isArmedPromptLine(lastLine, armActive)) return false;
    const allowFullPicker = allowFullPickerForLine(lastLine, armActive);
    if (!showAssist(allowFullPicker)) return false;
    pending = true;
    postFillRetry = false;
    dismissedWhileArmed = false;
    return true;
  };

  const isArmedPromptLine = (line: string, armActive: boolean): boolean => {
    if (isExplicitSudoPrompt(line)) return true;
    if (!armActive) return false;
    // su always prompts with a bare Password: line (not Enter password / DB).
    if (armedKind === "su") return isSuBarePasswordPrompt(line);
    // sudo: only sudo-scoped prompts, never generic "Enter password:" from
    // child programs when sudo credentials are already cached.
    if (armedKind === "sudo") return isSudoScopedBarePasswordPrompt(line);
    return false;
  };

  /**
   * Full keychain picker is only for armed `su` prompts (#2156). Sudo keeps
   * host-password quick-fill only — a multi-identity list after `sudo …` is
   * too easy to confuse with a child-program password prompt (or a forged
   * [sudo] line once auth is cached).
   */
  const allowFullPickerForLine = (line: string, armActive: boolean): boolean => {
    if (!armActive || armedKind !== "su") return false;
    return isSuBarePasswordPrompt(line);
  };

  const showHostPasswordHint = (): boolean => {
    if (!defaultPassword()) return false;
    if (options.onHint(true)) {
      pendingUi = "hint";
      return true;
    }
    return false;
  };

  /**
   * @param allowFullPicker When false (unarmed explicit [sudo] path), only
   * the session host password may be offered — never the full keychain list.
   * A forged remote `[sudo] password…` line must not surface other systems'
   * secrets even though filling still requires a user click (#2156 review).
   */
  const showAssist = (allowFullPicker: boolean): boolean => {
    if (mode === "off" || !hasFillMaterial()) return false;
    if (mode === "picker" && allowFullPicker && candidates.length > 0) {
      selectedIndex = Math.min(selectedIndex, candidates.length - 1);
      if (notifyPicker(true)) {
        pendingUi = "picker";
        return true;
      }
      return false;
    }
    // hint mode, or picker without arm / without multi candidates
    return showHostPasswordHint();
  };

  return {
    armForCommand: (command: string) => {
      // Clear any prior arm/hint first: a non-sudo/su command must not leave a
      // stale hint that a later prompt could satisfy.
      disarm();
      const kind = resolveArmedCommandKind(command);
      if (!hasFillMaterial() || !kind) return;
      armedKind = kind;
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
      const lastLine = lastPromptLine();
      let armActive = isArmActiveNow();
      if (!armActive) {
        postFillRetry = false;
        dismissedWhileArmed = false;
        armedKind = null;
      }
      // Explicit "[sudo] …" always; su arm accepts bare Password:; sudo arm only
      // accepts sudo-scoped bare prompts (not generic Enter password from mysql).
      const isPrompt = isArmedPromptLine(lastLine, armActive);
      if (pending) {
        // The prompt moved on: a new line arrived and the latest line is no
        // longer a password prompt (sudo timed out / failed / returned to the
        // shell). Clear the pending UI — otherwise a later Enter would send
        // the password to whatever is now reading input.
        if (!isPrompt && /[\r\n]/.test(data)) disarm();
        return data;
      }
      if (isPrompt) {
        // Soft-dismissed (Esc): do not auto-reopen on the same static prompt
        // with no new line. A real re-prompt (newline / auth-failure text)
        // clears the dismiss flag and may show again.
        if (dismissedWhileArmed) {
          const looksLikeNewPromptCycle =
            /[\r\n]/.test(data) || AUTH_RETRY_FAILURE_PATTERN.test(tail);
          if (!looksLikeNewPromptCycle) return data;
          dismissedWhileArmed = false;
        }
        // After a fill, only re-assist when this looks like a real auth retry
        // (explicit [sudo] again, or failure text in the tail). A bare
        // Password: from a child program after successful sudo must not reopen.
        if (postFillRetry) {
          const looksLikeAuthRetry =
            isExplicitSudoPrompt(lastLine)
            || (armedKind === "su" && AUTH_RETRY_FAILURE_PATTERN.test(tail))
            || (armedKind === "sudo" && (
              isExplicitSudoPrompt(lastLine) || AUTH_RETRY_FAILURE_PATTERN.test(tail)
            ));
          if (!looksLikeAuthRetry) {
            postFillRetry = false;
            armedUntil = Number.NEGATIVE_INFINITY;
            armedKind = null;
            return data;
          }
          armActive = true;
        }
        // Full picker only with strong evidence the prompt is su/sudo itself.
        // Unarmed / Kylin bare / ambiguous lines stay host-password hint only.
        tryShowForCurrentTail();
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
      // Clear pending UI. Keep a short arm + postFillRetry flag so a real
      // sudo/su rejection re-prompt can reopen assist, but a later child
      // Password: (e.g. after `sudo mysql -p`) will not (#2156 review).
      pending = false;
      hideUi();
      dismissedWhileArmed = false;
      postFillRetry = true;
      if (hasFillMaterial()) {
        armedUntil = options.now() + armWindowMs;
        tail = "";
      }
    },
    cancelHint: () => {
      if (!pending) return;
      // Soft dismiss: hide UI but keep arm + tail so Esc/arrows can re-open
      // while still on the Password: line, and so a re-prompt can auto-show.
      pending = false;
      hideUi();
      dismissedWhileArmed = isArmActiveNow();
      if (!dismissedWhileArmed) {
        armedKind = null;
        armedUntil = Number.NEGATIVE_INFINITY;
      }
    },
    isPromptPending: () => pending,
    isPickerPending: () => pending && pendingUi === "picker",
    canReshowAssist: () => {
      if (pending || !dismissedWhileArmed || !hasFillMaterial()) return false;
      if (!isArmActiveNow()) return false;
      return isArmedPromptLine(lastPromptLine(), true);
    },
    tryReshowAssist: () => {
      if (pending || !hasFillMaterial()) return false;
      if (!isArmActiveNow()) {
        dismissedWhileArmed = false;
        return false;
      }
      return tryShowForCurrentTail();
    },
    moveSelection: (delta: number) => {
      if (!pending || pendingUi !== "picker" || candidates.length === 0) return false;
      const next =
        (selectedIndex + delta + candidates.length * 10) % candidates.length;
      if (next === selectedIndex) return false;
      selectedIndex = next;
      notifyPicker(true);
      return true;
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
      // Mode change while pending: re-show the appropriate UI. Keep the full
      // picker available only for armed su (same gate as first detection).
      if (pending) {
        const armStillActive =
          armedUntil !== Number.NEGATIVE_INFINITY && options.now() <= armedUntil;
        const allowFullPicker = armStillActive && armedKind === "su";
        hideUi();
        if (!showAssist(allowFullPicker)) {
          pending = false;
        }
      }
    },
  };
};
