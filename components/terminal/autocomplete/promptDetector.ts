/**
 * Prompt detector for terminal autocomplete.
 * Detects whether the user is currently at a shell prompt (vs. inside a running program).
 * Uses xterm.js buffer analysis to identify common prompt patterns.
 *
 * Strategy: scan prompt-looking boundaries ($ # % >, Powerline/Nerd Font glyphs,
 * etc.) and choose the most reliable split for prompt text vs. user input.
 */

import type { Terminal as XTerm } from "@xterm/xterm";
import { COMMON_SHELL_COMMANDS, NON_PROMPT_PATTERNS, PROMPT_CHARS } from "./promptDetectorPatterns";

export interface PromptDetectionResult {
  /** Whether a prompt is detected on the current line */
  isAtPrompt: boolean;
  /** The detected prompt text (everything before user input) */
  promptText: string;
  /** The user's current input (after the prompt) */
  userInput: string;
  /** The cursor column position within the user input */
  cursorOffset: number;
}

const NO_PROMPT: PromptDetectionResult = {
  isAtPrompt: false, promptText: "", userInput: "", cursorOffset: 0,
};

export function isNonPromptLine(lineText: string): boolean {
  return NON_PROMPT_PATTERNS.some((pattern) => pattern.test(lineText));
}

function isSpecificShellPromptCandidate(
  promptText: string,
  options: { allowGreaterThanTerminator?: boolean } = {},
): boolean {
  const trimmed = promptText.trim();
  if (
    !options.allowGreaterThanTerminator &&
    (trimmed.endsWith(">") || trimmed.endsWith("›"))
  ) {
    return false;
  }
  return trimmed.length >= 6 && /[@:\\/~\])]/.test(trimmed);
}

function isLikelyNoSpaceShellPromptText(promptText: string): boolean {
  const trimmed = promptText.trim();
  if (/^root[#%$]$/.test(trimmed)) return true;
  if (trimmed.length < 3) return false;

  const marker = trimmed[trimmed.length - 1];
  if (!PROMPT_CHARS.has(marker) && !isPuaChar(marker)) return false;

  const prev = trimmed[trimmed.length - 2] ?? "";
  return /[~:/\\\])]/.test(prev);
}

export interface AlignedPromptResult {
  /** The prompt view every consumer should use for parsing / suggestion lookup / line rewrites. */
  prompt: PromptDetectionResult;
  /**
   * The keystroke buffer, but only when it's both marked reliable AND
   * can be validated against the live terminal line. Returns null
   * otherwise - the single signal downstream uses to decide whether
   * to record it as the executed command.
   */
  alignedTyped: string | null;
}

function getCursorLinePrefix(term: XTerm): string | null {
  const buffer = term.buffer.active;
  const cursorY = buffer.cursorY + buffer.baseY;
  const line = buffer.getLine(cursorY);

  if (!line) return null;

  return line.translateToString(false).substring(0, Math.max(0, buffer.cursorX));
}

function getWrappedCursorPrefix(term: XTerm): string | null {
  const buffer = term.buffer.active;
  const cursorY = buffer.cursorY + buffer.baseY;
  const cursorX = buffer.cursorX;
  const line = buffer.getLine(cursorY);

  if (!line?.isWrapped) return null;

  let promptRow = cursorY - 1;
  while (promptRow >= 0) {
    const prevLine = buffer.getLine(promptRow);
    if (!prevLine) return null;
    if (!prevLine.isWrapped) break;
    promptRow--;
  }

  const promptLine = buffer.getLine(promptRow);
  if (!promptLine) return null;

  let prefix = promptLine.translateToString(false);
  for (let row = promptRow + 1; row < cursorY; row++) {
    const rowLine = buffer.getLine(row);
    if (!rowLine) return null;
    prefix += rowLine.translateToString(false);
  }

  return prefix + line.translateToString(false).substring(0, Math.max(0, cursorX));
}

function inferPromptTextBeforeTypedInput(
  cursorPrefix: string,
  typedBuffer: string,
  allowPartialEcho: boolean,
): string | null {
  if (cursorPrefix.endsWith(typedBuffer)) {
    const promptText = cursorPrefix.slice(0, cursorPrefix.length - typedBuffer.length);
    return promptText.length > 0 ? promptText : null;
  }

  if (!allowPartialEcho) return null;

  const maxEchoLength = Math.min(cursorPrefix.length, typedBuffer.length);
  const minPartialEchoLength = Math.max(6, typedBuffer.length - 2);
  for (let echoLength = maxEchoLength - 1; echoLength >= minPartialEchoLength; echoLength--) {
    const echoedInput = typedBuffer.slice(0, echoLength);
    if (!cursorPrefix.endsWith(echoedInput)) continue;

    const promptText = cursorPrefix.slice(0, cursorPrefix.length - echoLength);
    if (promptText.length > 0) return promptText;
  }

  const noSpacePromptMinEchoLength = typedBuffer.trim().length <= 2 ? 1 : 3;
  for (
    let echoLength = Math.min(maxEchoLength - 1, minPartialEchoLength - 1);
    echoLength >= noSpacePromptMinEchoLength;
    echoLength--
  ) {
    const echoedInput = typedBuffer.slice(0, echoLength);
    if (!cursorPrefix.endsWith(echoedInput)) continue;
    const hasReliablePartialEcho =
      typedBuffer.trim().length <= 2 ||
      echoedInput.endsWith(" ") ||
      (echoedInput.includes(" ") && echoedInput.length >= 4);
    if (!hasReliablePartialEcho) continue;

    const promptText = cursorPrefix.slice(0, cursorPrefix.length - echoLength);
    if (isLikelyNoSpaceShellPromptText(promptText)) return promptText;
  }

  return null;
}

function hasSwallowedCommandAfterPrompt(promptText: string, promptBoundary: number): boolean {
  const candidate = promptText.slice(0, promptBoundary).trimEnd();
  const finalIndex = candidate.length - 1;
  const finalChar = finalIndex >= 0 ? candidate[finalIndex] : "";

  for (let i = 0; i < finalIndex; i++) {
    const ch = candidate[i];
    if (!PROMPT_CHARS.has(ch) && !isPuaChar(ch)) continue;

    const nextChar = i + 1 < candidate.length ? candidate[i + 1] : null;
    if (nextChar === null || nextChar === " ") continue;

    const earlierPrompt = candidate.slice(0, i + 1);
    if (isLikelyNoSpaceShellPromptText(earlierPrompt)) return true;
    if (isEmbeddedPromptMarkerAt(candidate, i)) continue;
    if (!isSpecificShellPromptCandidate(earlierPrompt)) continue;
    if (PROMPT_CHARS.has(nextChar) || isPuaChar(nextChar)) return true;
    if (startsWithCommonShellCommand(candidate.slice(i + 1))) return true;
    if (finalChar !== "$") return true;
  }

  return false;
}

function canUseInferredPromptText(promptText: string, rawIsAtPrompt: boolean): boolean {
  if (promptText.length === 0) return false;
  if (rawIsAtPrompt) return true;

  const promptBoundary = findPromptBoundary(promptText);
  const promptEndsAtBoundary =
    promptBoundary >= 0 && promptText.slice(promptBoundary).trim().length === 0;
  return (
    promptEndsAtBoundary &&
    !hasSwallowedCommandAfterPrompt(promptText, promptBoundary) &&
    isSpecificShellPromptCandidate(promptText)
  );
}

function isThemedPromptText(promptText: string): boolean {
  for (const ch of promptText) {
    if (isPuaChar(ch)) return true;
  }
  return /[❯❮→➜➤⟩»›]/.test(promptText);
}

function isPromptPathDecoration(trimmed: string): boolean {
  return (
    trimmed === "~" ||
    trimmed.startsWith("~/") ||
    trimmed.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(trimmed) ||
    trimmed.includes("\\")
  );
}

function isPromptBareDirectoryText(trimmed: string): boolean {
  if (trimmed.startsWith("./") || trimmed.startsWith("../")) return false;
  return /^[\w.-]+$/.test(trimmed);
}

function isPromptStatusToken(token: string): boolean {
  return (
    /^git:\([^)]*\)$/.test(token) ||
    /^[+$#%>!?*]$/.test(token) ||
    token === "✗" ||
    token === "✔"
  );
}

function isPromptStatusText(trimmed: string): boolean {
  const [first = "", ...rest] = trimmed.split(/\s+/);
  if (rest.length === 0) return false;
  if (!isPromptBareDirectoryText(first) && !isPromptPathDecoration(first)) return false;
  return rest.every(isPromptStatusToken);
}

function isPromptStatusDecoration(extra: string): boolean {
  if (!/^\s+/.test(extra) || !/\s+$/.test(extra)) return false;

  return isPromptStatusText(extra.trim());
}

function isPromptDecorationExtra(extra: string, promptText: string): boolean {
  const trimmed = extra.trim();
  if (trimmed.length === 0) return false;
  if (!isThemedPromptText(promptText)) return false;
  if (startsWithCommonShellCommand(extra)) return false;
  if (/^\s*\S+\s+$/.test(extra)) {
    return isPromptPathDecoration(trimmed) || (
      isPromptBareDirectoryText(trimmed) &&
      !startsWithCommonShellCommand(trimmed)
    );
  }
  if (isPromptStatusDecoration(extra)) return true;
  for (const ch of extra) {
    if (isPuaChar(ch)) return true;
  }
  return false;
}

function getFinalPromptBoundary(promptText: string): number {
  const trimmedEnd = promptText.trimEnd().length;
  if (trimmedEnd === 0) return -1;

  const markerIndex = trimmedEnd - 1;
  const marker = promptText[markerIndex];
  if (!PROMPT_CHARS.has(marker) && !isPuaChar(marker)) return -1;

  const nextChar = markerIndex + 1 < promptText.length ? promptText[markerIndex + 1] : null;
  if (nextChar !== null && nextChar !== " ") return -1;
  return nextChar === " " ? markerIndex + 2 : markerIndex + 1;
}

function endsAtFinalPromptBoundary(promptText: string): boolean {
  const promptBoundary = getFinalPromptBoundary(promptText);
  return promptBoundary >= 0 && promptText.slice(promptBoundary).trim().length === 0;
}

function getLeadingShellCommandWord(text: string): string | null {
  return text.trimStart().match(/^[\w.-]+(?=\s|$)/)?.[0] ?? null;
}

function startsWithCommonShellCommand(text: string): boolean {
  const command = getLeadingShellCommandWord(text);
  return command !== null && COMMON_SHELL_COMMANDS.has(command);
}

function isCompleteSpecificPrompt(promptText: string): boolean {
  const promptBoundary = getFinalPromptBoundary(promptText);
  return (
    promptBoundary >= 0 &&
    promptText.slice(promptBoundary).trim().length === 0 &&
    isSpecificShellPromptCandidate(promptText) &&
    !isEmbeddedPromptMarker(promptText, promptBoundary)
  );
}

function looksLikeCommandAfterCompletePrompt(promptText: string, extra: string): boolean {
  return isCompleteSpecificPrompt(promptText) && extra.trim().length > 0;
}

function hasShellCommandAfterOptionalDecoration(text: string): boolean {
  const trimmedStart = text.trimStart();
  if (startsWithCommonShellCommand(trimmedStart)) return true;

  const [, afterDecoration = ""] = trimmedStart.match(/^\S+\s+(.+)$/) ?? [];
  return startsWithCommonShellCommand(afterDecoration);
}

function isSingleBareDirectoryExtra(extra: string): boolean {
  const trimmed = extra.trim();
  return /^\s*\S+\s+$/.test(extra) && isPromptBareDirectoryText(trimmed);
}

function hasExplicitThemedDirectorySpacing(extra: string): boolean {
  return /^\s+\S+\s+$/.test(extra);
}

type PromptDecorationReconcileOptions = {
  allowSingleWordCommandDirectory?: boolean;
};

function canTreatCommonCommandNameAsThemedDirectory(
  extra: string,
  typedInput: string,
  options: PromptDecorationReconcileOptions = {},
): boolean {
  const trimmedInput = typedInput.trim();
  return (
    isSingleBareDirectoryExtra(extra) &&
    (
      /\s/.test(trimmedInput) ||
      /^(?:ls|cd|pwd)$/.test(trimmedInput) ||
      (
        options.allowSingleWordCommandDirectory === true &&
        hasExplicitThemedDirectorySpacing(extra)
      )
    )
  );
}

function canReconcilePromptDecoration(
  prompt: PromptDetectionResult,
  typedInput: string,
  options: PromptDecorationReconcileOptions = {},
): boolean {
  if (
    !prompt.isAtPrompt ||
    !typedInput ||
    prompt.userInput.length <= typedInput.length ||
    !prompt.userInput.endsWith(typedInput)
  ) {
    return false;
  }

  const extra = prompt.userInput.slice(0, prompt.userInput.length - typedInput.length);
  if (looksLikeCommandAfterCompletePrompt(prompt.promptText, extra)) return false;
  if (
    isThemedPromptText(prompt.promptText) &&
    canTreatCommonCommandNameAsThemedDirectory(extra, typedInput, options)
  ) {
    return true;
  }
  if (isThemedPromptText(prompt.promptText) && hasShellCommandAfterOptionalDecoration(extra)) {
    return false;
  }

  const candidatePromptText = prompt.promptText + extra;
  const promptEndsAtBoundary =
    endsAtFinalPromptBoundary(candidatePromptText) &&
    isSpecificShellPromptCandidate(candidatePromptText);
  return promptEndsAtBoundary || isPromptDecorationExtra(extra, prompt.promptText);
}

function alignTypedInputFromCursorPrefix(
  raw: PromptDetectionResult,
  cursorPrefix: string | null,
  typedBuffer: string,
): AlignedPromptResult | null {
  if (!cursorPrefix) return null;
  if (!raw.isAtPrompt && isNonPromptLine(cursorPrefix)) return null;

  const promptText = inferPromptTextBeforeTypedInput(cursorPrefix, typedBuffer, !raw.isAtPrompt);
  if (!promptText || !canUseInferredPromptText(promptText, raw.isAtPrompt)) {
    return null;
  }

  return {
    prompt: {
      isAtPrompt: true,
      promptText,
      userInput: typedBuffer,
      cursorOffset: typedBuffer.length,
    },
    alignedTyped: typedBuffer,
  };
}

function canUseReliablePromptPrefix(
  raw: PromptDetectionResult,
  typedBuffer: string,
): boolean {
  if (!raw.isAtPrompt || typedBuffer.length === 0 || raw.userInput.length === 0) {
    return false;
  }
  if (typedBuffer.length <= raw.userInput.length) return false;
  return isReliableTypedPrefix(raw.userInput, typedBuffer, {
    allowShortEcho: allowsShortPromptEcho(raw.promptText),
  });
}

function isLikelyBareMongoPromptName(promptName: string): boolean {
  return /^(?:test|admin|local|config)$/i.test(promptName);
}

function endsWithHostStyleGreaterThanPrompt(promptText: string): boolean {
  const trimmed = promptText.trimEnd();
  if (!trimmed.endsWith(">")) return false;
  const promptName = trimmed.slice(0, -1).trim();
  return /^[\w.-]+$/.test(promptName) && !isLikelyBareMongoPromptName(promptName);
}

function endsWithStandardShellPrompt(promptText: string): boolean {
  const finalChar = promptText.trimEnd().at(-1);
  return finalChar === "$" || finalChar === "#" || finalChar === "%";
}

function allowsShortPromptEcho(promptText: string): boolean {
  return endsWithStandardShellPrompt(promptText) || endsWithHostStyleGreaterThanPrompt(promptText);
}

function isReliableTypedPrefix(
  echoedInput: string,
  typedBuffer: string,
  options: { allowShortEcho?: boolean } = {},
): boolean {
  if (!typedBuffer.startsWith(echoedInput)) return false;
  if (
    options.allowShortEcho &&
    typedBuffer.trim().length <= 2 &&
    echoedInput.trim().length >= 1
  ) {
    return true;
  }
  return (
    echoedInput.length >= Math.max(4, typedBuffer.length - 2) ||
    (echoedInput.endsWith(" ") && echoedInput.trim().length >= 2) ||
    (echoedInput.includes(" ") && echoedInput.length >= 4)
  );
}

function withTypedUserInput(
  prompt: PromptDetectionResult,
  typedBuffer: string,
): PromptDetectionResult {
  return {
    ...prompt,
    userInput: typedBuffer,
    cursorOffset: typedBuffer.length,
  };
}

function alignThemedDecorationWithPartialEcho(
  raw: PromptDetectionResult,
  typedBuffer: string,
): AlignedPromptResult | null {
  if (!raw.isAtPrompt || !isThemedPromptText(raw.promptText)) return null;

  const maxEchoLength = Math.min(raw.userInput.length, typedBuffer.length);
  for (let echoLength = maxEchoLength; echoLength > 0; echoLength--) {
    const echoedInput = typedBuffer.slice(0, echoLength);
    if (!raw.userInput.endsWith(echoedInput)) continue;

    const extra = raw.userInput.slice(0, raw.userInput.length - echoLength);
    if (extra.length === 0) continue;
    const hasReliableThemedDirectoryPrefix =
      isSingleBareDirectoryExtra(extra) &&
      hasExplicitThemedDirectorySpacing(extra) &&
      typedBuffer.trim().length <= 3 &&
      echoedInput.trim().length >= 1;

    const syntheticPrompt = {
      ...raw,
      userInput: extra + typedBuffer,
      cursorOffset: extra.length + typedBuffer.length,
    };
    if (
      !hasReliableThemedDirectoryPrefix &&
      !isReliableTypedPrefix(echoedInput, typedBuffer)
    ) {
      continue;
    }
    if (!canReconcilePromptDecoration(syntheticPrompt, typedBuffer, {
      allowSingleWordCommandDirectory: true,
    })) continue;

    return {
      prompt: {
        isAtPrompt: true,
        promptText: raw.promptText + extra,
        userInput: typedBuffer,
        cursorOffset: typedBuffer.length,
      },
      alignedTyped: typedBuffer,
    };
  }

  return null;
}

/**
 * Detect whether the terminal cursor is at a shell prompt and extract the current user input.
 */
export function detectPrompt(term: XTerm): PromptDetectionResult {
  const buffer = term.buffer.active;
  const cursorY = buffer.cursorY + buffer.baseY;
  const cursorX = buffer.cursorX;
  const line = buffer.getLine(cursorY);

  if (!line) return NO_PROMPT;

  // translateToString(false) preserves trailing spaces — important for cursor-based
  // input extraction (trailing space triggers empty token for option suggestions)
  const lineText = line.translateToString(false);

  // Check for non-prompt patterns (pagers, editors, etc.)
  if (isNonPromptLine(lineText)) return NO_PROMPT;
  if (line.isWrapped) {
    const wrappedPrefix = getWrappedCursorPrefix(term);
    if (wrappedPrefix && isNonPromptLine(wrappedPrefix)) return NO_PROMPT;
  }

  // Empty line
  if (lineText.trim().length === 0) return NO_PROMPT;

  const cursorLinePrefix = lineText.substring(0, Math.max(0, cursorX));
  // Try to find the prompt boundary on the current line. xterm buffer rows are
  // padded with blank cells; when the cursor is at the visible row end, scan
  // only up to the cursor so prompts like "root@host:~#" do not inherit a fake
  // trailing space. If there is command text to the right of the cursor, keep
  // the full line so "$" / ">" inside mid-line edits are validated against
  // their real following character.
  const promptScanText = lineText.slice(Math.max(0, cursorX)).trim().length > 0
    ? lineText
    : cursorLinePrefix;
  const promptEnd = findPromptBoundary(promptScanText);
  if (promptEnd >= 0) {
    const promptText = lineText.substring(0, promptEnd);
    // Use cursor position to determine actual input length — don't trim trailing
    // spaces since they're significant for autocomplete (e.g., "git commit " should
    // produce an empty trailing token to trigger option suggestions).
    const rawInput = lineText.substring(promptEnd);
    const userInput = rawInput.substring(0, Math.max(0, cursorX - promptEnd));
    const cursorOffset = Math.max(0, cursorX - promptEnd);

    return { isAtPrompt: true, promptText, userInput, cursorOffset };
  }

  // Handle wrapped lines: if the prompt is on a previous row (e.g., long path or
  // long command wrapped onto multiple rows), look upward for the prompt line.
  // The current row's content is continuation of the command.
  if (line.isWrapped) {
    // Walk up to find the first non-wrapped line (the prompt line)
    let promptRow = cursorY - 1;
    while (promptRow >= 0) {
      const prevLine = buffer.getLine(promptRow);
      if (!prevLine) break;
      if (!prevLine.isWrapped) break;
      promptRow--;
    }

    const promptLine = buffer.getLine(promptRow);
    if (promptLine) {
      const promptLineText = promptLine.translateToString(false);
      if (isNonPromptLine(promptLineText)) return NO_PROMPT;
      const pEnd = findPromptBoundary(promptLineText);
      if (pEnd >= 0) {
        const promptText = promptLineText.substring(0, pEnd);
        // Concatenate all rows from promptRow to cursorY to get full input
        let fullInput = promptLineText.substring(pEnd);
        for (let row = promptRow + 1; row <= cursorY; row++) {
          const rowLine = buffer.getLine(row);
          if (rowLine) fullInput += rowLine.translateToString(false);
        }
        // Trim to cursor position on the last row
        const totalCols = term.cols;
        const charsBeforeCursorRow = (cursorY - promptRow) * totalCols - pEnd;
        const userInput = fullInput.substring(0, charsBeforeCursorRow + cursorX);
        const cursorOffset = userInput.length;
        if (isNonPromptLine(promptText + userInput)) return NO_PROMPT;

        return { isAtPrompt: true, promptText, userInput, cursorOffset };
      }
    }
  }

  return NO_PROMPT;
}

/**
 * Whether a character lives in the Unicode Private Use Area (U+E000–U+F8FF).
 * Powerline separators (U+E0B0..) and Nerd Font icons (U+E200.., U+F000..) all
 * fall here. A PUA char followed by a space is common in themed prompt
 * terminators (oh-my-posh, starship, p10k, etc.), but commands can still echo
 * those glyphs, so PUA boundaries are kept lower priority than standard prompt
 * characters and reconciled with the typed buffer when available.
 */
function isPuaChar(ch: string): boolean {
  if (!ch) return false;
  const code = ch.charCodeAt(0);
  return code >= 0xE000 && code <= 0xF8FF;
}

function getBoundaryMarkerIndex(lineText: string, boundary: number): number {
  if (boundary <= 0) return -1;
  return lineText[boundary - 1] === " " ? boundary - 2 : boundary - 1;
}

function isEmbeddedPromptMarkerAt(lineText: string, markerIndex: number): boolean {
  if (markerIndex <= 0) return false;

  const marker = lineText[markerIndex];
  if (marker !== "#" && marker !== "%" && marker !== ">" && marker !== "$") return false;

  const prev = lineText[markerIndex - 1];
  return !/[\s~:\])}]/.test(prev);
}

function isEmbeddedPromptMarker(lineText: string, boundary: number): boolean {
  return isEmbeddedPromptMarkerAt(lineText, getBoundaryMarkerIndex(lineText, boundary));
}

function canSupersedeThemedPromptBoundary(
  lineText: string,
  previousBoundary: number,
  markerIndex: number,
): boolean {
  if (!isThemedPromptText(lineText.slice(0, previousBoundary))) return false;

  const rawBetween = lineText.slice(previousBoundary, markerIndex);
  const between = rawBetween.trim();
  return (
    between.length === 0 ||
    isPromptPathDecoration(between) ||
    isPromptStatusText(between) ||
    (
      /^\s/.test(rawBetween) &&
      isPromptBareDirectoryText(between)
    )
  );
}

function canPromptMarkerSupersedePreviousBoundary(ch: string): boolean {
  return ch === "$" || ch === "#" || ch === "%" || ch === ">" || ch === "›";
}

function isSpacedPromptSegment(lineText: string, boundary: number): boolean {
  const markerIndex = getBoundaryMarkerIndex(lineText, boundary);
  if (markerIndex <= 0) return false;
  if (lineText[markerIndex - 1] !== " ") return false;
  return lineText[markerIndex + 1] === " ";
}

/**
 * Find the boundary between prompt and user input.
 * Scans left-to-right within the first 200 chars for a prompt character followed by space.
 * Avoids false positives: $VAR, $(...), ${...} are not prompt endings.
 * Returns the character index where user input begins, or -1 if no prompt detected.
 */
function findPromptBoundary(lineText: string): number {
  // Scan for prompt boundary. Take the LAST candidate.
  // For ambiguous chars like >, limit scan to first 60% to avoid matching redirections.
  // For unambiguous prompt chars ($, #), scan the full line since they're rarely
  // confused with shell syntax in a prompt position.
  const lineLen = lineText.trimEnd().length;
  const scanLimit = Math.min(lineLen, 200);
  let lastStandardBoundary = -1;
  let lastPuaBoundary = -1;

  // Ambiguous chars (>) only scan first 60% to avoid matching redirections
  const ambiguousScanLimit = Math.min(scanLimit, Math.max(40, Math.floor(lineLen * 0.6)));

  for (let i = 0; i < scanLimit; i++) {
    const ch = lineText[i];
    const isStandard = PROMPT_CHARS.has(ch);
    const isPua = !isStandard && isPuaChar(ch);

    if (!isStandard && !isPua) continue;

    // For ambiguous prompt chars like >, only accept in the first 60% of the line
    if ((ch === ">" || ch === "›") && i >= ambiguousScanLimit) continue;
    if (
      (ch === ">" || ch === "›") &&
      lastStandardBoundary >= 0 &&
      /\s/.test(lineText.slice(0, i).trim()) &&
      !isEmbeddedPromptMarker(lineText, lastStandardBoundary) &&
      !canSupersedeThemedPromptBoundary(lineText, lastStandardBoundary, i)
    ) {
      continue;
    }

    // Must be followed by a space or end-of-line.
    const nextChar = i + 1 < lineText.length ? lineText[i + 1] : null;
    if (nextChar !== null && nextChar !== " ") {
      // Special case: cmd.exe prompt `C:\path>command` — allow > without space
      // only if preceded by a path-like pattern (drive letter or backslash)
      if (ch === ">" && i > 1 && (lineText[i - 1] === "\\" || lineText[i - 1] === "/" || /^[A-Za-z]:/.test(lineText))) {
        // Looks like a path ending — accept as prompt
      } else {
        continue;
      }
    }

    // For '$': exclude shell variable references ($HOME, $PATH, ${...}, $(...))
    if (ch === "$") {
      // Check what comes AFTER the space — but more importantly check what
      // comes BEFORE to see if this looks like a prompt ending vs mid-command $.
      // A prompt $ is typically preceded by: space, ), ], digit, username chars, or is at position 0.
      // A variable $ is typically inside a command: echo $HOME, export PATH=$PATH:...
      //
      // Heuristic: if the $ is preceded by a letter/digit/underscore without a space before it
      // (i.e., it's part of a token like "echo" or "=$PATH"), it's likely a variable.
      if (i > 0) {
        const prev = lineText[i - 1];
        // If preceded by = or / or another non-separator, it's a variable reference
        if (prev === "=" || prev === "/" || prev === ":") continue;
        // If preceded by a letter and there's no space between, it could be $HOME-style
        // But actually: "user@host:~$ " has letter before $. So check if there's
        // a valid prompt pattern before the $.
      }

      // Check what follows: if after "$ " there's more content with $ in variable positions
      // Actually the simplest reliable check: if the character after the space is alphanumeric
      // or $ or (, this is likely the START of a command (i.e., this $ IS the prompt ending).
      // That's always true for a prompt. So the $ check is really about false positives mid-line.
      //
      // Better heuristic: if we haven't seen a space before this $ (meaning the $ is inside
      // the first token), it's likely a prompt. If we've already passed spaces (meaning
      // we're past the first "word"), a $ is more likely a variable.
      let seenSpaceBeforeDollar = false;
      for (let j = 0; j < i; j++) {
        if (lineText[j] === " ") { seenSpaceBeforeDollar = true; break; }
      }
      // If there was a space before this $, it might be mid-command (like "echo $HOME")
      // Only accept if the $ is reasonably close to common prompt patterns
      if (seenSpaceBeforeDollar) {
        // Check if this looks like a bracketed prompt ending: "]$ " or ")$ "
        if (i > 0 && (lineText[i - 1] === "]" || lineText[i - 1] === ")" ||
            lineText[i - 1] === " " || lineText[i - 1] === "~")) {
          // Likely a prompt ending like [user@host ~]$
        } else {
          continue; // Skip — likely a variable reference mid-command
        }
      }
    }

    // Record this as a candidate boundary. A standard shell prompt terminator
    // is more reliable than a later Powerline/Nerd Font glyph in command text.
    const boundary = nextChar === " " ? i + 2 : i + 1;
    const candidatePromptText = lineText.slice(0, boundary);
    if (isStandard && hasSwallowedCommandAfterPrompt(candidatePromptText, boundary)) {
      continue;
    }
    if (isStandard && lastStandardBoundary >= 0) {
      const themedPromptCanSupersede = canSupersedeThemedPromptBoundary(
        lineText,
        lastStandardBoundary,
        getBoundaryMarkerIndex(lineText, boundary),
      );
      const canSupersedePreviousBoundary =
        canPromptMarkerSupersedePreviousBoundary(ch) &&
        (
          isEmbeddedPromptMarker(lineText, lastStandardBoundary) ||
          isSpacedPromptSegment(lineText, lastStandardBoundary) ||
          themedPromptCanSupersede
        ) &&
        (
          themedPromptCanSupersede ||
          isSpecificShellPromptCandidate(candidatePromptText, {
            allowGreaterThanTerminator: ch === ">" || ch === "›",
          })
        );
      if (!canSupersedePreviousBoundary) continue;
    }
    if (isStandard) {
      lastStandardBoundary = boundary;
    } else {
      lastPuaBoundary = boundary;
    }
  }

  return lastStandardBoundary >= 0 ? lastStandardBoundary : lastPuaBoundary;
}

/**
 * Reconcile a buffer-parsed prompt with the user's own keystroke history.
 *
 * findPromptBoundary stops at the first `PROMPT_CHAR + space` it sees, so
 * themes that render additional content after the prompt char — e.g.
 * oh-my-zsh's robbyrussell prints "➜  ~ " where `~` is the cwd — get
 * parsed as prompt="➜ " + userInput="~ lo". Every consumer downstream
 * (history recording, suggestion matching, insertion) then treats the
 * theme's cwd marker as part of the user's command, which pollutes
 * history with entries like "~ sudo id" and makes Tab insertions prepend
 * a phantom "~ " to the typed command (issue #806).
 *
 * Whenever we have an independent record of what the user actually typed
 * since the last Enter (keystroke buffer), we can detect this case: the
 * real input is always a suffix of the over-captured userInput. When it
 * is, reattribute the leading garbage back to promptText so the rest of
 * the pipeline sees the clean split.
 */
export function reconcilePromptWithTypedInput(
  prompt: PromptDetectionResult,
  typedInput: string,
): PromptDetectionResult {
  if (!prompt.isAtPrompt) return prompt;
  if (!typedInput) return prompt;
  if (prompt.userInput === typedInput) return prompt;
  if (
    prompt.userInput.length > typedInput.length &&
    prompt.userInput.endsWith(typedInput)
  ) {
    if (!canReconcilePromptDecoration(prompt, typedInput, {
      allowSingleWordCommandDirectory: true,
    })) {
      return prompt;
    }
    const extra = prompt.userInput.slice(0, prompt.userInput.length - typedInput.length);
    return {
      isAtPrompt: true,
      promptText: prompt.promptText + extra,
      userInput: typedInput,
      cursorOffset: typedInput.length,
    };
  }
  return prompt;
}

export function reconcilePromptWithExternalCommand(
  prompt: PromptDetectionResult,
  command: string,
): PromptDetectionResult | null {
  const typedInput = command.trim();
  if (!prompt.isAtPrompt || typedInput.length === 0) return null;

  const syntheticPrompt = {
    ...prompt,
    userInput: `${prompt.userInput}${typedInput}`,
    cursorOffset: prompt.userInput.length + typedInput.length,
  };
  if (!canReconcilePromptDecoration(syntheticPrompt, typedInput, {
    allowSingleWordCommandDirectory: true,
  })) {
    return null;
  }

  const extra = syntheticPrompt.userInput.slice(
    0,
    syntheticPrompt.userInput.length - typedInput.length,
  );
  return {
    isAtPrompt: true,
    promptText: prompt.promptText + extra,
    userInput: typedInput,
    cursorOffset: typedInput.length,
  };
}

/**
 * Unified entry point for any autocomplete code path that needs a prompt
 * view. Every consumer (fetchSuggestions, insertSuggestion,
 * handleSubDirSelect, Enter-record) goes through this one helper so the
 * alignment policy lives in exactly one place — if another out-of-band
 * line-rewrite path gets added later and forgets to notify the keystroke
 * buffer, the worst that happens is reconcile no-ops and we degrade to
 * pre-#806 behavior, not a worse pollution.
 *
 * Alignment rule: the keystroke buffer is usable only when it's marked
 * reliable and it can be reconciled with the live line. Exact raw
 * matches are safe, over-captured prompt chrome can be moved back into
 * promptText, and no-space prompts can be inferred from the cursor line
 * when the inferred prompt still looks like a shell prompt. Otherwise
 * the buffer is ignored and the raw detector result passes through.
 */
export function getAlignedPrompt(
  term: XTerm | null,
  typedBuffer: string,
  typedReliable: boolean,
): AlignedPromptResult {
  if (!term) return { prompt: NO_PROMPT, alignedTyped: null };
  const raw = detectPrompt(term);
  if (!typedReliable || typedBuffer.length === 0) {
    return { prompt: raw, alignedTyped: null };
  }

  if (raw.isAtPrompt) {
    if (raw.userInput === typedBuffer) {
      return { prompt: raw, alignedTyped: typedBuffer };
    }
    if (raw.userInput.length > typedBuffer.length && raw.userInput.endsWith(typedBuffer)) {
      const prompt = reconcilePromptWithTypedInput(raw, typedBuffer);
      if (prompt === raw) return { prompt: raw, alignedTyped: null };
      return {
        prompt,
        alignedTyped: typedBuffer,
      };
    }
    const themedDecorationAlignment = alignThemedDecorationWithPartialEcho(raw, typedBuffer);
    if (themedDecorationAlignment) return themedDecorationAlignment;
    if (canUseReliablePromptPrefix(raw, typedBuffer)) {
      return {
        prompt: withTypedUserInput(raw, typedBuffer),
        alignedTyped: typedBuffer,
      };
    }
  }

  const cursorPrefixCandidates = [
    getWrappedCursorPrefix(term),
    getCursorLinePrefix(term),
  ];
  for (const cursorPrefix of cursorPrefixCandidates) {
    const aligned = alignTypedInputFromCursorPrefix(raw, cursorPrefix, typedBuffer);
    if (aligned) return aligned;
  }

  return { prompt: raw, alignedTyped: null };
}
