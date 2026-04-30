/**
 * Prompt detector for terminal autocomplete.
 * Detects whether the user is currently at a shell prompt (vs. inside a running program).
 * Uses xterm.js buffer analysis to identify common prompt patterns.
 *
 * Strategy: scan prompt-looking boundaries ($ # % >, Powerline/Nerd Font glyphs,
 * etc.) and choose the most reliable split for prompt text vs. user input.
 */

import type { Terminal as XTerm } from "@xterm/xterm";

/**
 * Patterns that indicate the user is NOT at a prompt
 * (e.g., inside vim, less, man, top, etc.)
 */
const NON_PROMPT_PATTERNS = [
  /^~$/,                         // vim empty line marker
  /^\s*--\s*More\s*--/,          // less/more pager
  /^\s*\(END\)/,                 // less end marker
  /^:\s*$/,                      // vim command mode
  /^\s*~\s*$/,                   // vim tilde lines
  /^>{1,3}\s/,                   // Bare > (bash PS2 continuation), >> or >>> (python REPL)
  /^\w+>\s/,                     // mysql> / sqlite> / redis-cli> REPL prompts
];

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

export interface AlignedPromptResult {
  /** The prompt view every consumer should use for parsing / suggestion lookup / line rewrites. */
  prompt: PromptDetectionResult;
  /**
   * The keystroke buffer, but only when it's both marked reliable AND
   * actually matches the tail of the raw detected userInput. Returns
   * null otherwise — the single signal downstream uses to decide
   * whether to record it as the executed command.
   */
  alignedTyped: string | null;
}

function replacePromptUserInput(
  prompt: PromptDetectionResult,
  userInput: string,
): PromptDetectionResult {
  return {
    isAtPrompt: true,
    promptText: prompt.promptText,
    userInput,
    cursorOffset: userInput.length,
  };
}

function getCursorLinePrefix(term: XTerm): string | null {
  const buffer = term.buffer.active;
  const cursorY = buffer.cursorY + buffer.baseY;
  const line = buffer.getLine(cursorY);

  if (!line) return null;

  return line.translateToString(false).substring(0, Math.max(0, buffer.cursorX));
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
  for (const pattern of NON_PROMPT_PATTERNS) {
    if (pattern.test(lineText)) return NO_PROMPT;
  }

  // Empty line
  if (lineText.trim().length === 0) return NO_PROMPT;

  // Try to find the prompt boundary on the current line
  const promptEnd = findPromptBoundary(lineText);
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

        return { isAtPrompt: true, promptText, userInput, cursorOffset };
      }
    }
  }

  return NO_PROMPT;
}

/** Characters that commonly end a shell prompt */
const PROMPT_CHARS = new Set(["$", "#", "%", ">", "❯", "❮", "→", "➜", "➤", "⟩", "»", "›"]);

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
 * reliable AND the raw detected prompt still looks like the same shell
 * line. When the raw buffer has either over-captured prompt chrome
 * (`raw.userInput.endsWith(typedBuffer)`) or under-captured because the
 * shell echo/render is lagging behind local keystrokes
 * (`typedBuffer.startsWith(raw.userInput)`), prefer the typed buffer.
 * Otherwise the buffer is ignored and the raw detector result passes
 * through.
 */
export function getAlignedPrompt(
  term: XTerm | null,
  typedBuffer: string,
  typedReliable: boolean,
): AlignedPromptResult {
  if (!term) return { prompt: NO_PROMPT, alignedTyped: null };
  const raw = detectPrompt(term);
  if (!typedReliable || typedBuffer.length === 0 || !raw.isAtPrompt) {
    return { prompt: raw, alignedTyped: null };
  }
  if (raw.userInput === typedBuffer) {
    return { prompt: raw, alignedTyped: typedBuffer };
  }
  if (raw.userInput.length > typedBuffer.length && raw.userInput.endsWith(typedBuffer)) {
    return {
      prompt: reconcilePromptWithTypedInput(raw, typedBuffer),
      alignedTyped: typedBuffer,
    };
  }
  if (typedBuffer.length > raw.userInput.length && typedBuffer.startsWith(raw.userInput)) {
    return {
      prompt: replacePromptUserInput(raw, typedBuffer),
      alignedTyped: typedBuffer,
    };
  }
  const cursorLinePrefix = getCursorLinePrefix(term);
  if (cursorLinePrefix?.endsWith(typedBuffer)) {
    const promptText = cursorLinePrefix.slice(0, cursorLinePrefix.length - typedBuffer.length);
    if (promptText.length > 0) {
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
  }
  return { prompt: raw, alignedTyped: null };
}

/**
 * Simplified prompt detection: just check if we're likely at a prompt.
 */
export function isLikelyAtPrompt(term: XTerm): boolean {
  const buffer = term.buffer.active;
  const cursorY = buffer.cursorY + buffer.baseY;
  const line = buffer.getLine(cursorY);
  if (!line) return false;

  const lineText = line.translateToString(false);
  if (lineText.trim().length === 0) return false;

  for (const pattern of NON_PROMPT_PATTERNS) {
    if (pattern.test(lineText)) return false;
  }

  return findPromptBoundary(lineText) >= 0;
}
