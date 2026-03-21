
import { Terminal as XTerm, IDecoration, IDisposable, IMarker, IBufferLine } from "@xterm/xterm";
import { KeywordHighlightRule } from "../../types";

import { XTERM_PERFORMANCE_CONFIG } from "../../infrastructure/config/xtermPerformance";

/** Pre-compiled rule with regex ready for matching */
interface CompiledRule {
  regex: RegExp;
  color: string;
}

/**
 * Manages terminal decorations for keyword highlighting.
 * Uses xterm.js Decoration API to overlay styles without modifying the data stream.
 * This ensures zero impact on scrolling performance ("lazy" highlighting).
 */
export class KeywordHighlighter implements IDisposable {
  private term: XTerm;
  private compiledRules: CompiledRule[] = [];
  private decorations: { decoration: IDecoration; marker: IMarker }[] = [];
  private debounceTimer: NodeJS.Timeout | null = null;
  private enabled: boolean = false;
  private disposables: IDisposable[] = [];
  private lastViewportY: number = -1;

  constructor(term: XTerm) {
    this.term = term;

    // Hook into terminal events to trigger highlighting
    this.disposables.push(
      // When user scrolls, refresh visible area
      this.term.onScroll(() => {
        // console.log('[KeywordHighlighter] onScroll');
        this.triggerRefresh();
      }),
      // When new data is written, refresh
      this.term.onWriteParsed(() => {
        // console.log('[KeywordHighlighter] onWriteParsed');
        this.triggerRefresh();
      }),
      // Also refresh on resize as viewport content changes
      this.term.onResize(() => this.triggerRefresh()),
      // onRender fires after each render cycle - catch scrolls that onScroll might miss
      this.term.onRender(() => {
        // Only trigger refresh if viewport position changed
        const currentViewportY = this.term.buffer.active?.viewportY ?? 0;
        if (currentViewportY !== this.lastViewportY) {
          this.lastViewportY = currentViewportY;
          this.triggerRefresh();
        }
      })
    );
  }

  public setRules(rules: KeywordHighlightRule[], enabled: boolean) {
    this.enabled = enabled;

    // Pre-compile all patterns into regexes for better performance
    // This avoids creating new RegExp objects on every viewport refresh
    this.compiledRules = [];
    for (const rule of rules) {
      if (!rule.enabled || rule.patterns.length === 0) continue;
      for (const pattern of rule.patterns) {
        try {
          this.compiledRules.push({
            regex: new RegExp(pattern, "gi"),
            color: rule.color,
          });
        } catch (err) {
          console.error("Invalid regex pattern:", pattern, err);
        }
      }
    }

    // Clear existing and force an immediate refresh if enabling
    this.clearDecorations();
    if (this.enabled && this.compiledRules.length > 0) {
      this.triggerRefresh();
    }
  }

  public dispose() {
    this.clearDecorations();
    this.disposables.forEach(d => d.dispose());
    this.disposables = [];
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
  }

  private triggerRefresh() {
    if (!this.enabled || this.compiledRules.length === 0) return;

    // Optimization: Disable highlighting in Alternate Buffer (e.g. Vim, Htop)
    // These apps manage their own highlighting and have rapid repaints.
    if (this.term.buffer.active.type === 'alternate') {
      if (this.decorations.length > 0) {
        this.clearDecorations();
      }
      return;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    const delay = XTERM_PERFORMANCE_CONFIG.highlighting.debounceMs;
    this.debounceTimer = setTimeout(() => this.refreshViewport(), delay);
  }

  private clearDecorations() {
    this.decorations.forEach(({ decoration, marker }) => {
      decoration.dispose();
      marker.dispose();
    });
    this.decorations = [];
  }

  /**
   * Build a mapping from string character index to terminal cell column.
   * This handles wide characters (CJK, emoji) and combining characters correctly.
   *
   * For example, with "A中B":
   * - String indices: 0='A', 1='中', 2='B'
   * - Cell columns:   0='A', 1='中'(width 2), 3='B'
   * - Result map: [0, 1, 3, 4] (includes end position)
   */
  private buildStringToCellMap(line: IBufferLine): number[] {
    const map: number[] = [];
    let cellCol = 0;

    for (let col = 0; col < line.length; col++) {
      const cell = line.getCell(col);
      if (!cell) break;

      const chars = cell.getChars();
      const width = cell.getWidth();

      // Skip continuation cells (width 0) - these are the 2nd cell of wide characters
      if (width === 0) continue;

      // Map each character in this cell to the current cell column
      for (let i = 0; i < chars.length; i++) {
        map.push(cellCol);
      }

      cellCol += width;
    }

    // Add final position for calculating end column of matches
    map.push(cellCol);

    return map;
  }

  private refreshViewport() {
    // Safety check just in case
    if (!this.term?.buffer?.active) return;

    const buffer = this.term.buffer.active;
    const viewportY = buffer.viewportY;
    const rows = this.term.rows;
    const cursorY = buffer.cursorY;
    const baseY = buffer.baseY;
    const cursorAbsoluteY = baseY + cursorY;

    // Clear old decorations to avoid duplicates/memory leaks
    this.clearDecorations();

    // Iterate only over the visible rows
    for (let y = 0; y < rows; y++) {
      const lineY = viewportY + y;
      const line = buffer.getLine(lineY);
      if (!line) continue;

      const lineText = line.translateToString(true); // true = trim right whitespace
      if (!lineText) continue;

      // Build mapping from string index to cell column for wide char support
      const cellMap = this.buildStringToCellMap(line);

      // Process each pre-compiled rule
      for (const { regex, color } of this.compiledRules) {
        // Reset regex state for reuse (global flag maintains lastIndex)
        regex.lastIndex = 0;
        let match;

        while ((match = regex.exec(lineText)) !== null) {
          const strStart = match.index;
          const strEnd = strStart + match[0].length;

          // Map string indices to cell columns
          const cellStartCol = cellMap[strStart] ?? strStart;
          const cellEndCol = cellMap[strEnd] ?? strEnd;
          const cellWidth = cellEndCol - cellStartCol;

          // Skip if width is 0 or negative (shouldn't happen, but be safe)
          if (cellWidth <= 0) continue;

          // Calculate offset relative to the absolute cursor position
          // offset = targetLineAbs - (baseY + cursorY)
          const offset = lineY - cursorAbsoluteY;
          const marker = this.term.registerMarker(offset);

          if (marker) {
            const deco = this.term.registerDecoration({
              marker,
              x: cellStartCol,
              width: cellWidth,
              foregroundColor: color,
            });

            if (deco) {
              this.decorations.push({ decoration: deco, marker });
            } else {
              // If decoration failed, cleanup marker
              marker.dispose();
            }
          }
        }
      }
    }
  }
}
