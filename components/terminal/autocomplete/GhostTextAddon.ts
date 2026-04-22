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
  private disposed = false;
  private disposables: IDisposable[] = [];
  private lastLeft = -1;
  private lastTop = -1;
  /**
   * Input that adjustToInput() wants to reflect on the ghost, deferred
   * until the next xterm render. We don't apply it synchronously because
   * at adjustToInput call time the triggering keystroke hasn't been
   * echoed yet — cursorX is still at the pre-keystroke position, so
   * painting a shrunken ghost there would overlap with the char xterm
   * is about to draw. Hiding during the gap and re-showing on the
   * render tick that follows the echo gives a clean transition.
   */
  private pendingInput: string | null = null;

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

    // Every xterm render tick is also our chance to apply a pending
    // adjustToInput: at this point the echoed keystroke has advanced
    // cursorX, so the recomputed ghost can paint at the correct column.
    this.disposables.push(
      term.onRender(() => {
        if (this.pendingInput !== null) {
          const input = this.pendingInput;
          this.pendingInput = null;
          this.applyInputUpdate(input);
        } else if (this.isVisible()) {
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

    // Explicit show() supersedes any pending adjust — caller already
    // passed the input they want reflected.
    this.pendingInput = null;
    this.currentSuggestion = fullSuggestion;
    this.currentInput = currentInput;

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
    this.pendingInput = null;
  }

  /**
   * Re-align the ghost against a freshly-updated user input without
   * waiting for the next debounced suggestion fetch. Called from every
   * handleInput keystroke that mutates the typed buffer.
   *
   * Painting the updated tail synchronously would misalign it, because
   * at keystroke time xterm hasn't echoed the char yet (cursorX hasn't
   * advanced). We therefore hide the ghost immediately to avoid an
   * overlap flicker with the char xterm is about to draw, and stash
   * the desired state. The onRender listener above then paints at the
   * correct column once xterm has processed the echo.
   *
   * If the current suggestion no longer prefix-matches the new input,
   * we drop it entirely — a later fetchSuggestions will replace it.
   */
  adjustToInput(newInput: string): void {
    if (this.disposed || !this.ghostElement || !this.currentSuggestion) return;
    if (this.currentSuggestion.startsWith(newInput)) {
      this.pendingInput = newInput;
      // Hide the stale tail but keep currentSuggestion so applyInputUpdate
      // can restore it on the next render.
      this.ghostElement.style.display = "none";
    } else {
      this.pendingInput = null;
      this.hide();
    }
  }

  /** Apply a pending input update — called from the onRender hook. */
  private applyInputUpdate(input: string): void {
    if (this.disposed || !this.ghostElement || !this.term) return;
    if (!this.currentSuggestion || !this.currentSuggestion.startsWith(input)) {
      this.hide();
      return;
    }
    const ghostText = this.currentSuggestion.substring(input.length);
    if (!ghostText) {
      this.hide();
      return;
    }
    this.currentInput = input;
    this.ghostElement.textContent = ghostText;
    this.ghostElement.style.fontSize = `${this.term.options.fontSize}px`;
    this.ghostElement.style.fontFamily = this.term.options.fontFamily || "inherit";
    // Force position recomputation after reshowing.
    this.lastLeft = -1;
    this.lastTop = -1;
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
   * hidden waiting for a render-tick (post-adjustToInput). Accept-path
   * gates should use this instead of isVisible() so a fast "type + →"
   * during the hide/re-show gap still accepts the correct suggestion.
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

    const buffer = this.term.buffer.active;
    const left = buffer.cursorX * dims.width;
    const top = buffer.cursorY * dims.height;

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
