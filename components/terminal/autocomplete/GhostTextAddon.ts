/**
 * Ghost Text addon for xterm.js.
 * Renders inline suggestion text after the cursor in a dimmed style,
 * similar to fish shell's autosuggestions.
 *
 * Uses a CSS overlay positioned relative to the terminal cursor,
 * avoiding modification of the terminal buffer.
 */

import type { Terminal as XTerm, IDisposable } from "@xterm/xterm";

export class GhostTextAddon implements IDisposable {
  private term: XTerm | null = null;
  private ghostElement: HTMLSpanElement | null = null;
  private containerElement: HTMLDivElement | null = null;
  private currentSuggestion: string = "";
  private currentInput: string = "";
  private disposed = false;

  activate(term: XTerm): void {
    this.term = term;

    // Create the overlay container
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

    // Insert into the xterm screen element
    const screenEl = termElement.querySelector(".xterm-screen");
    if (screenEl) {
      screenEl.appendChild(this.containerElement);
    } else {
      termElement.appendChild(this.containerElement);
    }
  }

  /**
   * Show ghost text suggestion.
   * @param fullSuggestion The complete suggested command
   * @param currentInput The text the user has typed so far
   */
  show(fullSuggestion: string, currentInput: string): void {
    if (this.disposed || !this.ghostElement || !this.term) return;

    // The ghost text is the remaining portion after what's already typed
    const ghostText = fullSuggestion.startsWith(currentInput)
      ? fullSuggestion.substring(currentInput.length)
      : "";

    if (!ghostText) {
      this.hide();
      return;
    }

    this.currentSuggestion = fullSuggestion;
    this.currentInput = currentInput;

    // Calculate position based on cursor
    this.updatePosition();
    this.ghostElement.textContent = ghostText;
    this.ghostElement.style.display = "block";
  }

  /**
   * Hide the ghost text.
   */
  hide(): void {
    if (this.ghostElement) {
      this.ghostElement.style.display = "none";
      this.ghostElement.textContent = "";
    }
    this.currentSuggestion = "";
    this.currentInput = "";
  }

  /**
   * Get the current suggestion text (full command, not just ghost portion).
   */
  getSuggestion(): string {
    return this.currentSuggestion;
  }

  /**
   * Check if ghost text is currently visible.
   */
  isVisible(): boolean {
    return !!(this.ghostElement && this.ghostElement.style.display !== "none" &&
      this.currentSuggestion);
  }

  /**
   * Get the ghost text portion (the part not yet typed).
   */
  getGhostText(): string {
    if (!this.currentSuggestion || !this.currentInput) return "";
    return this.currentSuggestion.startsWith(this.currentInput)
      ? this.currentSuggestion.substring(this.currentInput.length)
      : "";
  }

  /**
   * Accept the first word of the ghost text.
   * Returns the text to insert, or empty string if nothing to accept.
   */
  getNextWord(): string {
    const ghost = this.getGhostText();
    if (!ghost) return "";

    // Find the end of the next word
    const trimmed = ghost.replace(/^\s+/, "");
    const leadingSpace = ghost.length - trimmed.length;

    if (trimmed.length === 0) return ghost; // Only whitespace

    const wordEnd = trimmed.search(/[\s/\\-]/);
    if (wordEnd <= 0) {
      return ghost; // Single word or no separator found
    }

    // Include leading whitespace + the word + the separator
    return ghost.substring(0, leadingSpace + wordEnd + 1);
  }

  /**
   * Update ghost text position relative to cursor.
   */
  private updatePosition(): void {
    if (!this.term || !this.ghostElement) return;

    const term = this.term;
    const termElement = term.element;
    if (!termElement) return;

    // Get cell dimensions from xterm
    const cellWidth = this.getCellWidth();
    const cellHeight = this.getCellHeight();

    if (cellWidth <= 0 || cellHeight <= 0) return;

    const buffer = term.buffer.active;
    const cursorX = buffer.cursorX;
    const cursorY = buffer.cursorY;

    // Position at cursor location
    const left = cursorX * cellWidth;
    const top = cursorY * cellHeight;

    this.ghostElement.style.left = `${left}px`;
    this.ghostElement.style.top = `${top}px`;
    this.ghostElement.style.fontSize = `${term.options.fontSize}px`;
    this.ghostElement.style.fontFamily = term.options.fontFamily || "inherit";
    this.ghostElement.style.lineHeight = `${cellHeight}px`;
    this.ghostElement.style.height = `${cellHeight}px`;
  }

  /**
   * Get cell width using the core renderer dimensions.
   */
  private getCellWidth(): number {
    const term = this.term as XTerm & {
      _core?: { _renderService?: { dimensions?: { css?: { cell?: { width: number } } } } };
    };
    const w = term._core?._renderService?.dimensions?.css?.cell?.width;
    if (w && w > 0) return w;

    // Fallback: measure from DOM
    return this.measureCellDimension("width");
  }

  /**
   * Get cell height using the core renderer dimensions.
   */
  private getCellHeight(): number {
    const term = this.term as XTerm & {
      _core?: { _renderService?: { dimensions?: { css?: { cell?: { height: number } } } } };
    };
    const h = term._core?._renderService?.dimensions?.css?.cell?.height;
    if (h && h > 0) return h;

    // Fallback: measure from DOM
    return this.measureCellDimension("height");
  }

  /**
   * Fallback cell dimension measurement using a temporary character cell.
   */
  private measureCellDimension(dim: "width" | "height"): number {
    if (!this.term?.element) return dim === "width" ? 8 : 16;

    const span = document.createElement("span");
    span.textContent = "W";
    Object.assign(span.style, {
      position: "absolute",
      visibility: "hidden",
      fontFamily: this.term.options.fontFamily || "monospace",
      fontSize: `${this.term.options.fontSize}px`,
      lineHeight: "normal",
    });
    this.term.element.appendChild(span);
    const value = dim === "width" ? span.offsetWidth : span.offsetHeight;
    span.remove();
    return value || (dim === "width" ? 8 : 16);
  }

  dispose(): void {
    this.disposed = true;
    this.containerElement?.remove();
    this.containerElement = null;
    this.ghostElement = null;
    this.term = null;
  }
}
