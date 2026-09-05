/**
 * Terminal log sanitizer.
 *
 * This is intentionally stateful: terminal output is a stream of cursor and
 * erase operations, not plain text with decoration. The renderer below keeps a
 * small virtual text buffer so plain-text and HTML logs reflect what common
 * line-editing output actually leaves on screen.
 *
 * Full-screen TUIs (vim/less/htop) use the alternate screen buffer
 * (DECSET 47/1047/1049). While that mode is active, paint is omitted so session
 * logs keep shell history instead of tilde rows and status lines.
 */

const CSI_FINAL_RE = /[@-~]/;
// ANSI palette colors are emitted as CSS variables (with hex fallbacks) so the
// wrapping HTML page can provide light and dark palettes. Indexes 0-7 are the
// basic colors, 8-15 the bright colors.
const DEFAULT_FOREGROUND = "#d4d4d4";
const DEFAULT_BACKGROUND = "#1e1e1e";
const BASIC_COLORS = [
  "#000000",
  "#cd3131",
  "#0dbc79",
  "#e5e510",
  "#2472c8",
  "#bc3fbc",
  "#11a8cd",
  "#e5e5e5",
];
const BRIGHT_COLORS = [
  "#666666",
  "#f14c4c",
  "#23d18b",
  "#f5f543",
  "#3b8eea",
  "#d670d6",
  "#29b8db",
  "#ffffff",
];

function ansiColorVar(index) {
  const fallback = index < 8 ? BASIC_COLORS[index] : BRIGHT_COLORS[index - 8];
  return `var(--ansi-${index}, ${fallback})`;
}

class TerminalTextRenderer {
  constructor(options = {}) {
    this.lines = [[]];
    this.row = 0;
    this.col = 0;
    this.screenBaseRow = 0;
    this.state = "normal";
    this.escapeBuffer = "";
    this.style = createDefaultStyle();
    this.cursorMovedHomeByCsi = false;
    this.justStartedLogScreen = false;
    this.hasPreservedScreenHistory = false;
    this.pendingClearedScreen = null;
    // Seed when a session log starts while vim/less is already on the alternate buffer.
    this.alternateScreenActive = options.alternateScreenActive === true;
  }

  feed(input) {
    if (!input) return;

    for (const ch of input) {
      this.#consume(ch);
    }
  }

  finish() {
    this.state = "normal";
    this.escapeBuffer = "";
    this.#commitPendingClearedScreen();
    return this.toString();
  }

  toString({ includePendingClearedScreen = false } = {}) {
    const lines = includePendingClearedScreen ? this.#linesWithPendingClearedScreen() : this.lines;
    return lines
      .map((line) => line.map((cell) => cell?.ch || " ").join("").replace(/[ \t]+$/g, ""))
      .join("\n")
      .replace(/\n+$/g, "");
  }

  toHtmlContent({ includePendingClearedScreen = false } = {}) {
    const lines = includePendingClearedScreen ? this.#linesWithPendingClearedScreen() : this.lines;
    return lines
      .map((line) => renderLineHtml(line))
      .join("\n")
      .replace(/\n+$/g, "");
  }

  #consume(ch) {
    if (this.state === "esc") {
      this.#consumeEsc(ch);
      return;
    }
    if (this.state === "csi") {
      this.escapeBuffer += ch;
      if (CSI_FINAL_RE.test(ch)) {
        this.#applyCsi(this.escapeBuffer);
        this.state = "normal";
        this.escapeBuffer = "";
      }
      return;
    }
    if (this.state === "osc") {
      if (ch === "\x07") {
        this.state = "normal";
        this.escapeBuffer = "";
        return;
      }
      if (ch === "\x1b") {
        this.state = "oscEsc";
      }
      return;
    }
    if (this.state === "oscEsc") {
      this.state = ch === "\\" ? "normal" : "osc";
      return;
    }

    switch (ch) {
      case "\x1b":
        this.state = "esc";
        this.escapeBuffer = "";
        break;
      case "\x9b":
        // 8-bit C1 CSI (single-byte form of ESC [). Same private modes as the
        // 7-bit sequence, including alternate-screen enter/leave.
        this.state = "csi";
        this.escapeBuffer = "";
        break;
      case "\b":
        if (this.alternateScreenActive) break;
        this.col = Math.max(0, this.col - 1);
        break;
      case "\r":
        if (this.alternateScreenActive) break;
        this.col = 0;
        this.cursorMovedHomeByCsi = false;
        break;
      case "\n":
        if (this.alternateScreenActive) break;
        this.row += 1;
        this.col = 0;
        this.cursorMovedHomeByCsi = false;
        this.#ensureLine();
        break;
      case "\t":
        if (this.alternateScreenActive) break;
        this.#writeText(" ".repeat(8 - (this.col % 8)));
        break;
      default:
        if (this.alternateScreenActive) break;
        if (this.#isPrintable(ch)) this.#writeText(ch);
        break;
    }
  }

  #consumeEsc(ch) {
    if (ch === "[") {
      this.state = "csi";
      this.escapeBuffer = "";
      return;
    }
    if (ch === "]") {
      this.state = "osc";
      this.escapeBuffer = "";
      return;
    }
    // RIS (ESC c) fully resets the terminal: leave the alternate buffer, clear
    // SGR, and rebase the log screen so post-reset cursor homes cannot overwrite
    // preserved history. Prior lines stay in the log (not a live ED2 wipe).
    if (ch === "c") {
      this.#applyRisReset();
    }
    // Single-character ESC sequences are terminal controls. Ignore them for
    // logs, but consume them so they never leak into txt/html output.
    this.state = "normal";
    this.escapeBuffer = "";
  }

  #applyRisReset() {
    this.alternateScreenActive = false;
    this.style = createDefaultStyle();
    this.pendingClearedScreen = null;

    // Drop trailing blank rows so "before\\n" + RIS does not leave an empty
    // separator before the new screen, then base cursor-home on a fresh row.
    while (this.lines.length > 0 && getTrimmedLineLength(this.lines[this.lines.length - 1]) === 0) {
      this.lines.pop();
    }

    if (this.lines.length === 0) {
      this.lines = [[]];
      this.row = 0;
      this.col = 0;
      this.screenBaseRow = 0;
      this.hasPreservedScreenHistory = false;
    } else {
      this.lines.push([]);
      this.screenBaseRow = this.lines.length - 1;
      this.row = this.screenBaseRow;
      this.col = 0;
      this.hasPreservedScreenHistory = true;
    }

    this.cursorMovedHomeByCsi = false;
    this.justStartedLogScreen = true;
  }

  #applyCsi(sequence) {
    const final = sequence.at(-1);
    const params = sequence.slice(0, -1);
    const isPrivateMode = params.includes("?");
    const values = params
      .replace(/[?><=]/g, "")
      .split(";")
      .map((part) => {
        if (part === "") return undefined;
        const n = Number.parseInt(part, 10);
        return Number.isFinite(n) ? n : undefined;
      });
    const n = values[0] || 1;

    if ((final === "h" || final === "l") && isPrivateMode) {
      const alternateModes = values.filter((value) => value === 47 || value === 1047 || value === 1049);
      if (alternateModes.length > 0) {
        this.alternateScreenActive = final === "h";
        return;
      }
    }

    if (this.alternateScreenActive) {
      return;
    }

    switch (final) {
      case "A":
        this.row = Math.max(this.screenBaseRow, this.row - n);
        this.cursorMovedHomeByCsi = false;
        this.#ensureLine();
        break;
      case "B":
      case "E":
        this.row += n;
        if (final === "E") this.col = 0;
        this.cursorMovedHomeByCsi = false;
        this.#ensureLine();
        break;
      case "C":
        this.col += n;
        this.cursorMovedHomeByCsi = false;
        break;
      case "D":
        this.col = Math.max(0, this.col - n);
        this.cursorMovedHomeByCsi = false;
        break;
      case "F":
        this.row = Math.max(this.screenBaseRow, this.row - n);
        this.col = 0;
        this.cursorMovedHomeByCsi = false;
        this.#ensureLine();
        break;
      case "G":
        this.col = Math.max(0, n - 1);
        this.cursorMovedHomeByCsi = false;
        break;
      case "H":
      case "f":
        this.row = this.screenBaseRow + Math.max(0, (values[0] || 1) - 1);
        this.col = Math.max(0, (values[1] || 1) - 1);
        this.cursorMovedHomeByCsi = this.row === this.screenBaseRow && this.col === 0;
        this.#ensureLine();
        break;
      case "J":
        this.#eraseDisplay(values[0] || 0);
        break;
      case "K":
        this.#eraseLine(values[0] || 0);
        break;
      case "m":
        this.#applySgr(values);
        break;
      default:
        // Unsupported CSI controls are intentionally ignored.
        break;
    }
  }

  #applySgr(values) {
    const codes = values.length > 0 ? values : [0];

    for (let i = 0; i < codes.length; i += 1) {
      const code = codes[i] ?? 0;

      if (code === 0) {
        this.style = createDefaultStyle();
      } else if (code === 1) {
        this.style.bold = true;
      } else if (code === 3) {
        this.style.italic = true;
      } else if (code === 4) {
        this.style.underline = true;
      } else if (code === 7) {
        this.style.inverse = true;
      } else if (code === 22) {
        this.style.bold = false;
      } else if (code === 23) {
        this.style.italic = false;
      } else if (code === 24) {
        this.style.underline = false;
      } else if (code === 27) {
        this.style.inverse = false;
      } else if (code >= 30 && code <= 37) {
        this.style.fg = ansiColorVar(code - 30);
      } else if (code === 39) {
        this.style.fg = null;
      } else if (code >= 40 && code <= 47) {
        this.style.bg = ansiColorVar(code - 40);
      } else if (code === 49) {
        this.style.bg = null;
      } else if (code >= 90 && code <= 97) {
        this.style.fg = ansiColorVar(8 + code - 90);
      } else if (code >= 100 && code <= 107) {
        this.style.bg = ansiColorVar(8 + code - 100);
      } else if ((code === 38 || code === 48) && codes[i + 1] === 5) {
        const color = colorFromAnsi256(codes[i + 2]);
        if (color) {
          if (code === 38) this.style.fg = color;
          else this.style.bg = color;
        }
        i += 2;
      } else if ((code === 38 || code === 48) && codes[i + 1] === 2) {
        const color = colorFromRgb(codes[i + 2], codes[i + 3], codes[i + 4]);
        if (color) {
          if (code === 38) this.style.fg = color;
          else this.style.bg = color;
        }
        i += 4;
      }
    }
  }

  #writeText(text) {
    this.#ensureLine();
    const line = this.lines[this.row];
    while (line.length < this.col) line.push(createCell(" ", createDefaultStyle()));
    for (const ch of text) {
      line[this.col] = createCell(ch, this.style);
      this.col += 1;
    }
    this.cursorMovedHomeByCsi = false;
    this.justStartedLogScreen = false;
  }

  #eraseLine(mode) {
    this.#ensureLine();
    const line = this.lines[this.row];
    if (mode === 1) {
      for (let i = 0; i <= this.col && i < line.length; i += 1) {
        line[i] = createCell(" ", createDefaultStyle());
      }
      return;
    }
    if (mode === 2) {
      this.lines[this.row] = [];
      return;
    }
    line.length = Math.min(line.length, this.col);
  }

  #eraseDisplay(mode) {
    this.#ensureLine();
    if (mode === 3 && this.pendingClearedScreen) {
      this.#commitPendingClearedScreen();
      return;
    }
    if (mode === 3) {
      this.pendingClearedScreen = null;
      return;
    }
    if (mode === 2) {
      if (this.hasPreservedScreenHistory) {
        this.#clearCurrentLogScreen({ keepPending: true });
        return;
      }
      this.#startNewLogScreen();
      return;
    }
    if (mode === 1) {
      for (let i = this.screenBaseRow; i < this.row; i += 1) {
        this.lines[i] = [];
      }
      this.#eraseLine(1);
      return;
    }
    if (
      this.row === this.screenBaseRow &&
      this.col === 0 &&
      this.cursorMovedHomeByCsi &&
      !this.hasPreservedScreenHistory
    ) {
      this.#startNewLogScreen();
      return;
    }
    this.#eraseLine(0);
    this.lines.length = this.row + 1;
  }

  #clearCurrentLogScreen({ keepPending = false } = {}) {
    const targetRow = this.row;
    if (keepPending && this.#currentLogScreenHasContent()) {
      this.pendingClearedScreen = {
        lines: cloneLines(this.lines.slice(this.screenBaseRow)),
        baseRow: this.screenBaseRow,
      };
    } else if (!keepPending) {
      this.pendingClearedScreen = null;
    }
    for (let i = this.screenBaseRow; i < this.lines.length; i += 1) {
      this.lines[i] = [];
    }
    this.row = Math.max(this.screenBaseRow, targetRow);
    this.#ensureLine();
    this.cursorMovedHomeByCsi = false;
    this.justStartedLogScreen = true;
  }

  #commitPendingClearedScreen() {
    const pending = this.pendingClearedScreen;
    if (!pending) return;
    const relativeRow = Math.max(0, this.row - pending.baseRow);
    const col = this.col;
    const { lines, screenBaseRow } = this.#buildLinesWithPendingClearedScreen(pending);
    this.lines = lines;
    this.screenBaseRow = screenBaseRow;
    this.row = this.screenBaseRow + relativeRow;
    this.col = col;
    this.#ensureLine();
    this.cursorMovedHomeByCsi = false;
    this.justStartedLogScreen = true;
    this.hasPreservedScreenHistory = true;
    this.pendingClearedScreen = null;
  }

  #linesWithPendingClearedScreen() {
    const pending = this.pendingClearedScreen;
    if (!pending) return this.lines;
    return this.#buildLinesWithPendingClearedScreen(pending).lines;
  }

  #buildLinesWithPendingClearedScreen(pending) {
    const prefix = this.lines.slice(0, pending.baseRow);
    const activeLines = this.lines.slice(pending.baseRow);
    const pendingLines = trimTrailingBlankLines(pending.lines);
    return {
      lines: prefix.concat(pendingLines, [[]], activeLines.length > 0 ? activeLines : [[]]),
      screenBaseRow: prefix.length + pendingLines.length + 1,
    };
  }

  #startNewLogScreen() {
    if (this.justStartedLogScreen) return;
    const hasContent = this.lines.some((line) => getTrimmedLineLength(line) > 0);
    if (hasContent) {
      this.lines.push([]);
      this.row = this.lines.length - 1;
    } else {
      this.lines = [[]];
      this.row = 0;
    }
    this.screenBaseRow = this.row;
    this.col = 0;
    this.cursorMovedHomeByCsi = false;
    this.justStartedLogScreen = true;
    this.hasPreservedScreenHistory = hasContent;
    this.pendingClearedScreen = null;
  }

  #currentLogScreenHasContent() {
    for (let i = this.screenBaseRow; i < this.lines.length; i += 1) {
      if (getTrimmedLineLength(this.lines[i]) > 0) return true;
    }
    return false;
  }

  #ensureLine() {
    while (this.lines.length <= this.row) this.lines.push([]);
  }

  #isPrintable(ch) {
    const code = ch.codePointAt(0);
    if (code === undefined) return false;
    return code >= 0x20 && code !== 0x7f;
  }
}

function terminalDataToPlainText(terminalData) {
  const renderer = new TerminalTextRenderer();
  renderer.feed(terminalData || "");
  return renderer.finish();
}

function terminalDataToHtmlContent(terminalData) {
  const renderer = new TerminalTextRenderer();
  renderer.feed(terminalData || "");
  renderer.finish();
  return renderer.toHtmlContent();
}

function createTerminalTextRenderer(options = {}) {
  return new TerminalTextRenderer(options);
}

module.exports = {
  TerminalTextRenderer,
  createTerminalTextRenderer,
  terminalDataToHtmlContent,
  terminalDataToPlainText,
};

function createDefaultStyle() {
  return {
    fg: null,
    bg: null,
    bold: false,
    italic: false,
    underline: false,
    inverse: false,
  };
}

function createCell(ch, style) {
  return {
    ch,
    style: { ...style },
  };
}

function cloneLines(lines) {
  return lines.map((line) => line.map((cell) => (cell ? createCell(cell.ch, cell.style) : cell)));
}

function trimTrailingBlankLines(lines) {
  let length = lines.length;
  while (length > 0 && getTrimmedLineLength(lines[length - 1]) === 0) {
    length -= 1;
  }
  return lines.slice(0, length);
}

function renderLineHtml(line) {
  let html = "";
  let runText = "";
  let runStyle = null;

  const flush = () => {
    if (!runText) return;
    const escaped = escapeHtml(runText);
    const style = styleToCss(runStyle);
    html += style ? `<span style="${style}">${escaped}</span>` : escaped;
    runText = "";
  };

  const trimmedLength = getTrimmedLineLength(line);
  for (let i = 0; i < trimmedLength; i += 1) {
    const cell = line[i] || createCell(" ", createDefaultStyle());
    if (!runStyle || !stylesEqual(runStyle, cell.style)) {
      flush();
      runStyle = cell.style;
    }
    runText += cell.ch;
  }
  flush();
  return html;
}

function getTrimmedLineLength(line) {
  let length = line.length;
  while (length > 0) {
    const cell = line[length - 1];
    const ch = cell?.ch || " ";
    if (ch !== " " && ch !== "\t") break;
    if (styleToCss(cell?.style)) break;
    length -= 1;
  }
  return length;
}

function styleToCss(style) {
  if (!style) return "";
  const declarations = [];
  let fg = style.inverse
    ? (style.bg || `var(--term-default-bg, ${DEFAULT_BACKGROUND})`)
    : style.fg;
  let bg = style.inverse
    ? (style.fg || `var(--term-default-fg, ${DEFAULT_FOREGROUND})`)
    : style.bg;
  // Theme the normal page foreground, but preserve the original color pair
  // when output supplies a background (including a foreground inverted into
  // one). Darkening foregrounds independently can make these runs unreadable.
  if (style.bg || (style.inverse && style.fg)) {
    const originalColor = (color) => color?.replace(/var\(--[\w-]+, (#[a-f0-9]{6})\)/g, "$1");
    fg = originalColor(fg) || DEFAULT_FOREGROUND;
    bg = originalColor(bg);
  } else if (fg?.startsWith("#")) {
    // The wrapper supplies a readable light variant for extended/true colors.
    fg = `var(--term-custom-${fg.slice(1)}, ${fg})`;
  }
  if (fg) declarations.push(`color: ${fg}`);
  if (bg) declarations.push(`background-color: ${bg}`);
  if (style.bold) declarations.push("font-weight: 700");
  if (style.italic) declarations.push("font-style: italic");
  if (style.underline) declarations.push("text-decoration: underline");
  return declarations.join("; ");
}

function stylesEqual(a, b) {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.inverse === b.inverse
  );
}

function colorFromAnsi256(value) {
  if (!Number.isInteger(value) || value < 0 || value > 255) return null;
  if (value < 16) return ansiColorVar(value);
  if (value < 232) {
    const n = value - 16;
    const r = Math.floor(n / 36);
    const g = Math.floor((n % 36) / 6);
    const b = n % 6;
    return colorFromRgb(colorCubeValue(r), colorCubeValue(g), colorCubeValue(b));
  }
  const level = 8 + (value - 232) * 10;
  return colorFromRgb(level, level, level);
}

function colorCubeValue(n) {
  return n === 0 ? 0 : 55 + n * 40;
}

function colorFromRgb(r, g, b) {
  if (![r, g, b].every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return null;
  }
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

function hex2(value) {
  return value.toString(16).padStart(2, "0");
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
