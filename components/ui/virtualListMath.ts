/**
 * Pure math for virtual lists and keyboard cursors.
 * Kept free of React so tests drive the same functions the pickers use.
 */

export function clampScrollTop(
  scrollTop: number,
  totalHeight: number,
  viewportHeight: number,
): number {
  const maxScroll = Math.max(0, totalHeight - Math.max(viewportHeight, 0));
  return Math.min(Math.max(0, scrollTop), maxScroll);
}

export function getFixedSizeVirtualWindow({
  itemCount,
  itemHeight,
  scrollTop,
  viewportHeight,
  overscan,
}: {
  itemCount: number;
  itemHeight: number;
  scrollTop: number;
  viewportHeight: number;
  overscan: number;
}): { startIndex: number; endIndex: number; effectiveScrollTop: number; totalHeight: number } {
  const totalHeight = Math.max(0, itemCount * itemHeight);
  const effectiveScrollTop = clampScrollTop(scrollTop, totalHeight, viewportHeight);
  if (itemCount <= 0 || itemHeight <= 0) {
    return { startIndex: 0, endIndex: 0, effectiveScrollTop, totalHeight };
  }
  const startIndex = Math.max(0, Math.floor(effectiveScrollTop / itemHeight) - overscan);
  const visibleCount = Math.ceil(Math.max(viewportHeight, 1) / itemHeight) + overscan * 2;
  const endIndex = Math.min(itemCount, startIndex + visibleCount);
  return { startIndex, endIndex, effectiveScrollTop, totalHeight };
}

/** Clamp a keyboard cursor into [0, length-1], or 0 when the list is empty. */
export function clampListIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.max(0, Math.min(Math.trunc(index), length - 1));
}

/** Move a keyboard cursor by delta without ever landing on -1. */
export function stepListIndex(index: number, length: number, delta: number): number {
  if (length <= 0) return 0;
  return clampListIndex(index + delta, length);
}

/**
 * Map selectable item indices to visual row indices for lists that interleave
 * non-selectable chrome (headers, hints, empty rows).
 */
export function buildItemIndexToVisualIndexMap(
  visualRows: ReadonlyArray<{ kind: string }>,
  itemKind = 'item',
): Map<number, number> {
  const map = new Map<number, number>();
  let itemIndex = 0;
  visualRows.forEach((row, visualIndex) => {
    if (row.kind !== itemKind) return;
    map.set(itemIndex, visualIndex);
    itemIndex += 1;
  });
  return map;
}
