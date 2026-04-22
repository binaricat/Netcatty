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

export class GhostTextAddon implements IDisposable {
  private term: XTerm | null = null;
  private ghostElement: HTMLSpanElement | null = null;
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

    const screenEl = termElement.querySelector(".xterm-screen");
    if (screenEl) {
      screenEl.appendChild(this.containerElement);
    } else {
      termElement.appendChild(this.containerElement);
    }

    this.disposables.push(
      term.onRender(() => {
        if (this.isVisible()) {
          this.updatePosition();
        }
      }),
    );

    // Invalidate cell dimension cache on resize so measurements stay accurate
    this.disposables.push(
      term.onResize(() => {
        invalidateCellDimensionCache();
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
    if (!this.currentSuggestion || !this.currentInput) return "";
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

  private updatePosition(): void {
    if (!this.term || !this.ghostElement) return;

    const dims = getXTermCellDimensions(this.term);

    // Advance the anchor column by however many chars the user has typed
    // since show() was called. This mirrors where the real cursor will
    // land after the echo, so the ghost's first visible column lines up
    // with the tail we want it to show.
    const charsSinceAnchor = Math.max(0, this.currentInput.length - this.anchorInputLength);
    const left = (this.anchorCursorX + charsSinceAnchor) * dims.width;
    const top = this.anchorCursorY * dims.height;

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
    this.term = null;
  }
}
