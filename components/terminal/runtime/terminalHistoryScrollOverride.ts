import { joinSoftWrappedRows } from "../normalizeTerminalSelection";

type WheelLike = Pick<
  WheelEvent,
  "altKey" | "ctrlKey" | "deltaMode" | "deltaY" | "metaKey" | "shiftKey"
>;

type KeyLike = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey" | "type"
>;

type BufferLineLike = {
  isWrapped?: boolean;
  translateToString(trimRight?: boolean): string;
};

type BufferLike = {
  baseY: number;
  length: number;
  type: "normal" | "alternate";
  viewportY: number;
  getLine(y: number): BufferLineLike | undefined;
};

const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;
const DEFAULT_WHEEL_SCROLL_LINES = 3;
const PAGE_WHEEL_SCROLL_LINES = 24;

export const forcedHistoryScrollWheelListenerOptions = {
  passive: false,
  capture: true,
} as const satisfies AddEventListenerOptions;

const hasOnlyShiftModifier = (event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): boolean => event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;

export const forcedHistoryScrollLinesForWheel = (event: WheelLike): number | null => {
  if (!hasOnlyShiftModifier(event) || event.deltaY === 0) return null;

  const direction = event.deltaY < 0 ? -1 : 1;
  if (event.deltaMode === DOM_DELTA_LINE) {
    return direction * Math.max(1, Math.round(Math.abs(event.deltaY)));
  }
  if (event.deltaMode === DOM_DELTA_PAGE) {
    return direction * PAGE_WHEEL_SCROLL_LINES;
  }
  return direction * DEFAULT_WHEEL_SCROLL_LINES;
};

export const forcedHistoryScrollPagesForKey = (event: KeyLike): number | null => {
  if (event.type !== "keydown" || !hasOnlyShiftModifier(event)) return null;

  if (event.key === "PageUp") return -1;
  if (event.key === "PageDown") return 1;
  return null;
};

export const forcedHistoryScrollPageToLines = (pageCount: number, rows: number): number =>
  pageCount * Math.max(1, rows - 1);

export const clampHistoryPreviewTop = (top: number, buffer: Pick<BufferLike, "baseY">): number => {
  const maxTop = Math.max(0, buffer.baseY);
  return Math.max(0, Math.min(maxTop, top));
};

export const nextHistoryPreviewTop = ({
  buffer,
  currentTop,
  lines,
}: {
  buffer: Pick<BufferLike, "baseY" | "viewportY">;
  currentTop: number | null;
  lines: number;
}): number => clampHistoryPreviewTop(
  clampHistoryPreviewTop(currentTop ?? buffer.viewportY ?? buffer.baseY, buffer) + lines,
  buffer,
);

export type HistoryPreviewRow = {
  isWrapped: boolean;
  text: string;
};

export const getHistoryPreviewRows = ({
  buffer,
  rows,
  top,
}: {
  buffer: BufferLike;
  rows: number;
  top: number;
}): HistoryPreviewRow[] => {
  const clampedTop = clampHistoryPreviewTop(top, buffer);
  const visibleRows = Math.max(1, rows);
  const lines: HistoryPreviewRow[] = [];
  for (let row = 0; row < visibleRows; row += 1) {
    const line = buffer.getLine(clampedTop + row);
    lines.push({
      isWrapped: Boolean(line?.isWrapped),
      text: line?.translateToString(true) ?? "",
    });
  }
  return lines;
};

export const getHistoryPreviewLines = ({
  buffer,
  rows,
  top,
}: {
  buffer: BufferLike;
  rows: number;
  top: number;
}): string[] => getHistoryPreviewRows({ buffer, rows, top }).map((row) => row.text);

export const encodeHistoryPreviewWrapFlags = (rows: Array<Pick<HistoryPreviewRow, "isWrapped">>): string =>
  rows.map((row) => (row.isWrapped ? "1" : "0")).join("");

export const HISTORY_PREVIEW_OVERLAY_ATTR = "data-terminal-history-preview";
export const HISTORY_PREVIEW_WRAP_ATTR = "data-terminal-history-preview-wraps";
export const HISTORY_PREVIEW_CLICK_SLOP_PX = 4;

const MODIFIER_ONLY_KEYS = new Set(["Shift", "Control", "Meta", "Alt"]);

export type HistoryPreviewSelectionLike = {
  rangeCount: number;
  isCollapsed?: boolean;
  anchorNode: { nodeType?: number } | null;
  focusNode: { nodeType?: number } | null;
  anchorOffset?: number;
  focusOffset?: number;
  toString(): string;
};

export type HistoryPreviewNodeLike = {
  contains(node: { nodeType?: number } | null): boolean;
  firstChild?: { nodeType?: number } | null;
  getAttribute?(name: string): string | null;
  textContent?: string | null;
};

export const isHistoryPreviewPointerTarget = (
  target: EventTarget | null | undefined,
  overlay: EventTarget | null | undefined,
): boolean => {
  if (!target || !overlay) return false;
  if (target === overlay) return true;
  if (typeof (overlay as HistoryPreviewNodeLike).contains === "function") {
    return (overlay as HistoryPreviewNodeLike).contains(target as HistoryPreviewNodeLike);
  }
  return false;
};

export const shouldHideHistoryPreviewOnMouseDown = (
  target: EventTarget | null | undefined,
  overlay: EventTarget | null | undefined,
): boolean => Boolean(overlay) && !isHistoryPreviewPointerTarget(target, overlay);

export const isHistoryPreviewContextMenuTarget = (
  target: EventTarget | null | undefined,
): boolean => {
  if (!target || typeof target !== "object") return false;
  const element = target as { closest?: (selector: string) => Element | null };
  return Boolean(element.closest?.(`[${HISTORY_PREVIEW_OVERLAY_ATTR}]`));
};

export const shouldKeepHistoryPreviewOnKey = (
  event: KeyLike,
  options: {
    action?: string | null;
    hasPreviewSelection?: boolean;
    overlayVisible?: boolean;
  } = {},
): boolean => {
  if (forcedHistoryScrollPagesForKey(event) !== null) return true;
  if (MODIFIER_ONLY_KEYS.has(event.key)) return true;
  if (options.action === "selectAll" && options.overlayVisible) return true;
  if (options.action === "copy" && options.hasPreviewSelection) return true;
  return Boolean(
    options.hasPreviewSelection
    && options.action == null
    && (event.metaKey || event.ctrlKey)
    && !event.altKey
    && event.key.toLowerCase() === "c",
  );
};

export const isHistoryPreviewDismissClick = (
  down: Pick<MouseEvent, "clientX" | "clientY">,
  up: Pick<MouseEvent, "button" | "clientX" | "clientY">,
  slop = HISTORY_PREVIEW_CLICK_SLOP_PX,
): boolean => {
  if (up.button !== 0) return false;
  return Math.hypot(up.clientX - down.clientX, up.clientY - down.clientY) <= slop;
};

const lineOffsetsForPreviewText = (text: string): number[] => {
  const offsets = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) offsets.push(index + 1);
  }
  return offsets;
};

export const joinHistoryPreviewSelectionText = ({
  text,
  startOffset,
  endOffset,
  wrapFlags,
}: {
  text: string;
  startOffset: number;
  endOffset: number;
  wrapFlags: boolean[];
}): string => {
  const start = Math.max(0, Math.min(startOffset, endOffset));
  const end = Math.max(0, Math.max(startOffset, endOffset));
  if (end <= start) return "";

  const lineStarts = lineOffsetsForPreviewText(text);
  const lineIndexAt = (offset: number): number => {
    let index = 0;
    while (index + 1 < lineStarts.length && lineStarts[index + 1]! <= offset) {
      index += 1;
    }
    return index;
  };
  const startLine = lineIndexAt(start);
  const endLine = lineIndexAt(Math.max(start, end - 1));
  const boundaryLine = lineStarts.indexOf(end);
  const includesTrailingHardBreak = boundaryLine > 0 && !wrapFlags[boundaryLine];
  const sliceLine = (line: number, from: number, to: number): string => {
    const lineStart = lineStarts[line] ?? 0;
    const lineEnd = line + 1 < lineStarts.length ? lineStarts[line + 1]! - 1 : text.length;
    return text.slice(Math.max(lineStart, from), Math.min(lineEnd, to));
  };

  let current = sliceLine(startLine, start, startLine === endLine ? end : Number.POSITIVE_INFINITY);
  const logical: string[] = [];
  for (let line = startLine + 1; line <= endLine; line += 1) {
    const row = sliceLine(line, 0, line === endLine ? end : Number.POSITIVE_INFINITY);
    if (wrapFlags[line]) {
      current = joinSoftWrappedRows(current, row);
      continue;
    }
    logical.push(current);
    current = row;
  }
  logical.push(current);
  const joined = logical.join("\n");
  return includesTrailingHardBreak ? `${joined}\n` : joined;
};

const resolveOverlayTextOffset = (
  overlay: HistoryPreviewNodeLike,
  textNode: { nodeType?: number },
  node: { nodeType?: number } | null,
  offset: number,
): number | null => {
  if (node === textNode) return offset;
  if (node === overlay) return offset <= 0 ? 0 : overlay.textContent?.length ?? 0;
  return null;
};

const selectionOffsetsInOverlay = (
  overlay: HistoryPreviewNodeLike,
  selection: HistoryPreviewSelectionLike,
): { start: number; end: number } | null => {
  const textNode = overlay.firstChild;
  if (!textNode) return null;
  const { anchorNode, focusNode, anchorOffset, focusOffset } = selection;
  if (anchorOffset == null || focusOffset == null) return null;
  const start = resolveOverlayTextOffset(overlay, textNode, anchorNode, anchorOffset);
  const end = resolveOverlayTextOffset(overlay, textNode, focusNode, focusOffset);
  if (start == null || end == null) return null;
  return {
    start: Math.min(start, end),
    end: Math.max(start, end),
  };
};

export const getHistoryPreviewSelectionText = (
  overlay: HistoryPreviewNodeLike | null | undefined,
  selection: HistoryPreviewSelectionLike | null | undefined,
): string => {
  if (!overlay || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return "";
  }
  const { anchorNode, focusNode } = selection;
  if (!anchorNode || !focusNode) return "";
  if (!overlay.contains(anchorNode) || !overlay.contains(focusNode)) return "";
  const raw = selection.toString();
  const wrapAttr = overlay.getAttribute?.(HISTORY_PREVIEW_WRAP_ATTR);
  const offsets = selectionOffsetsInOverlay(overlay, selection);
  if (!wrapAttr || !offsets) return raw;
  return joinHistoryPreviewSelectionText({
    text: overlay.textContent ?? "",
    startOffset: offsets.start,
    endOffset: offsets.end,
    wrapFlags: [...wrapAttr].map((flag) => flag === "1"),
  }) || raw;
};

export const findHistoryPreviewOverlay = (
  root: ParentNode | Element | null | undefined,
): HTMLElement | null => {
  if (!root || !("querySelector" in root)) return null;
  return root.querySelector<HTMLElement>(`[${HISTORY_PREVIEW_OVERLAY_ATTR}]`);
};

export const getHistoryPreviewSelectionFromRoot = (
  root: ParentNode | Element | null | undefined,
  selection?: HistoryPreviewSelectionLike | null,
): string => {
  const overlay = findHistoryPreviewOverlay(root);
  const activeSelection = selection ?? overlay?.ownerDocument.getSelection() ?? null;
  return getHistoryPreviewSelectionText(overlay, activeSelection);
};

export const HISTORY_PREVIEW_HIDE_EVENT = "netcatty-history-preview-hide";

export const requestHistoryPreviewHide = (
  root: ParentNode | Element | null | undefined,
): boolean => {
  const overlay = findHistoryPreviewOverlay(root);
  if (!overlay) return false;
  overlay.dispatchEvent(new Event(HISTORY_PREVIEW_HIDE_EVENT, { bubbles: true }));
  return true;
};

export const selectHistoryPreviewAll = (overlay: HTMLElement | null | undefined): boolean => {
  if (!overlay) return false;
  const selection = overlay.ownerDocument.getSelection();
  if (!selection) return false;
  const range = overlay.ownerDocument.createRange();
  const textNode = overlay.firstChild;
  if (textNode) range.selectNodeContents(textNode);
  else range.selectNodeContents(overlay);
  selection.removeAllRanges();
  selection.addRange(range);
  return !selection.isCollapsed;
};
