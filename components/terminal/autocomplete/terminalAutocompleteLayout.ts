import type { Terminal as XTerm } from "@xterm/xterm";
import type { CompletionSuggestion } from "./completionEngine";
import type { PromptDetectionResult } from "./promptDetector";
import type { SubDirPanel } from "./useTerminalAutocomplete";
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
  const effectiveMaxHeight = Math.max(0, Math.min(maxHeight, availableVerticalSpace));
  const contentHeightForPlacement = Math.min(effectiveMaxHeight, cappedDesiredHeight);
  const top = renderUpward
    ? Math.max(bounds.top + viewportPadding, anchorTop - anchorGap - contentHeightForPlacement)
    : Math.min(
        anchorBottom + anchorGap,
        boundsBottom - viewportPadding - contentHeightForPlacement,
      );

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

/**
 * Best-effort cursor column for popup anchoring. xterm's helper textarea and
 * buffer.cursorX can lag behind the keystroke that triggered completion, so
 * derive the column from the aligned prompt when the command still fits on one
 * row.
 */
export function resolveAutocompleteCursorColumn(
  term: XTerm,
  prompt: Pick<PromptDetectionResult, "promptText" | "userInput">,
): number {
  const buffer = term.buffer.active;
  const absY = buffer.cursorY + buffer.baseY;
  const line = buffer.getLine(absY);
  if (line?.isWrapped) {
    return buffer.cursorX;
  }

  let fromLine = buffer.cursorX;
  if (line) {
    const lineText = line.translateToString(false);
    const tail = lineText.substring(buffer.cursorX).trimEnd();
    if (tail.length === 0) {
      fromLine = Math.max(buffer.cursorX, lineText.trimEnd().length);
    }
  }

  const fromPrompt = prompt.promptText.length + prompt.userInput.length;
  return Math.max(fromLine, fromPrompt);
}

/** Clamp autocomplete popups to the active terminal pane in split workspaces. */
export function resolveAutocompleteClampViewport(container: HTMLElement | null): PopupClampViewport {
  const pane = container?.closest<HTMLElement>('[data-section="terminal-split-pane"]');
  const rect = pane?.getBoundingClientRect() ?? container?.getBoundingClientRect();
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
): AutocompleteViewportAnchor {
  const empty: AutocompleteViewportAnchor = {
    anchorLeft: 0,
    anchorTop: 0,
    anchorBottom: 0,
    expandUpward: false,
  };
  if (!container || !term.element) return empty;

  const buffer = term.buffer.active;
  const cursorY = buffer.cursorY;
  const rows = Math.max(1, term.rows);
  const estimatedPopupHeight = estimatePopupHeight(itemCount);
  const dims = getXTermCellDimensions(term);

  const screen =
    container.querySelector<HTMLElement>(".xterm-screen")
    ?? term.element.querySelector<HTMLElement>(".xterm-screen")
    ?? container;
  const screenRect = screen.getBoundingClientRect();
  const anchorLeft = screenRect.left + cursorColumn * dims.width;
  const anchorTop = screenRect.top + cursorY * dims.height;
  const anchorBottom = screenRect.top + (cursorY + 1) * dims.height;
  const spaceBelow = Math.max(0, (rows - cursorY - 1) * dims.height);
  const spaceAbove = Math.max(0, cursorY * dims.height);

  return {
    anchorLeft,
    anchorTop,
    anchorBottom,
    expandUpward: shouldExpandAutocompleteUpward(cursorY, spaceBelow, spaceAbove, estimatedPopupHeight),
  };
}

/** @deprecated Use resolveAutocompleteAnchorInViewport with the xterm container. */
export function calculatePopupPosition(
  term: XTerm,
  itemCount: number,
): {
  position: { x: number; y: number };
  cursorLineTop: number;
  cursorLineBottom: number;
  expandUpward: boolean;
} {
  const termElement = term.element;
  if (!termElement) {
    return {
      position: { x: 0, y: 0 },
      cursorLineTop: 0,
      cursorLineBottom: 0,
      expandUpward: false,
    };
  }

  const dims = getXTermCellDimensions(term);
  const buffer = term.buffer.active;
  const cursorX = buffer.cursorX;
  const cursorY = buffer.cursorY;
  const cursorLineTop = cursorY * dims.height;
  const cursorLineBottom = (cursorY + 1) * dims.height;
  const estimatedPopupHeight = estimatePopupHeight(itemCount);
  const totalRows = term.rows;
  const spaceBelow = (totalRows - cursorY - 1) * dims.height;
  const spaceAbove = cursorY * dims.height;
  const expandUpward = shouldExpandAutocompleteUpward(cursorY, spaceBelow, spaceAbove, estimatedPopupHeight);

  if (expandUpward) {
    return {
      position: { x: cursorX * dims.width, y: cursorY * dims.height },
      cursorLineTop,
      cursorLineBottom,
      expandUpward: true,
    };
  }

  return {
    position: { x: cursorX * dims.width, y: (cursorY + 1) * dims.height + 4 },
    cursorLineTop,
    cursorLineBottom,
    expandUpward: false,
  };
}
