import type { Terminal as XTerm } from "@xterm/xterm";
import type { CompletionSuggestion } from "./completionEngine";
import type { PromptDetectionResult } from "./promptDetector";
import type { SubDirPanel } from "./useTerminalAutocomplete";
import { stringCellWidth } from "./terminalStringCellWidth";
import { getXTermCellDimensions } from "./xtermUtils";

export function resolveAutocompleteCwd(
  promptText: string,
  currentWord: string,
  fallbackCwd: string | undefined,
  os: "linux" | "windows" | "macos",
): string | undefined {
  return resolveAutocompleteCwdWithSource(promptText, currentWord, fallbackCwd, os).cwd;
}

export type AutocompleteCwdSource = "prompt" | "fallback" | "none";

export function resolveAutocompleteCwdWithSource(
  promptText: string,
  currentWord: string,
  fallbackCwd: string | undefined,
  os: "linux" | "windows" | "macos",
): { cwd: string | undefined; source: AutocompleteCwdSource } {
  if (os === "windows") return { cwd: fallbackCwd, source: fallbackCwd ? "fallback" : "none" };

  const normalizedWord = currentWord.trim().replace(/^['"]/, "");

  // Absolute or home-relative paths don't depend on cwd
  if (normalizedWord.startsWith("/") || normalizedWord.startsWith("~/")) {
    return { cwd: fallbackCwd, source: fallbackCwd ? "fallback" : "none" };
  }

  // For empty word (e.g. "cd ") and relative paths, try prompt-based cwd
  // extraction which reflects the current visible prompt — more up-to-date
  // than fallbackCwd when OSC 7 is not supported.
  const promptCwd = extractPosixCwdFromPrompt(promptText);
  return chooseAutocompleteCwdWithSource(promptCwd, fallbackCwd);
}

function chooseAutocompleteCwdWithSource(
  promptCwd: string | undefined,
  fallbackCwd: string | undefined,
): { cwd: string | undefined; source: AutocompleteCwdSource } {
  if (!promptCwd) return { cwd: fallbackCwd, source: fallbackCwd ? "fallback" : "none" };
  if (!fallbackCwd) return { cwd: promptCwd, source: "prompt" };

  // Prompt cwd is extracted from the currently visible prompt, so it tracks
  // directory changes even when OSC 7 is not supported. Prefer it over
  // fallbackCwd (which may be stale from initial connection) whenever it
  // looks like a usable path.
  if (promptCwd.startsWith("/") || promptCwd === "~" || promptCwd.startsWith("~/")) {
    return { cwd: promptCwd, source: "prompt" };
  }

  // Bare directory name (e.g. "xunlong") can't be used as a path — fallback
  return { cwd: fallbackCwd, source: fallbackCwd ? "fallback" : "none" };
}

function extractPosixCwdFromPrompt(promptText: string): string | undefined {
  const trimmed = promptText.trimEnd().replace(/[#$%>]\s*$/, "");
  if (!trimmed) return undefined;

  const patterns = [
    /:(\/[^\s\]]*|~(?:\/[^\s\]]*)?)$/,
    /\s(\/[^\s\]]*|~(?:\/[^\s\]]*)?)\]$/,
    /(^|[\s:])(\/[^\s\]]*|~(?:\/[^\s\]]*)?)$/,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (!match) continue;
    const candidate = match[match.length - 1];
    if (candidate === "/" || candidate.startsWith("/") || candidate === "~" || candidate.startsWith("~/")) {
      return candidate;
    }
  }

  const fallbackTokens = trimmed
    .split(/\s+/)
    .map((token) => token.replace(/^[([{:]+/, "").replace(/[\])}:]+$/, ""));

  for (let index = fallbackTokens.length - 1; index >= 0; index--) {
    const candidate = fallbackTokens[index];
    if (candidate === "/" || candidate.startsWith("/") || candidate === "~" || candidate.startsWith("~/")) {
      return candidate;
    }
  }

  return undefined;
}

export function areSuggestionsEqual(
  left: CompletionSuggestion[],
  right: CompletionSuggestion[],
): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    const a = left[i];
    const b = right[i];
    if (
      a.text !== b.text ||
      a.displayText !== b.displayText ||
      a.description !== b.description ||
      a.source !== b.source ||
      a.score !== b.score ||
      a.frequency !== b.frequency ||
      a.fileType !== b.fileType
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Keep a popup highlight across a same-query list refresh (e.g. late path
 * suggestions). Match the previously selected row by stable identity; if a
 * late path replaces a same-text history/plugin entry, fall back to text.
 */
export function resolvePreservedSuggestionIndex(
  previousSuggestions: CompletionSuggestion[],
  previousSelectedIndex: number,
  nextSuggestions: CompletionSuggestion[],
): number {
  if (previousSelectedIndex < 0 || previousSelectedIndex >= previousSuggestions.length) {
    return -1;
  }
  const selected = previousSuggestions[previousSelectedIndex];
  if (!selected) return -1;

  const exactIndex = nextSuggestions.findIndex(
    (candidate) =>
      candidate.text === selected.text &&
      candidate.source === selected.source &&
      candidate.displayText === selected.displayText &&
      candidate.fileType === selected.fileType,
  );
  if (exactIndex >= 0) return exactIndex;

  return nextSuggestions.findIndex((candidate) => candidate.text === selected.text);
}

export function areSubDirPanelsEqual(left: SubDirPanel[], right: SubDirPanel[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    const a = left[i];
    const b = right[i];
    if (a.dirPath !== b.dirPath || a.selectedIndex !== b.selectedIndex) return false;
    if (a.entries.length !== b.entries.length) return false;
    for (let j = 0; j < a.entries.length; j++) {
      if (a.entries[j].name !== b.entries[j].name || a.entries[j].type !== b.entries[j].type) {
        return false;
      }
    }
  }
  return true;
}

export interface PopupClampViewport {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PopupPlacementInput {
  /** Anchor (current input line) top edge, in viewport coordinates. */
  anchorTop: number;
  /** Anchor (current input line) bottom edge, in viewport coordinates. */
  anchorBottom: number;
  /** Desired left edge (cursor column), in viewport coordinates. */
  anchorLeft: number;
  viewportWidth: number;
  viewportHeight: number;
  /**
   * Optional clamp region in viewport coordinates. Defaults to the rectangle
   * `(0, 0, viewportWidth, viewportHeight)`.
   */
  clampViewport?: PopupClampViewport;
  /** Natural height the popup wants if unconstrained (main list or detail). */
  desiredHeight: number;
  /**
   * Total horizontal extent of the popup including any cascading sub-directory
   * panels and the detail tooltip — used so the whole assembly is clamped
   * inside the viewport, not just the main list.
   */
  totalWidth: number;
  /**
   * Width budget for horizontal clamping. Defaults to `totalWidth`. The detail
   * tooltip is rendered beside the list and can extend left on its own, so
   * callers may pass a smaller width to keep the primary list near the cursor.
   */
  clampWidth?: number;
  /** Hard cap on rendered height (matches the list's maxHeight prop). */
  maxHeight: number;
  /** Gap between the anchor line and the popup. */
  anchorGap: number;
  /** Minimum distance to keep from the viewport edges. */
  viewportPadding: number;
  /**
   * Direction hint from the cursor-cell based calculation. Only used to break
   * ties when neither side can fully fit the desired height.
   */
  expandUpwardHint: boolean;
}

export interface PopupPlacement {
  /** Whether the popup renders above the anchor line (flipped up). */
  renderUpward: boolean;
  /** Final top edge, in viewport coordinates (already clamped). */
  top: number;
  /** Final left edge, in viewport coordinates (already clamped). */
  left: number;
  /** Height budget for the rendered content (drives scrolling). */
  maxHeight: number;
}

export interface PopupGeometryClampInput {
  left: number;
  top: number;
  width: number;
  height: number;
  clampViewport: PopupClampViewport;
  viewportPadding: number;
}

export interface PopupGeometry {
  top: number;
  left: number;
}

function clampCoordinate(value: number, min: number, max: number): number {
  if (max <= min) return min;
  return Math.max(min, Math.min(value, max));
}

/**
 * Final guardrail using the rendered popup's actual DOM size. The placement
 * pass uses estimated list/detail/panel sizes so it can decide before render;
 * this pass prevents any estimate mismatch or delayed xterm cursor refresh
 * from letting the fixed-position portal escape the terminal/app bounds.
 */
export function clampAutocompletePopupGeometry(
  input: PopupGeometryClampInput,
): PopupGeometry {
  const { left, top, width, height, clampViewport, viewportPadding } = input;
  const safeWidth = Number.isFinite(width) ? Math.max(0, width) : 0;
  const safeHeight = Number.isFinite(height) ? Math.max(0, height) : 0;
  const minLeft = clampViewport.left + viewportPadding;
  const minTop = clampViewport.top + viewportPadding;
  const maxLeft = clampViewport.left + clampViewport.width - viewportPadding - safeWidth;
  const maxTop = clampViewport.top + clampViewport.height - viewportPadding - safeHeight;

  return {
    left: clampCoordinate(left, minLeft, Math.max(minLeft, maxLeft)),
    top: clampCoordinate(top, minTop, Math.max(minTop, maxTop)),
  };
}

/**
 * Decide where to place the autocomplete popup so it never spills past the
 * viewport edges. Pure and deterministic so the boundary math is unit-tested
 * independently of React/DOM.
 *
 * Vertical: prefer downward, but flip upward when the space below the input
 * line can't fit the desired height and the space above is a better fit. The
 * height is then clamped to whatever the chosen side actually offers so the
 * list scrolls instead of overflowing.
 *
 * Horizontal: clamp the left edge using the popup's *total* width (main list +
 * cascading sub-dir panels + detail tooltip), not just the main list, so wide
 * assemblies near the right edge slide left instead of overflowing. When the
 * assembly is wider than the viewport it pins to the left padding so the
 * primary list stays visible.
 */
export function computeAutocompletePopupPlacement(
  input: PopupPlacementInput,
): PopupPlacement {
  const {
    anchorTop,
    anchorBottom,
    anchorLeft,
    viewportWidth,
    viewportHeight,
    desiredHeight,
    totalWidth,
    maxHeight,
    anchorGap,
    viewportPadding,
    expandUpwardHint,
    clampViewport,
    clampWidth,
  } = input;

  const bounds: PopupClampViewport = clampViewport ?? {
    left: 0,
    top: 0,
    width: viewportWidth,
    height: viewportHeight,
  };
  const boundsRight = bounds.left + bounds.width;
  const boundsBottom = bounds.top + bounds.height;
  const horizontalClampWidth = clampWidth ?? totalWidth;

  const cappedDesiredHeight = Math.min(maxHeight, Math.max(0, desiredHeight));
  const spaceAbove = Math.max(0, anchorTop - bounds.top - viewportPadding - anchorGap);
  const spaceBelow = Math.max(0, boundsBottom - anchorBottom - viewportPadding - anchorGap);
  const canFullyRenderAbove = spaceAbove >= cappedDesiredHeight;
  const canFullyRenderBelow = spaceBelow >= cappedDesiredHeight;
  const renderUpward = canFullyRenderBelow
    ? false
    : canFullyRenderAbove
      ? true
      : expandUpwardHint
        ? spaceAbove >= Math.min(spaceBelow, 80)
        : spaceAbove > spaceBelow;

  const availableVerticalSpace = renderUpward ? spaceAbove : spaceBelow;
  const availableViewportHeight = Math.max(0, bounds.height - viewportPadding * 2);
  const effectiveMaxHeight = Math.max(
    0,
    Math.min(maxHeight, availableVerticalSpace, availableViewportHeight),
  );
  const contentHeightForPlacement = Math.min(effectiveMaxHeight, cappedDesiredHeight);
  const unclampedTop = renderUpward
    ? Math.max(bounds.top + viewportPadding, anchorTop - anchorGap - contentHeightForPlacement)
    : Math.min(
        anchorBottom + anchorGap,
        boundsBottom - viewportPadding - contentHeightForPlacement,
      );
  const minTop = bounds.top + viewportPadding;
  const maxTop = Math.max(minTop, boundsBottom - viewportPadding - contentHeightForPlacement);
  const top = Math.max(minTop, Math.min(unclampedTop, maxTop));

  // Right edge that keeps the clamped assembly inside the bounds. When the
  // assembly is wider than the available room this goes below the left padding,
  // so the final clamp pins the popup to the left padding (primary list wins).
  const maxLeft = boundsRight - viewportPadding - Math.max(0, horizontalClampWidth);
  const left = Math.max(bounds.left + viewportPadding, Math.min(anchorLeft, maxLeft));

  return { renderUpward, top, left, maxHeight: effectiveMaxHeight };
}

export interface AutocompleteViewportAnchor {
  anchorLeft: number;
  anchorTop: number;
  anchorBottom: number;
  expandUpward: boolean;
}

const ESTIMATED_ROW_HEIGHT_PX = 28;
const POPUP_CHROME_PADDING_PX = 8;

function estimatePopupHeight(itemCount: number): number {
  return itemCount * ESTIMATED_ROW_HEIGHT_PX + POPUP_CHROME_PADDING_PX;
}

function shouldExpandAutocompleteUpward(
  cursorY: number,
  spaceBelowPx: number,
  spaceAbovePx: number,
  estimatedPopupHeight: number,
): boolean {
  if (spaceBelowPx >= estimatedPopupHeight) return false;
  if (spaceAbovePx >= estimatedPopupHeight) return true;
  return cursorY > 2 && spaceAbovePx >= spaceBelowPx;
}

/** Predicted cursor cell for popup anchoring (column within the row + row). */
export type AutocompleteCursorCell = {
  column: number;
  row: number;
};

/**
 * Best-effort cursor cell for popup anchoring. xterm's helper textarea and
 * buffer.cursorX can lag behind the keystroke that triggered completion, so
 * derive the column from the aligned prompt and wrap onto following rows when
 * unechoed wide input crosses `term.cols`.
 *
 * When the live cursor already sits on a soft-wrapped continuation row,
 * measure from the logical line start so a still-unechoed `userInput` suffix
 * advances past the partial wrap instead of anchoring at the lagged cell.
 *
 * A wrap past the last visible row scrolls the buffer; xterm keeps the cursor
 * on `term.rows - 1`. Clamp the predicted row so a completion that resolves
 * before that scroll does not place the popup one cell below the grid.
 */
export function resolveAutocompleteCursorCell(
  term: XTerm,
  prompt: Pick<PromptDetectionResult, "promptText" | "userInput">,
): AutocompleteCursorCell {
  const buffer = term.buffer.active;
  const cols = Math.max(1, Number(term.cols) || 80);
  const termRows = Number(term.rows);
  const absY = buffer.cursorY + buffer.baseY;

  // Walk back to the first physical row of this soft-wrapped logical line.
  let startAbsY = absY;
  let startLine = buffer.getLine(startAbsY);
  while (startLine?.isWrapped && startAbsY > 0) {
    startAbsY -= 1;
    startLine = buffer.getLine(startAbsY);
  }
  const startRowY = startAbsY - buffer.baseY;

  let fromLine = (buffer.cursorY - startRowY) * cols + buffer.cursorX;
  const cursorLine = buffer.getLine(absY);
  if (cursorLine) {
    const lineText = cursorLine.translateToString(false);
    const tail = lineText.substring(buffer.cursorX).trimEnd();
    if (tail.length === 0) {
      const endCol = Math.max(buffer.cursorX, lineText.trimEnd().length);
      fromLine = (buffer.cursorY - startRowY) * cols + endCol;
    }
  }

  // Use xterm's active Unicode width so CJK / emoji / fullwidth glyphs in
  // the synthetic pre-echo userInput advance the popup with the same cell
  // count as the real cursor (#2813).
  const fromPrompt =
    stringCellWidth(prompt.promptText, term) + stringCellWidth(prompt.userInput, term);
  const rawColumn = Math.max(fromLine, fromPrompt);
  const predictedRow = Math.max(0, startRowY + Math.floor(rawColumn / cols));
  // Only clamp when the terminal reports a real viewport height; missing
  // `rows` (tests/mocks) must not collapse every wrap onto row 0.
  const row = Number.isFinite(termRows) && termRows > 0
    ? Math.min(predictedRow, termRows - 1)
    : predictedRow;
  return {
    column: rawColumn % cols,
    row,
  };
}

/** Column-only helper for callers that do not need the predicted wrap row. */
export function resolveAutocompleteCursorColumn(
  term: XTerm,
  prompt: Pick<PromptDetectionResult, "promptText" | "userInput">,
): number {
  return resolveAutocompleteCursorCell(term, prompt).column;
}

/** Clamp autocomplete popups to the active terminal screen in split workspaces.
 *
 * Uses the visible `.xterm-screen` rect as the clamp boundary so the popup
 * never overflows the *actual* rendered terminal grid. The `.xterm-container`
 * can be a few pixels taller than the screen (rounding/padding), so falling
 * back to its rect produced a false positive `spaceBelow` at the bottom row
 * and caused short suggestion lists to flip downward below the visible area
 * (see issue #1710).
 */
export function resolveAutocompleteClampViewport(container: HTMLElement | null): PopupClampViewport {
  const pane = container?.closest<HTMLElement>('[data-section="terminal-split-pane"]');
  const screen = container?.querySelector<HTMLElement>(".xterm-screen")
    ?? null;
  // Clamp to the rendered screen so the popup cannot spill past the visible
  // terminal rows. If the screen is not mounted yet, fall back to the split
  // pane/container rect or the full viewport.
  const rect = screen?.getBoundingClientRect()
    ?? pane?.getBoundingClientRect()
    ?? container?.getBoundingClientRect();
  if (rect && rect.width > 0 && rect.height > 0) {
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
  }

  return {
    left: 0,
    top: 0,
    width: typeof window !== "undefined" ? window.innerWidth : 1200,
    height: typeof window !== "undefined" ? window.innerHeight : 800,
  };
}

/**
 * Resolve the autocomplete anchor in viewport coordinates so split panes and
 * padded xterm screens stay aligned with the real cursor.
 */
export function resolveAutocompleteAnchorInViewport(
  term: XTerm,
  container: HTMLElement | null,
  itemCount: number,
  cursorColumn = term.buffer.active.cursorX,
  cursorRow = term.buffer.active.cursorY,
): AutocompleteViewportAnchor {
  const empty: AutocompleteViewportAnchor = {
    anchorLeft: 0,
    anchorTop: 0,
    anchorBottom: 0,
    expandUpward: false,
  };
  if (!container || !term.element) return empty;

  const rows = Math.max(1, term.rows);
  const estimatedPopupHeight = estimatePopupHeight(itemCount);
  const dims = getXTermCellDimensions(term);

  const screen =
    container.querySelector<HTMLElement>(".xterm-screen")
    ?? term.element.querySelector<HTMLElement>(".xterm-screen")
    ?? container;
  const screenRect = screen.getBoundingClientRect();
  const anchorLeft = screenRect.left + cursorColumn * dims.width;
  const anchorTop = screenRect.top + cursorRow * dims.height;
  const anchorBottom = screenRect.top + (cursorRow + 1) * dims.height;
  const spaceBelow = Math.max(0, (rows - cursorRow - 1) * dims.height);
  const spaceAbove = Math.max(0, cursorRow * dims.height);

  return {
    anchorLeft,
    anchorTop,
    anchorBottom,
    expandUpward: shouldExpandAutocompleteUpward(cursorRow, spaceBelow, spaceAbove, estimatedPopupHeight),
  };
}
