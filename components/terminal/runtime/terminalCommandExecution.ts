import type { RefObject } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { Host } from "../../../types";
import {
  isConfirmedTerminalShellPrompt,
  isSensitiveTerminalChallenge,
} from "../../../domain/terminalPromptSecurity";
import {
  markPromptLineBreakCommandPending,
  type PromptLineBreakState,
} from "./promptLineBreak";
import {
  getAlignedPrompt,
  isNonPromptLine,
  reconcilePromptWithExternalCommand,
  reconcilePromptWithTypedInput,
  type PromptDetectionResult,
} from "../autocomplete/promptDetector";
import { getCommandToRecordOnEnter } from "../autocomplete/terminalAutocompletePrompt";
import { shouldArmSudoPasswordAutofill } from "./terminalSudoAutofill";

type TerminalCommandExecutionContext = {
  host: Pick<Host, "id" | "label">;
  sessionId: string;
  onCommandExecuted?: (
    command: string,
    hostId: string,
    hostLabel: string,
    sessionId: string,
  ) => void;
  onCommandSubmitted?: (
    command: string,
    hostId: string,
    hostLabel: string,
    sessionId: string,
  ) => void;
  onTrustedCommandSubmitted?: (
    command: string,
    hostId: string,
    hostLabel: string,
    sessionId: string,
  ) => void;
  commandBufferRef: RefObject<string>;
  promptLineBreakStateRef?: RefObject<PromptLineBreakState>;
};

/** Bare omz/p10k glyph alone — detector often leaves cwd/git chrome in userInput. */
const isBareThemedTerminator = (promptText: string): boolean => {
  const trimmed = promptText.trim();
  if (trimmed.length !== 1) return false;
  const code = trimmed.charCodeAt(0);
  return /[❯❮→➜➤⟩»›]/.test(trimmed) || (code >= 0xE000 && code <= 0xF8FF);
};

/**
 * Read the full logical input after the prompt, including wrapped continuation
 * rows and text past the cursor (Enter submits the whole line, not the prefix).
 */
const readFullLineAfterPrompt = (
  term: XTerm,
  promptText: string,
): string | null => {
  if (!promptText) return null;
  try {
    const buffer = term.buffer.active;
    const cursorY = buffer.cursorY + buffer.baseY;
    let promptRow = cursorY;
    let line = buffer.getLine(promptRow);
    if (!line) return null;

    // Walk up through wrapped continuation rows to the prompt row.
    while (line.isWrapped && promptRow > 0) {
      promptRow -= 1;
      const prev = buffer.getLine(promptRow);
      if (!prev) return null;
      line = prev;
    }

    let combined = "";
    for (let row = promptRow; ; row += 1) {
      const rowLine = buffer.getLine(row);
      if (!rowLine) break;
      combined += rowLine.translateToString(false);
      const next = buffer.getLine(row + 1);
      if (!next?.isWrapped) break;
    }

    if (!combined.startsWith(promptText)) return null;
    return combined.slice(promptText.length).replace(/\s+$/g, "");
  } catch {
    return null;
  }
};

const readCurrentLogicalTerminalLine = (term?: XTerm | null): string => {
  if (!term) return "";
  try {
    const buffer = term.buffer.active;
    const cursorY = buffer.cursorY + buffer.baseY;
    let firstRow = cursorY;
    while (firstRow > 0 && buffer.getLine(firstRow)?.isWrapped) firstRow -= 1;
    let line = "";
    for (let row = firstRow; row <= cursorY; row += 1) {
      const bufferLine = buffer.getLine(row);
      if (!bufferLine) break;
      line += bufferLine.translateToString(false);
    }
    return line.slice(-8_192);
  } catch {
    return "";
  }
};

/**
 * detectPrompt truncates userInput at the cursor.
 *
 * Never absorb painted tails into the command when the keystroke buffer is
 * non-empty: zsh same-token autosuggest (`g` + paint `git status`) must stay
 * as `g`. Incomplete remote echo (keystrokes ahead of the line) may promote
 * the buffer into userInput. History that rewrote the line is handled later
 * via live-line comparison (#2191 review).
 */
const expandPromptUserInputToFullLine = (
  term: XTerm,
  prompt: PromptDetectionResult,
  typedBuffer: string,
): PromptDetectionResult => {
  if (!prompt.isAtPrompt || !prompt.promptText) return prompt;
  const buffered = typedBuffer.trim();
  if (!buffered) return prompt;

  // Incomplete echo: keystrokes ahead of what the line shows.
  // - visible "su", buffer "sudo" (same single word still typing)
  // - visible "su", buffer "su -" (more argv)
  // Not: visible "su", buffer "sudo whoami" (history may have shortened).
  if (
    prompt.userInput.length > 0
    && buffered.startsWith(prompt.userInput)
    && buffered.length > prompt.userInput.length
  ) {
    const next = buffered[prompt.userInput.length] ?? "";
    const singleWordEchoLag =
      !buffered.includes(" ")
      && /[\w@./:-]/.test(next);
    const moreArgsEchoLag = next === " " || next === "\t";
    if (singleWordEchoLag || moreArgsEchoLag) {
      return {
        ...prompt,
        userInput: buffered,
        cursorOffset: buffered.length,
      };
    }
  }

  return prompt;
};

/** Status / cwd chrome that must not be recorded as a submitted command. */
const isDecorationOnlyCommand = (command: string): boolean => {
  const t = command.trim();
  if (!t) return true;
  if (t === "~" || t.startsWith("~/")) return true;
  if (/^[✗✔+*!]$/.test(t)) return true;
  if (/^git:\([^)]*\)/.test(t)) return true;
  // "git:(main) ✗" leftovers after a partial cache strip
  if (/git:\([^)]*\)/.test(t) || /[✗✔]/.test(t)) {
    const stripped = t
      .replace(/git:\([^)]*\)/g, " ")
      .replace(/[✗✔+*!]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!stripped) return true;
    if (/^(?:su|sudo|doas)(?:\s|$)/i.test(stripped)) return false;
    if (!/\s/.test(stripped) && !/^(?:su|sudo|doas)$/i.test(stripped)) return true;
  }
  return false;
};

const hasThemedPromptMarker = (promptText: string): boolean => {
  if (isBareThemedTerminator(promptText)) return true;
  if (/[❯❮→➜➤⟩»›]/.test(promptText)) return true;
  for (const ch of promptText) {
    const code = ch.charCodeAt(0);
    if (code >= 0xE000 && code <= 0xF8FF) return true;
  }
  return false;
};

/**
 * When the prompt has no trailing space (`user@host:~$su -`), the detector
 * may not find a boundary. Fall back to the last known prompt prefix.
 */
const resolveFromCachedPromptPrefix = (
  term: XTerm,
  lastPromptText: string | undefined,
): string => {
  const cached = lastPromptText ?? "";
  if (!cached) return "";
  const fullInput = readFullLineAfterPrompt(term, cached)?.trim() ?? "";
  // Reject partial-cache leftovers like "git:(main) ✗" (#2191 review).
  if (!fullInput || isDecorationOnlyCommand(fullInput)) return "";
  return fullInput;
};

export const shouldRecordShellHistory = (
  command: string,
  term?: XTerm | null,
): boolean => {
  if (!term) return true;

  const trimmed = command.trim();
  const alignedResult = getAlignedPrompt(term, command, true);
  const prompt = expandPromptUserInputToFullLine(term, alignedResult.prompt, command);
  if (!prompt.isAtPrompt) return false;
  if (alignedResult.alignedTyped?.trim() === trimmed) return true;

  if (reconcilePromptWithExternalCommand(prompt, command)) return true;

  // History recall on themed prompts: live userInput still includes cwd/git
  // chrome, but reconcile can attribute it back to the prompt (#2191).
  if (trimmed) {
    const reconciled = reconcilePromptWithTypedInput(prompt, trimmed);
    if (reconciled !== prompt && reconciled.userInput.trim() === trimmed) {
      return true;
    }
  }

  const liveCommand = prompt.userInput.trim();
  if (liveCommand.length === 0) {
    return !isNonPromptLine(`${prompt.promptText}${trimmed}`);
  }
  if (liveCommand === trimmed) return true;

  // Themed multi-word / unicode dirs: resolver peels to "su -" but the raw
  // userInput is still " My Project su -". Accept trailing resolved commands
  // so password assist still arms (#2191 review).
  if (
    liveCommand === trimmed
    || liveCommand.endsWith(` ${trimmed}`)
    || liveCommand.endsWith(trimmed)
  ) {
    return true;
  }
  return false;
};

/** Common shell verbs that are commands, not themed directory names. */
const LOOKS_LIKE_SHELL_COMMAND_PREFIX =
  /^(?:echo|printf|ls|cd|pwd|cat|grep|find|sed|awk|vim|nvim|nano|git|npm|yarn|pnpm|node|python|pip|docker|make|curl|wget|ssh|scp|rsync|tar|zip|unzip|chmod|chown|cp|mv|rm|mkdir|touch|tail|head|less|more|man|which|type|alias|export|source|bash|zsh|fish|sh|env|ps|top|htop|kill|df|du|free|uname|whoami|id|date|clear|history|exit|logout|true|false|test|expr|seq|sleep|yes|nohup|time|env|sudo|su|doas)\b/i;

const CWD_NAME_COMMAND_COLLISION =
  /^(?:git|node|go|npm|yarn|pnpm|docker|src|app|bin|lib|test|tmp|home|user|root|www|html|dist|build|target|main|dev|prod|staging)$/i;

/** Path / git-status chrome that may sit between a glyph prompt and the command. */
const isPlausiblePathDecoration = (text: string): boolean => {
  const s = text.trim();
  if (!s) return true;
  if (s === "~" || s.startsWith("~/") || s.startsWith("/")) return true;
  // Privilege verbs in the prefix are never directory chrome.
  if (/\b(?:su|sudo|doas)\b/i.test(s)) return false;

  const words = s.split(/\s+/).filter(Boolean);
  // Any ordinary shell verb in the prefix means this is command text, not cwd
  // chrome — including after git-status markers (`git:(main) ✗ echo …`).
  for (const word of words) {
    const token = word.replace(/^git:\([^)]*\)$/i, "").replace(/[✗✔+*!]/g, "");
    if (!token) continue;
    if (
      LOOKS_LIKE_SHELL_COMMAND_PREFIX.test(token)
      && !CWD_NAME_COMMAND_COLLISION.test(token)
      && !/^[./~]/.test(token)
    ) {
      return false;
    }
  }

  // Pure git-status / status glyph chrome.
  if (/^git:\([^)]*\)/.test(s) || /^[✗✔+*!]+$/.test(s)) return true;
  if (words.every((w) => /^git:\([^)]*\)$/i.test(w) || /^[✗✔+*!]+$/.test(w))) {
    return true;
  }

  // Allow unicode letters and common path punctuation in directory names.
  return /^(?:[^\s\\]|[./~_()-])+(?:\s+(?:[^\s\\]|[./~_()-])+)*$/u.test(s);
};

/**
 * Recover a privilege command from a line with no space after the prompt marker
 * (`user@host:~$su -`) when prompt detection and lastPromptText both fail.
 */
const resolveNoSpacePromptPrivilegeCommand = (term: XTerm): string => {
  try {
    const buffer = term.buffer.active;
    const cursorY = buffer.cursorY + buffer.baseY;
    const line = buffer.getLine(cursorY);
    if (!line) return "";
    const raw = line.translateToString(false).replace(/\s+$/g, "");
    const match = raw.match(/^(.*?[$#%>])((?:sudo|su|doas)(?:\s.*)?)$/i);
    if (!match) return "";
    const command = match[2].trim();
    return shouldArmSudoPasswordAutofill(command) ? command : "";
  } catch {
    return "";
  }
};

/**
 * Peel themed cwd/git chrome from userInput.
 *
 * Prefer a trailing privilege command (su/sudo/doas) when the prefix looks like
 * path decoration — longest-prompt peel alone turns `❯  su -` into `-` and
 * `➜  My Project su -` into `Project su -` (#2191 review).
 */
const peelThemedCommandFromPrompt = (
  prompt: PromptDetectionResult,
): string => {
  const live = prompt.userInput;
  const trimmedStart = live.trimStart();
  if (!trimmedStart) return "";

  const privilegeMatch = trimmedStart.match(
    /(?:^|\s)((?:sudo|su|doas)(?:\s+.*)?)$/i,
  );
  if (privilegeMatch) {
    const command = privilegeMatch[1].trim();
    const before = trimmedStart
      .slice(0, trimmedStart.length - privilegeMatch[1].length)
      .trim();
    if (isPlausiblePathDecoration(before)) {
      return command;
    }
  }

  // Leading whitespace only: try path-prefix + trailing command before taking
  // the whole line (avoids ` My Project ls` → recording the directory too).
  const trimmed = live.trim();
  if (
    trimmed
    && live.endsWith(trimmed)
    && /^\s+$/.test(live.slice(0, live.length - trimmed.length))
  ) {
    const parts = trimmed.split(/\s+/).filter(Boolean);
    if (parts.length === 1 || shouldArmSudoPasswordAutofill(trimmed)) {
      return trimmed;
    }
    for (let i = 1; i < parts.length; i += 1) {
      const before = parts.slice(0, i).join(" ");
      const command = parts.slice(i).join(" ");
      if (!command || !isPlausiblePathDecoration(before)) continue;
      // Privilege after any path chrome, or ordinary commands only after a
      // multi-word / path-sigil directory (not `git status` → `status`).
      if (
        shouldArmSudoPasswordAutofill(command)
        || before.includes(" ")
        || before === "~"
        || before.startsWith("~/")
        || before.startsWith("/")
      ) {
        return command;
      }
    }
    return trimmed;
  }

  // Reconcile peel: prefer the longest command (avoid over-peeling to "-").
  let best: { command: string; length: number } | null = null;
  for (let start = 0; start < live.length; start += 1) {
    if (start > 0 && live[start - 1] !== " ") continue;
    const candidate = live.slice(start);
    if (!candidate.trim()) continue;
    const extra = live.slice(0, start);
    // Never treat privilege words as path chrome in the stripped prefix.
    if (/\b(?:su|sudo|doas)\b/i.test(extra)) continue;
    const reconciled = reconcilePromptWithTypedInput(prompt, candidate);
    if (reconciled === prompt || reconciled.userInput !== candidate) continue;
    const command = candidate.trim();
    if (!command) continue;
    if (!best || command.length > best.length) {
      best = { command, length: command.length };
    }
  }
  return best?.command ?? "";
};

/**
 * Read the command currently shown on the prompt line, stripping themed
 * prompt chrome (➜  ~ / git status decorations) when needed.
 *
 * lastPromptText is only trusted when the remainder reconciles against the
 * original detector split (avoids partial-cache pollution and over-peeling
 * a clean remainder down to "-"). Complete Powerline prompts keep the
 * detector's multiword userInput (#2191).
 */
export const resolveLiveSubmittedCommand = (
  prompt: PromptDetectionResult,
  lastPromptText?: string,
): string => {
  if (!prompt.isAtPrompt) return "";

  // Clean standard prompts (user@host:~$ su -).
  const direct = getCommandToRecordOnEnter(prompt, null, "", true);
  if (direct) return direct;

  // Cached full prompt first: handles space-containing dirs ("➜  My Project ")
  // before peel can mis-split on the path (#2191 review).
  const cachedPrompt = lastPromptText ?? "";
  if (cachedPrompt) {
    const fullLine = `${prompt.promptText}${prompt.userInput}`;
    if (fullLine.startsWith(cachedPrompt)) {
      const remainder = fullLine.slice(cachedPrompt.length).trim();
      if (remainder && !isDecorationOnlyCommand(remainder)) {
        if (prompt.userInput.endsWith(remainder)) {
          const reconciled = reconcilePromptWithTypedInput(prompt, remainder);
          if (reconciled !== prompt && reconciled.userInput.trim() === remainder) {
            return remainder;
          }
        }
        // Exact cache prefix on the rendered line (no-space / multi-word dirs).
        return remainder;
      }
    }
  }

  // Incomplete bare-glyph split (➜  + cwd/git in userInput): peel chrome.
  if (isBareThemedTerminator(prompt.promptText)) {
    const peeled = peelThemedCommandFromPrompt(prompt);
    if (peeled) return peeled;
  }

  // Themed prompts (including prefixed terminators like "⚡ ➜ "): peel cwd/path
  // chrome before accepting userInput (⚡ ➜  ~ su - → su -).
  if (hasThemedPromptMarker(prompt.promptText)) {
    const peeled = peelThemedCommandFromPrompt(prompt);
    if (peeled) return peeled;
  }

  // Complete Powerline / multi-glyph prompts may already isolate multiword
  // commands (sudo whoami) when peel has nothing left to strip.
  if (!isBareThemedTerminator(prompt.promptText)) {
    const liveTrimmed = prompt.userInput.trim();
    if (
      liveTrimmed
      && prompt.promptText.trim().length > 0
      && !isDecorationOnlyCommand(liveTrimmed)
    ) {
      const rawTokens = liveTrimmed.split(/\s+/).filter(Boolean);
      if (
        rawTokens.length <= 1
        && hasThemedPromptMarker(prompt.promptText)
        && !/^(?:su|sudo|doas)$/i.test(liveTrimmed)
      ) {
        return "";
      }
      return liveTrimmed;
    }
  }

  return peelThemedCommandFromPrompt(prompt);
};

/**
 * True when a live "command" is really empty-prompt chrome (cwd / git status)
 * left in userInput by the detector — not a history-recalled command.
 */
const isEmptyPromptDecoration = (
  live: string,
  prompt: PromptDetectionResult,
): boolean => {
  const command = live.trim();
  if (!command) return true;
  if (isDecorationOnlyCommand(command)) return true;

  // Bare glyph or multi-glyph themed prompts can leave a single cwd token.
  if (!hasThemedPromptMarker(prompt.promptText)) return false;

  const rawTokens = prompt.userInput.trim().split(/\s+/).filter(Boolean);
  if (rawTokens.length <= 1) {
    // Cwd chrome often keeps a trailing space after the directory token
    // (" git "). A real one-word history command usually has no trailing pad.
    if (/\s$/.test(prompt.userInput)) return true;
    // One-word history of su/sudo/doas (❯ su) with no trailing pad.
    if (/^(?:su|sudo|doas)$/i.test(command)) return false;
    return true;
  }

  return false;
};

/**
 * Resolve the command that Enter is submitting.
 *
 * The keystroke buffer alone is incomplete for shell history recall (↑/↓ /
 * Ctrl+R): those keys redraw the line remotely and never rewrite
 * commandBuffer. Prefer an aligned buffer when reliable; otherwise prefer
 * the live line when it disagrees with a stale prefix (#2191).
 */
export const resolveSubmittedShellCommand = (
  commandBuffer: string,
  term?: XTerm | null,
  lastPromptText?: string,
): string => {
  const buffered = commandBuffer.trim();
  if (!term) return buffered;

  const alignedResult = getAlignedPrompt(term, commandBuffer, true);

  // Expand only for incomplete echo (never same-token autosuggest paint).
  const prompt = expandPromptUserInputToFullLine(
    term,
    alignedResult.prompt,
    commandBuffer,
  );
  const liveFromCursor = prompt.isAtPrompt
    ? resolveLiveSubmittedCommand(prompt, lastPromptText)
    : "";

  // Full painted line (for history that rewrote past a stale typed prefix).
  // Only adopt it over the buffer when it is a privilege command the buffer
  // is not — autosuggest `g`→`git status` stays on the buffer.
  let liveFromFull = liveFromCursor;
  if (prompt.isAtPrompt && prompt.promptText) {
    const fullInput = readFullLineAfterPrompt(term, prompt.promptText);
    if (fullInput && fullInput !== prompt.userInput) {
      liveFromFull = resolveLiveSubmittedCommand(
        {
          ...prompt,
          userInput: fullInput,
          cursorOffset: fullInput.length,
        },
        lastPromptText,
      );
    }
  }

  const preferFullOverBuffer = (
    buffer: string,
    fullLive: string,
  ): boolean => {
    if (!fullLive || fullLive === buffer) return false;
    if (!fullLive.startsWith(buffer) || fullLive.length <= buffer.length) {
      return false;
    }
    // History to privilege command from a non-privilege typed prefix ("s"→"su -").
    return (
      shouldArmSudoPasswordAutofill(fullLive)
      && !shouldArmSudoPasswordAutofill(buffer)
    );
  };

  const aligned = alignedResult.alignedTyped?.trim() ?? "";
  // Aligned buffer can match a stale mid-line prefix after history recall
  // (typed "s", recalled "su -", cursor after "s"), or only a suffix when
  // history prepended text (typed "whoami", recalled "sudo whoami").
  if (aligned) {
    if (preferFullOverBuffer(aligned, liveFromFull)) {
      return liveFromFull;
    }
    if (
      liveFromCursor
      && liveFromCursor.length > aligned.length
      && (
        liveFromCursor.startsWith(aligned)
        || liveFromCursor.endsWith(aligned)
        || liveFromCursor.endsWith(` ${aligned}`)
      )
    ) {
      return liveFromCursor;
    }
    return aligned;
  }

  if (!prompt.isAtPrompt) {
    // No-space prompts (`user@host:~$su -`) often fail boundary detection;
    // recover via the last fully-detected prompt prefix, then a direct
    // privilege-command scan for the first history recall before any cache.
    if (!buffered) {
      return (
        resolveFromCachedPromptPrefix(term, lastPromptText)
        || resolveNoSpacePromptPrivilegeCommand(term)
      );
    }
    return buffered;
  }

  const live = liveFromCursor;
  if (!buffered) {
    // Empty buffer: submitted text is the painted command (history at EOL or
    // mid-line). Keystroke autosuggest always leaves a non-empty buffer.
    const emptyLive = liveFromFull || live;
    if (!emptyLive || isEmptyPromptDecoration(emptyLive, prompt)) {
      return resolveFromCachedPromptPrefix(term, lastPromptText);
    }
    return emptyLive;
  }
  if (preferFullOverBuffer(buffered, liveFromFull)) {
    return liveFromFull;
  }
  if (!live || live === buffered) return buffered || live;

  // Direct send / incomplete echo: keystroke buffer is the real command even
  // when the themed line still only shows decoration (➜  netcatty  + "ls").
  if (reconcilePromptWithExternalCommand(prompt, buffered)) {
    return buffered;
  }

  // History / reverse-search replaced a typed prefix (buffer "s", live "su -").
  if (live.startsWith(buffered) && live.length > buffered.length) {
    return live;
  }
  if (preferFullOverBuffer(buffered, liveFromFull)) {
    return liveFromFull;
  }

  // Echo lag: live is a visible prefix of what the user typed.
  // - "su" + buffer "su -" → same command, more argv → buffer
  // - "su" + buffer "sudo" → incomplete echo of the same word → buffer
  // - "su" + buffer "sudo whoami" → history shortened the line → live
  if (buffered.startsWith(live) && buffered.length > live.length) {
    const next = buffered[live.length] ?? "";
    if (next === " " || next === "" || live.length === 0) {
      return buffered;
    }
    const liveFirst = live.split(/\s+/)[0] ?? "";
    const bufFirst = buffered.split(/\s+/)[0] ?? "";
    // Single-word buffer still extending the echoed prefix: trust keystrokes.
    if (
      !buffered.includes(" ")
      && bufFirst.startsWith(liveFirst)
      && bufFirst !== liveFirst
    ) {
      return buffered;
    }
    // Multi-word typed buffer vs shorter live command: history replaced it.
    return live;
  }

  // Live ends with the typed buffer: either path chrome + typed command
  // ("Project su -" + "su -") or history that grew leftward ("sudo whoami"
  // after typing "whoami"). Prefer live for sudo/su wrappers; else buffer.
  if (live.endsWith(buffered) || live.endsWith(` ${buffered}`)) {
    if (
      live !== buffered
      && /^(?:sudo|su|doas|command|builtin)\s/i.test(live)
    ) {
      return live;
    }
    return buffered;
  }

  // Completely different commands: trust the live line (history replaced it).
  return live;
};

export const recordTerminalCommandExecution = (
  command: string,
  ctx: TerminalCommandExecutionContext,
  term?: XTerm | null,
  options?: { sensitive?: boolean; allowHostStyleGreaterThanPrompt?: boolean },
): string | null => {
  if (options?.sensitive || isSensitiveTerminalChallenge(readCurrentLogicalTerminalLine(term))) {
    ctx.commandBufferRef.current = "";
    return null;
  }
  const lastPromptText = ctx.promptLineBreakStateRef?.current?.lastPromptText;
  const cmd = resolveSubmittedShellCommand(command, term, lastPromptText);
  if (cmd) {
    ctx.onCommandSubmitted?.(cmd, ctx.host.id, ctx.host.label, ctx.sessionId);
  }
  const trustedPrompt = isTrustedTerminalShellSubmission(
    command,
    term,
    options?.allowHostStyleGreaterThanPrompt,
  );
  if (cmd && shouldRecordShellHistory(cmd, term)) {
    if (trustedPrompt) {
      ctx.onTrustedCommandSubmitted?.(cmd, ctx.host.id, ctx.host.label, ctx.sessionId);
    }
    ctx.onCommandExecuted?.(cmd, ctx.host.id, ctx.host.label, ctx.sessionId);
    ctx.commandBufferRef.current = "";
    markPromptLineBreakCommandPending(ctx.promptLineBreakStateRef, term, cmd);
    return cmd;
  }
  ctx.commandBufferRef.current = "";
  markPromptLineBreakCommandPending(ctx.promptLineBreakStateRef, term, cmd || command);
  return null;
};

export const isTrustedTerminalShellSubmission = (
  command: string,
  term?: XTerm | null,
  allowHostStyleGreaterThanPrompt?: boolean,
): boolean => {
  if (!term) return false;
  const alignedPrompt = getAlignedPrompt(term, command, true).prompt;
  return Boolean(
    alignedPrompt.isAtPrompt
    && isConfirmedTerminalShellPrompt(alignedPrompt.promptText, {
      allowHostStyleGreaterThan: allowHostStyleGreaterThanPrompt,
    }),
  );
};
