/**
 * Normalize an xterm selection into clipboard-ready logical text.
 *
 * xterm's getSelection() already joins soft-wrapped rows (isWrapped) and trims
 * *empty* buffer cells, but TUI apps often pad rows with real space characters.
 * Those written spaces survive copy and corrupt pasted paragraphs/code blocks.
 *
 * This helper rebuilds the selection from buffer coordinates so we can:
 * - strip written trailing padding on completed physical rows
 * - join only rows marked soft-wrapped by xterm
 * - keep genuine hard line breaks
 * - preserve rectangular (column) selections and partial end-column spaces
 * - convert non-breaking spaces like xterm's selectionText path
 */

export type SelectionBufferCell = {
  getChars?: () => string;
  getCode?: () => number;
  getWidth?: () => number;
};

export type SelectionBufferLine = {
  isWrapped?: boolean;
  length: number;
  /**
   * Public xterm API — preferred for column-accurate content-end measurement
   * (wide characters, empty cells).
   */
  getCell?: (x: number, cell?: SelectionBufferCell) => SelectionBufferCell | undefined;
  /**
   * xterm semantics: trimRight only drops empty cells (getTrimmedLength),
   * not written ASCII spaces used as display padding.
   */
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
};

export type SelectionBuffer = {
  getLine(y: number): SelectionBufferLine | undefined;
};

export type SelectionPosition = {
  start: { x: number; y: number };
  end: { x: number; y: number };
};

export type SelectionTerminal = {
  getSelection?: () => string;
  getSelectionPosition?: () => SelectionPosition | undefined | null;
  buffer: {
    active: SelectionBuffer;
  };
  /** Present on real xterm Terminal instances; used only to detect column select. */
  _core?: {
    _selectionService?: {
      /** xterm SelectionMode: NORMAL=0, WORD=1, LINE=2, COLUMN=3 */
      _activeSelectionMode?: number;
    };
  };
};

/** Matches xterm SelectionMode.COLUMN */
const SELECTION_MODE_COLUMN = 3;
const ALL_NON_BREAKING_SPACE_REGEX = /\u00a0/g;
/**
 * Characters that strongly mean the next soft-wrapped row continues the same
 * token (path/URL fragment). Sentence punctuation like `.` `?` `:` is NOT
 * included here — those need surrounding URL/path context.
 */
const PATH_TOKEN_END = new Set("\\/@#&=+%".split(""));
const PATH_TOKEN_START = new Set("\\/-_.".split(""));

/**
 * Selection text for clipboard / paste-selection / AI attach.
 * When `normalize` is false, returns raw xterm getSelection() (screen cells).
 * When true (default), strips display padding and joins soft wraps.
 */
export function getTerminalSelectionForClipboard(
  term: SelectionTerminal,
  normalize = true,
): string {
  if (!normalize) {
    return term.getSelection?.() ?? "";
  }
  return getNormalizedTerminalSelection(term);
}

/**
 * Return clipboard-ready text for the current terminal selection.
 * Falls back to term.getSelection() when position/buffer APIs are unavailable.
 */
export function getNormalizedTerminalSelection(term: SelectionTerminal): string {
  const range = term.getSelectionPosition?.() ?? null;
  if (!range) {
    return normalizeClipboardText(term.getSelection?.() ?? "");
  }

  const { start, end } = normalizeSelectionRange(range);
  if (end.y < start.y) {
    return "";
  }

  if (isColumnSelectionMode(term)) {
    return buildColumnSelection(term.buffer.active, start, end);
  }

  return buildLinearSelection(term.buffer.active, start, end);
}

function isColumnSelectionMode(term: SelectionTerminal): boolean {
  return term._core?._selectionService?._activeSelectionMode === SELECTION_MODE_COLUMN;
}

function buildColumnSelection(
  buffer: SelectionBuffer,
  start: { x: number; y: number },
  end: { x: number; y: number },
): string {
  if (start.x === end.x) {
    return "";
  }

  const startCol = Math.min(start.x, end.x);
  const endCol = Math.max(start.x, end.x);
  const rows: string[] = [];

  for (let y = start.y; y <= end.y; y += 1) {
    const line = buffer.getLine(y);
    if (!line) {
      rows.push("");
      continue;
    }
    // Keep right-edge spaces: the user selected those columns on purpose.
    rows.push(line.translateToString(true, startCol, endCol));
  }

  return normalizeClipboardText(rows.join("\n"));
}

function buildLinearSelection(
  buffer: SelectionBuffer,
  start: { x: number; y: number },
  end: { x: number; y: number },
): string {
  const logicalLines: string[] = [];
  let current = "";

  for (let y = start.y; y <= end.y; y += 1) {
    const line = buffer.getLine(y);
    if (!line) {
      if (current.length > 0 || logicalLines.length > 0) {
        logicalLines.push(trimCompletedRowPadding(current));
        current = "";
      }
      continue;
    }

    const startCol = y === start.y ? start.x : 0;
    // Always pass an exclusive end column. xterm.js 6 may serve a no-endCol
    // translateToString(true) from its string cache via String.trimEnd(),
    // which drops a wrap-boundary space (#3023).
    const endCol = y === end.y ? end.x : line.length;
    const rowText = line.translateToString(true, startCol, endCol);

    if (y === start.y) {
      current = rowText;
      continue;
    }

    if (line.isWrapped) {
      current = joinSoftWrappedRows(current, rowText);
      continue;
    }

    logicalLines.push(trimCompletedRowPadding(current));
    current = rowText;
  }

  // Last logical segment: only strip padding when the selection ends at/after
  // the buffer line's content end (full-row copy). Partial end columns keep
  // explicitly selected trailing spaces.
  const lastLine = buffer.getLine(end.y);
  const selectionEndsAtRowEnd =
    !lastLine || end.x >= lastLine.length || end.x >= measureContentEnd(lastLine);
  logicalLines.push(
    selectionEndsAtRowEnd ? trimCompletedRowPadding(current) : current,
  );
  return normalizeClipboardText(logicalLines.join("\n"));
}

/**
 * Join two physical rows that xterm marked as a soft wrap.
 *
 * Trailing whitespace is either a real word separator or TUI display padding.
 * Policy (tuned for #2162 Pi/TUI prose + common tokens):
 * - no trailing ws → mid-word auto-wrap, concatenate tightly
 * - strong token continuation (CJK / path punctuation / URL query) → tight
 * - multi-space padding on a URL/path mid-token (alnum|alnum) → tight
 * - otherwise (single or multi-space between ordinary words) → one space
 */
export function joinSoftWrappedRows(previousRaw: string, nextRaw: string): string {
  const trailingWhitespace = countTrailingHorizontalWhitespace(previousRaw);
  const left = trailingWhitespace > 0 ? previousRaw.slice(0, -trailingWhitespace) : previousRaw;

  if (!nextRaw) {
    return left;
  }

  if (trailingWhitespace === 0) {
    return left + nextRaw;
  }

  if (/^\s/u.test(nextRaw)) {
    return left + nextRaw;
  }

  if (!left) {
    return nextRaw;
  }

  // Strong continuations (CJK, path/URL punctuation, trailing hyphen) ignore pad
  // spaces. Deliberately do NOT treat "complete URL/flag + padding + next word"
  // as a mid-token join — multi-space pad after a finished token is a word boundary.
  if (isStrongTokenContinuation(left, nextRaw)) {
    return left + nextRaw;
  }

  // Prose word boundary: single-space wrap or multi-space TUI padding between words.
  return `${left} ${nextRaw}`;
}

function isStrongTokenContinuation(left: string, next: string): boolean {
  const leftEnd = lastCodePointChar(left);
  const nextStart = firstCodePointChar(next);
  if (!leftEnd || !nextStart) return false;

  const leftEndCp = leftEnd.codePointAt(0) ?? 0;
  const nextStartCp = nextStart.codePointAt(0) ?? 0;

  // CJK / Hangul runs and CJK punctuation should not gain Latin-style spaces.
  if (isCjkRelatedCodePoint(leftEndCp) || isCjkPunctuation(leftEnd)) {
    return isCjkRelatedCodePoint(nextStartCp) || isCjkPunctuation(nextStart);
  }

  const trailingToken = getTrailingToken(left);

  // Path/URL fragment separators at the end of the trailing token.
  if (PATH_TOKEN_END.has(leftEnd) && looksLikeUrlOrPath(trailingToken)) {
    return true;
  }

  // Query/fragment delimiters after a URL/path token.
  if (
    looksLikeUrlOrPath(trailingToken) &&
    (nextStart === "?" || nextStart === "#" || nextStart === "&")
  ) {
    return true;
  }
  if (
    looksLikeUrlOrPath(trailingToken) &&
    (leftEnd === "?" || leftEnd === "#" || leftEnd === "&") &&
    (isAsciiWordChar(nextStart) || nextStart === "=" || nextStart === "-" || nextStart === "_")
  ) {
    return true;
  }

  // e.g. "foo/" + "bar" when trailing token is path/URL-like.
  if (PATH_TOKEN_START.has(nextStart) && (isAsciiWordChar(leftEnd) || "/\\-_:.".includes(leftEnd))) {
    if (looksLikeUrlOrPath(trailingToken) || leftEnd === "/" || leftEnd === "\\") {
      return true;
    }
  }

  // URL/path joiners (_ :) — not "." (sentence end after URL).
  if (
    looksLikeUrlOrPath(trailingToken) &&
    isAsciiWordChar(nextStart) &&
    (leftEnd === "_" || leftEnd === ":")
  ) {
    return true;
  }

  // Hyphenated words at the hyphen: "state-" + "of-the-art".
  // Do not join complete flags like "--verbose" + "to" (left ends with a letter).
  if (leftEnd === "-" && (isAsciiWordChar(nextStart) || nextStart === "-")) {
    return true;
  }

  return false;
}

function getTrailingToken(text: string): string {
  const match = text.match(/(\S+)$/u);
  return match?.[1] ?? text;
}

function looksLikeUrlOrPath(token: string): boolean {
  if (!token) return false;
  if (/[a-z][a-z0-9+.-]*:\/\//i.test(token)) return true;
  if (token.includes("www.")) return true;
  // Absolute or deep relative paths: /usr/local/... or foo/bar/baz
  if (token.startsWith("/") || token.startsWith("./") || token.startsWith("../")) return true;
  if ((token.match(/\//g) ?? []).length >= 1 && /[A-Za-z0-9]/u.test(token)) return true;
  // Windows / UNC paths: C:\Users\... or \\server\share
  if (/^[A-Za-z]:[\\/]/u.test(token)) return true;
  if (token.startsWith("\\\\")) return true;
  if ((token.match(/\\/g) ?? []).length >= 1 && /[A-Za-z0-9]/u.test(token)) return true;
  return false;
}

function isAsciiWordChar(char: string): boolean {
  return /^[A-Za-z0-9]$/u.test(char);
}

function isCjkPunctuation(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0;
  // Common fullwidth / CJK punctuation used after ideographs.
  return (
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    char === "，" ||
    char === "。" ||
    char === "、" ||
    char === "：" ||
    char === "；" ||
    char === "！" ||
    char === "？"
  );
}

function firstCodePointChar(text: string): string {
  if (!text) return "";
  const cp = text.codePointAt(0);
  if (cp === undefined) return "";
  return String.fromCodePoint(cp);
}

function lastCodePointChar(text: string): string {
  if (!text) return "";
  const chars = Array.from(text);
  return chars[chars.length - 1] ?? "";
}

function isCjkRelatedCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x11ff) || // Hangul Jamo
    (cp >= 0x3040 && cp <= 0x30ff) || // Hiragana / Katakana
    (cp >= 0x3130 && cp <= 0x318f) || // Hangul Compatibility Jamo
    (cp >= 0x3400 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xff66 && cp <= 0xff9d) || // Half-width Katakana
    (cp >= 0x20000 && cp <= 0x2ceaf) // CJK Extension B–F (supplementary planes)
  );
}

function countTrailingHorizontalWhitespace(text: string): number {
  let count = 0;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\f" || ch === "\v") {
      count += 1;
      continue;
    }
    break;
  }
  return count;
}

/**
 * Strip written display-padding spaces that survive xterm's empty-cell trim.
 * Only trailing horizontal whitespace is removed.
 */
export function trimWrittenPadding(text: string): string {
  return text.replace(/[ \t\f\v]+$/u, "");
}

/** Alias used when a completed physical/hard row may still carry TUI padding. */
function trimCompletedRowPadding(text: string): string {
  return trimWrittenPadding(text);
}

/**
 * Column after the last non-empty cell on the line (public xterm cell widths).
 * Falls back to string length only when getCell is unavailable (tests/fakes).
 */
export function measureContentEnd(line: SelectionBufferLine): number {
  if (typeof line.getCell === "function") {
    for (let x = line.length - 1; x >= 0; x -= 1) {
      const cell = line.getCell(x);
      if (!cell) continue;
      const chars = cell.getChars?.() ?? "";
      const code = cell.getCode?.() ?? 0;
      if (chars.length > 0 || code !== 0) {
        const width = cell.getWidth?.() ?? 1;
        return x + Math.max(1, width);
      }
    }
    return 0;
  }
  return line.translateToString(true).length;
}

function normalizeClipboardText(text: string): string {
  const normalized = text.replace(ALL_NON_BREAKING_SPACE_REGEX, " ");
  // Match xterm selectionText: Windows uses CRLF between logical lines.
  if (isWindowsPlatform() && normalized.includes("\n") && !normalized.includes("\r\n")) {
    return normalized.replace(/\n/g, "\r\n");
  }
  return normalized;
}

function isWindowsPlatform(): boolean {
  if (typeof navigator !== "undefined") {
    const platform = navigator.platform || "";
    const ua = navigator.userAgent || "";
    if (/Win/i.test(platform) || /Windows/i.test(ua)) return true;
  }
  if (typeof process !== "undefined" && typeof process.platform === "string") {
    return process.platform === "win32";
  }
  return false;
}

function normalizeSelectionRange(range: SelectionPosition): SelectionPosition {
  const { start, end } = range;
  if (start.y < end.y || (start.y === end.y && start.x <= end.x)) {
    return {
      start: { x: Math.max(0, start.x), y: start.y },
      end: { x: Math.max(0, end.x), y: end.y },
    };
  }
  return {
    start: { x: Math.max(0, end.x), y: end.y },
    end: { x: Math.max(0, start.x), y: start.y },
  };
}
