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

    // Update position on scroll and render to keep ghost text aligned
    this.disposables.push(
      term.onRender(() => {
        if (this.isVisible()) this.updatePosition();
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
  }

  getSuggestion(): string {
    return this.currentSuggestion;
  }

  isVisible(): boolean {
    return !!(this.ghostElement && this.ghostElement.style.display !== "none" &&
      this.currentSuggestion);
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
