type WheelLike = Pick<
  WheelEvent,
  "altKey" | "ctrlKey" | "deltaMode" | "deltaY" | "metaKey" | "shiftKey"
>;

type KeyLike = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey" | "type"
>;

type BufferLineLike = {
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

export const getHistoryPreviewLines = ({
  buffer,
  rows,
  top,
}: {
  buffer: BufferLike;
  rows: number;
  top: number;
}): string[] => {
  const clampedTop = clampHistoryPreviewTop(top, buffer);
  const visibleRows = Math.max(1, rows);
  const lines: string[] = [];
  for (let row = 0; row < visibleRows; row += 1) {
    lines.push(buffer.getLine(clampedTop + row)?.translateToString(true) ?? "");
  }
  return lines;
};
