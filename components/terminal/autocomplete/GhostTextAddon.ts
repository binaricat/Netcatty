/**
 * Ghost Text addon for xterm.js.
 * Renders inline suggestion text after the cursor in a dimmed style,
 * similar to fish shell's autosuggestions.
 *
 * Uses a CSS overlay positioned relative to the terminal cursor,
 * avoiding modification of the terminal buffer.
 */

import type { Terminal as XTerm, IDisposable } from "@xterm/xterm";
import { getXTermCellDimensions, invalidateCellDimensionCache } from "./xtermUtils";
import { lineHasUntrackedTrailingInput } from "./ghostTextConsistency";

/**
 * Minimal East-Asian-Width-style classifier: returns 2 for wide glyphs
 * (CJK ideographs, fullwidth forms, most emoji, hangul syllables) and
 * 1 otherwise. Not full wcwidth — just enough to keep the predicted
 * ghost column from drifting by one cell per CJK char typed.
 */
function codePointCellWidth(cp: number): number {
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||   // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) ||   // CJK Radicals, Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) ||   // Hiragana, Katakana, CJK Compat
    (cp >= 0x3400 && cp <= 0x4dbf) ||   // CJK Extension A
    (cp >= 0x4e00 && cp <= 0x9fff) ||   // CJK Unified Ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) ||   // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) ||   // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK Compat Ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) ||   // CJK Compat Forms
    (cp >= 0xff00 && cp <= 0xff60) ||   // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||   // Fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1faff) || // Emoji blocks
    (cp >= 0x20000 && cp <= 0x3fffd)    // CJK Extension B-F, G
  ) {
    return 2;
  }
  return 1;
}

function stringCellWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    w += codePointCellWidth(cp);
  }
  return w;
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i += 1;
  return i;
}

function hasVisibleGhostPrefix(ghostText: string, afterCursor: string): boolean {
  if (!ghostText || !afterCursor) return false;
  const visibleAfterCursor = afterCursor.trimEnd();
  const overlap = commonPrefixLength(ghostText, visibleAfterCursor);
  if (overlap <= 0) return false;
  if (ghostText.slice(0, overlap).trim().length === 0) return false;
  return (
    overlap === ghostText.length ||
    overlap === visibleAfterCursor.length ||
    afterCursor[overlap] === " "
  );
}

export class GhostTextAddon implements IDisposable {
  private term: XTerm | null = null;
  private ghostElement: HTMLSpanElement | null = null;
  private hintElement: HTMLSpanElement | null = null;
  private hintActive = false;
  private containerElement: HTMLDivElement | null = null;
  private currentSuggestion: string = "";
  private currentInput: string = "";
  /** Cursor column captured at show() time — the anchor the ghost was painted from. */
  private anchorCursorX = 0;
  /** Cursor row captured at show() time. */
  private anchorCursorY = 0;
  /** Length of currentInput at show() time — lets adjustToInput shift left
   *  by (newInput.length - anchorInputLength) cells without having to
   *  re-read xterm's cursorX (which hasn't advanced yet at keystroke time). */
  private anchorInputLength = 0;
  private disposed = false;
  private disposables: IDisposable[] = [];
  private lastLeft = -1;
  private lastTop = -1;

  activate(term: XTerm): void {
    this.term = term;

    const termElement = term.element;
    if (!termElement) return;

    this.containerElement = document.createElement("div");
    this.containerElement.className = "xterm-ghost-text-container";
    Object.assign(this.containerElement.style, {
      position: "absolute",
      top: "0",
      left: "0",
      width: "100%",
      height: "100%",
      pointerEvents: "none",
      overflow: "hidden",
      // Sit above xterm's canvas — xterm's default renderer paints its
      // theme.background across every cell including empty ones, so a
      // ghost placed beneath the canvas would be completely occluded.
      zIndex: "1",
    });

    this.ghostElement = document.createElement("span");
    this.ghostElement.className = "xterm-ghost-text";
    Object.assign(this.ghostElement.style, {
      position: "absolute",
      opacity: "0.4",
      pointerEvents: "none",
      whiteSpace: "pre",
      fontFamily: "inherit",
      fontSize: "inherit",
      lineHeight: "inherit",
      color: "inherit",
      display: "none",
    });

    this.containerElement.appendChild(this.ghostElement);

    // Read-only inline hint (e.g. sudo "press Enter to paste password"). Shown
    // independently of autocomplete suggestions and never accepted as input.
    this.hintElement = document.createElement("span");
    this.hintElement.className = "xterm-inline-hint";
    Object.assign(this.hintElement.style, {
      position: "absolute",
      opacity: "0.4",
      pointerEvents: "none",
      whiteSpace: "pre",
      fontFamily: "inherit",
      fontSize: "inherit",
      lineHeight: "inherit",
      color: "inherit",
      display: "none",
    });
    this.containerElement.appendChild(this.hintElement);

    const screenEl = termElement.querySelector(".xterm-screen");
    if (screenEl) {
      screenEl.appendChild(this.containerElement);
    } else {
      termElement.appendChild(this.containerElement);
    }

    this.disposables.push(
      term.onRender(() => {
        if (this.hintActive) this.updateHintPosition();
        if (!this.isVisible()) return;
        // Fail-safe: if the device echoed input we didn't track (some bastion
        // hosts / network OS, #1013/#1060), hide rather than draw the ghost
        // over already-visible text. Done here (post-echo render) rather than
        // in show()/adjustToInput so it never fights the keystroke-time path.
        if (this.realLineHasUntrackedInput()) {
          this.hide();
          return;
        }
        this.updatePosition();
      }),
    );

    // Invalidate cell dimension cache on resize so measurements stay
    // accurate, and force a pixel-coord recompute on the next render —
    // otherwise the lastLeft/lastTop short-circuit in updatePosition
    // would keep the ghost at stale pixel coordinates until the user
    // typed again.
    this.disposables.push(
      term.onResize(() => {
        invalidateCellDimensionCache();
        this.lastLeft = -1;
        this.lastTop = -1;
        if (this.isVisible()) this.updatePosition();
        if (this.hintActive) this.updateHintPosition();
      }),
    );
  }

  /**
   * Show ghost text suggestion.
   * @param fullSuggestion The complete suggested command
   * @param currentInput The text the user has typed so far
   */
  show(fullSuggestion: string, currentInput: string): void {
    if (this.disposed || !this.ghostElement || !this.term) return;

    const ghostText = fullSuggestion.startsWith(currentInput)
      ? fullSuggestion.substring(currentInput.length)
      : "";

    if (!ghostText) {
      this.hide();
      return;
    }

    this.currentSuggestion = fullSuggestion;
    this.currentInput = currentInput;
    this.anchorCursorX = this.term.buffer.active.cursorX;
    this.anchorCursorY = this.term.buffer.active.cursorY;
    this.anchorInputLength = currentInput.length;
    // Force position recalc since the text also changed.
    this.lastLeft = -1;
    this.lastTop = -1;

    this.updatePosition();
    this.ghostElement.textContent = ghostText;
    this.ghostElement.style.display = "block";
    // Set font properties once per show (not per frame in updatePosition)
    this.ghostElement.style.fontSize = `${this.term.options.fontSize}px`;
    this.ghostElement.style.fontFamily = this.term.options.fontFamily || "inherit";
  }

  hide(): void {
    if (this.ghostElement) {
      this.ghostElement.style.display = "none";
      this.ghostElement.textContent = "";
    }
    this.currentSuggestion = "";
    this.currentInput = "";
    this.anchorInputLength = 0;
  }

  /** Show a read-only inline hint at the cursor (e.g. a sudo password prompt
   *  hint). Independent of autocomplete suggestions; never accepted as input. */
  showHint(text: string): void {
    if (this.disposed || !this.hintElement || !this.term) return;
    this.hintActive = true;
    this.hintElement.textContent = text;
    this.hintElement.style.display = "block";
    this.hintElement.style.fontSize = `${this.term.options.fontSize}px`;
    this.hintElement.style.fontFamily = this.term.options.fontFamily || "inherit";
    this.updateHintPosition();
  }

  hideHint(): void {
    this.hintActive = false;
    if (this.hintElement) {
      this.hintElement.style.display = "none";
      this.hintElement.textContent = "";
    }
  }

  isHintActive(): boolean {
    return this.hintActive;
  }

  private updateHintPosition(): void {
    if (!this.term || !this.hintElement) return;
    const dims = getXTermCellDimensions(this.term);
    const buf = this.term.buffer.active;
    this.hintElement.style.left = `${buf.cursorX * dims.width}px`;
    this.hintElement.style.top = `${buf.cursorY * dims.height}px`;
    this.hintElement.style.lineHeight = `${dims.height}px`;
    this.hintElement.style.height = `${dims.height}px`;
  }

  /**
   * Re-align the ghost against a freshly-updated user input synchronously.
   * Called from handleInput on every keystroke that mutates the typed
   * buffer so ghost text never falls out of sync with what the user has
   * actually typed.
   *
   * Implementation relies on the predict-anchor-shift trick rather than
   * re-reading xterm's live cursorX: xterm hasn't echoed the triggering
   * keystroke yet at this point, so cursorX still points at the
   * pre-keystroke column. Instead we track the cursor column captured
   * at show() time and advance the ghost's left by the number of chars
   * typed since — so the tail aligns with where the real cursor *will*
   * land once the echo arrives, even across SSH round-trip latency.
   */
  adjustToInput(newInput: string): void {
    if (this.disposed || !this.ghostElement || !this.currentSuggestion) return;
    if (!this.currentSuggestion.startsWith(newInput)) {
      this.hide();
      return;
    }
    this.currentInput = newInput;
    const ghostText = this.currentSuggestion.substring(newInput.length);
    if (!ghostText) {
      this.hide();
      return;
    }
    // Force position recomputation — updatePosition skips DOM writes
    // when the left/top cache hasn't changed, but we also need the new
    // textContent to flush.
    this.lastLeft = -1;
    this.lastTop = -1;
    this.ghostElement.textContent = ghostText;
    this.updatePosition();
    this.ghostElement.style.display = "block";
  }

  /**
   * Apply a single keystroke's effect to the ghost without consulting the
   * outer typed-input buffer. Used when that buffer's reliability flag is
   * off (post-Tab, history recall, cursor moves) — without this hook the
   * gate at handleInput's adjustToInput call would freeze the ghost at
   * the previous show()'s tail, and a subsequent → -accept would paste
   * that stale tail on top of the chars typed in the meantime
   * (sttop/dduplicate-glyph bug, issue #906).
   *
   * Only forwards events the ghost can locally re-derive: a printable
   * char appends, Backspace/DEL slices off one char, Ctrl-W performs
   * the same trailing-word erase as zsh/bash. Anything else (escape
   * sequences, other control codes) is treated as a no-op — those
   * paths already clearState() in handleInput, so by the time the user
   * could trigger an accept, the ghost is gone.
   */
  applyKeystroke(data: string): void {
    if (this.disposed || !this.currentSuggestion || !data) return;
    let nextInput: string;
    if (data === "\x7f" || data === "\b") {
      if (this.currentInput.length === 0) return;
      nextInput = this.currentInput.slice(0, -1);
    } else if (data === "\x17") {
      const erased = this.currentInput.replace(/\s*\S+\s*$/, "");
      if (erased === this.currentInput) return;
      nextInput = erased;
    } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
      nextInput = this.currentInput + data;
    } else {
      return;
    }
    this.adjustToInput(nextInput);
  }

  getSuggestion(): string {
    return this.currentSuggestion;
  }

  isVisible(): boolean {
    return !!(this.ghostElement && this.ghostElement.style.display !== "none" &&
      this.currentSuggestion);
  }

  /**
   * True when the ghost has a live suggestion even if it's momentarily
   * shown underneath the real text while the user keeps typing within
   * the prediction. Accept-path gates should use this instead of
   * isVisible() so the suggestion remains available even while its
   * leading characters are fully covered by real glyphs.
   */
  isActive(): boolean {
    return !this.disposed && !!this.currentSuggestion;
  }

  getGhostText(): string {
    if (!this.currentSuggestion) return "";
    return this.currentSuggestion.startsWith(this.currentInput)
      ? this.currentSuggestion.substring(this.currentInput.length)
      : "";
  }

  getNextWord(): string {
    const ghost = this.getGhostText();
    if (!ghost) return "";

    const trimmed = ghost.replace(/^\s+/, "");
    const leadingSpace = ghost.length - trimmed.length;

    if (trimmed.length === 0) return ghost; // Only whitespace

    // Search for word boundary starting from index 1 (skip leading separator chars like /)
    const wordEnd = trimmed.substring(1).search(/[\s/\\-]/);
    if (wordEnd < 0) return ghost; // Single word, accept all

    // Include leading whitespace + the word up to (and including) the separator
    return ghost.substring(0, leadingSpace + 1 + wordEnd + 1);
  }

  /**
   * True when the real terminal line has input we did not track, or already
   * visible text exactly matches the ghost we are about to paint. See
   * ./ghostTextConsistency and issues #1013 and #1060. Returns false on
   * hosts/inputs we can't judge (non-ASCII, echo still catching up), so the
   * ghost only gets suppressed when corruption is actually imminent.
   */
  private realLineHasUntrackedInput(): boolean {
    if (!this.term) return false;
    const buf = this.term.buffer.active;
    if (typeof buf?.getLine !== "function") return false;
    const line = buf.getLine(buf.baseY + buf.cursorY);
    if (!line || typeof line.translateToString !== "function") return false;
    const lineText = line.translateToString(false);
    const beforeCursor = lineText.slice(0, buf.cursorX);
    const afterCursor = lineText.slice(buf.cursorX);
    const ghostText = this.getGhostText();
    if (hasVisibleGhostPrefix(ghostText, afterCursor)) return true;
    if (!this.currentInput) return false;
    return lineHasUntrackedTrailingInput(this.currentInput, beforeCursor);
  }

  private updatePosition(): void {
    if (!this.term || !this.ghostElement) return;

    // Self-heal a stale anchor: when show() fires during the SSH
    // keystroke→echo gap, cursorX captured there is still the
    // pre-echo column. While no adjustToInput has moved us from the
    // show-time baseline, re-read live cursor on each render tick so
    // the anchor snaps to the echoed position once it arrives.
    if (this.currentInput.length === this.anchorInputLength) {
      this.anchorCursorX = this.term.buffer.active.cursorX;
      this.anchorCursorY = this.term.buffer.active.cursorY;
    }

    const dims = getXTermCellDimensions(this.term);

    // Advance (or walk back) the anchor column by the cell width of
    // whatever the user has typed since show() was called. Using cell
    // width (not code-unit length) lets CJK / emoji / fullwidth glyphs
    // advance by 2 cells instead of 1. Backspace / Ctrl-W produces a
    // negative delta by shrinking currentInput below anchorInputLength.
    const cellDelta = this.currentInput.length >= this.anchorInputLength
      ? stringCellWidth(this.currentInput.slice(this.anchorInputLength))
      : -stringCellWidth(
          // currentSuggestion[0..anchorInputLength] equals what was typed
          // when show() fired (prefix-match invariant), so its slice gives
          // the correct cell widths for the deleted glyphs.
          this.currentSuggestion.slice(this.currentInput.length, this.anchorInputLength),
        );
    const cols = Math.max(1, this.term.cols);
    const targetCol = this.anchorCursorX + cellDelta;
    // Wrap the predicted cursor position across line boundaries in both
    // directions — the real xterm cursor wraps to the next row once it
    // crosses cols forward, and to the previous row when a deletion
    // crosses back past column 0. JS `%` returns negative for negative
    // dividends, so normalize both col and rowOffset explicitly.
    let col = targetCol % cols;
    let rowOffset = Math.floor(targetCol / cols);
    if (col < 0) {
      col += cols;
    }
    // Clamp to the visible top row so a runaway negative delta (e.g.
    // deleted past the prompt) doesn't render above the terminal.
    const top = Math.max(0, this.anchorCursorY + rowOffset) * dims.height;
    const left = col * dims.width;

    // Skip DOM writes if position hasn't changed (avoids unnecessary style recalc)
    if (left === this.lastLeft && top === this.lastTop) return;
    this.lastLeft = left;
    this.lastTop = top;

    this.ghostElement.style.left = `${left}px`;
    this.ghostElement.style.top = `${top}px`;
    this.ghostElement.style.lineHeight = `${dims.height}px`;
    this.ghostElement.style.height = `${dims.height}px`;
  }

  dispose(): void {
    this.disposed = true;
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.containerElement?.remove();
    this.containerElement = null;
    this.ghostElement = null;
    this.hintElement = null;
    this.term = null;
  }
}
