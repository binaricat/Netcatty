/**
 * Prompt detector for terminal autocomplete.
 * Detects whether the user is currently at a shell prompt (vs. inside a running program).
 * Uses xterm.js buffer analysis to identify common prompt patterns.
 */

import type { Terminal as XTerm } from "@xterm/xterm";

/**
 * Common prompt ending patterns.
 * Covers bash ($), root (#), zsh (%), fish (>), PowerShell (>), and custom prompts.
 */
const PROMPT_END_PATTERNS = [
  /[$#%>❯❮→➜➤⟩»›]\s*$/,      // Common prompt characters
  /\)\s*[$#%>]\s*$/,            // Subshell: (env)$
  /\]\s*[$#%>]\s*$/,            // Bracketed: [user@host ~]$
  /:\s*[$#%>~]\s*$/,            // Colon-ended: user@host:~$
  /\w+@\w+[^$#%]*[$#%]\s*$/,   // user@host...$
];

/**
 * Patterns that indicate the user is NOT at a prompt
 * (e.g., inside vim, less, man, top, etc.)
 */
const NON_PROMPT_PATTERNS = [
  /^~$/,                         // vim empty line marker
  /^\s*--\s*More\s*--/,          // less/more pager
  /^\s*\(END\)/,                 // less end marker
  /^:\s*$/,                      // vim command mode
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

/**
 * Detect whether the terminal cursor is at a shell prompt and extract the current user input.
 *
 * Strategy:
 * 1. Read the current line from the xterm buffer
 * 2. Try to identify the prompt boundary using known patterns
 * 3. Extract the user input portion (text after the prompt)
 */
export function detectPrompt(term: XTerm): PromptDetectionResult {
  const buffer = term.buffer.active;
  const cursorY = buffer.cursorY + buffer.baseY;
  const cursorX = buffer.cursorX;
  const line = buffer.getLine(cursorY);

  if (!line) {
    return { isAtPrompt: false, promptText: "", userInput: "", cursorOffset: 0 };
  }

  const lineText = line.translateToString(true);

  // Check for non-prompt patterns (pagers, editors, etc.)
  for (const pattern of NON_PROMPT_PATTERNS) {
    if (pattern.test(lineText)) {
      return { isAtPrompt: false, promptText: "", userInput: "", cursorOffset: 0 };
    }
  }

  // Empty line — might be a prompt with just $ or similar
  if (lineText.trim().length === 0) {
    return { isAtPrompt: false, promptText: "", userInput: "", cursorOffset: 0 };
  }

  // Try to find the prompt boundary
  const promptEnd = findPromptBoundary(lineText);
  if (promptEnd >= 0) {
    const promptText = lineText.substring(0, promptEnd);
    const userInput = lineText.substring(promptEnd).replace(/\s+$/, "");
    const cursorOffset = Math.max(0, cursorX - promptEnd);

    return {
      isAtPrompt: true,
      promptText,
      userInput,
      cursorOffset,
    };
  }

  return { isAtPrompt: false, promptText: "", userInput: "", cursorOffset: 0 };
}

/**
 * Find the boundary between prompt and user input.
 * Returns the character index where user input begins, or -1 if no prompt detected.
 */
function findPromptBoundary(lineText: string): number {
  // Strategy: find the last prompt-ending character sequence,
  // then the user input starts after it (plus any trailing space).

  for (const pattern of PROMPT_END_PATTERNS) {
    // Try matching from the start of the line, looking for prompt endings
    // We want the FIRST match (leftmost prompt end), not the last,
    // because user input might contain $ or # characters.
    const match = lineText.match(pattern);
    if (match && match.index !== undefined) {
      // The boundary is after the matched prompt ending + any space
      const afterMatch = match.index + match[0].length;
      // But only if there's reasonable prompt length (not the entire line)
      if (afterMatch <= lineText.length && match.index < 80) {
        return afterMatch;
      }
    }
  }

  // Fallback: look for common prompt characters followed by space
  for (let i = 0; i < Math.min(lineText.length, 80); i++) {
    const ch = lineText[i];
    if ((ch === "$" || ch === "#" || ch === "%" || ch === ">" || ch === "❯" || ch === "➜") &&
        i + 1 < lineText.length && lineText[i + 1] === " ") {
      return i + 2;
    }
  }

  return -1;
}

/**
 * Simplified prompt detection: just check if we're likely at a prompt.
 * Faster than full detectPrompt() for quick checks.
 */
export function isLikelyAtPrompt(term: XTerm): boolean {
  const buffer = term.buffer.active;
  const cursorY = buffer.cursorY + buffer.baseY;
  const line = buffer.getLine(cursorY);
  if (!line) return false;

  const lineText = line.translateToString(true);
  if (lineText.trim().length === 0) return false;

  // Check non-prompt patterns
  for (const pattern of NON_PROMPT_PATTERNS) {
    if (pattern.test(lineText)) return false;
  }

  return findPromptBoundary(lineText) >= 0;
}
