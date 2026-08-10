/**
 * Utility functions for xterm.js cell dimension access.
 * Centralizes access to xterm's internal renderer API to reduce upgrade risk.
 * Falls back to DOM measurement if the internal API is unavailable.
 */

import type { Terminal as XTerm } from "@xterm/xterm";

export interface CellDimensions {
  width: number;
  height: number;
}

// Cache to avoid repeated DOM measurements (invalidated on resize)
let cachedDims: CellDimensions | null = null;
let cachedTermId: number = 0;
let termIdCounter = 0;
const termIdMap = new WeakMap<XTerm, number>();

function getTermId(term: XTerm): number {
  let id = termIdMap.get(term);
  if (id === undefined) {
    id = ++termIdCounter;
    termIdMap.set(term, id);
  }
  return id;
}

/**
 * Get cell dimensions (width/height in CSS pixels) from an xterm instance.
 * Tries the internal renderer API first (fast path), falls back to DOM measurement.
 */
export function getXTermCellDimensions(term: XTerm): CellDimensions {
  // Try xterm core renderer API (fast path)
  const coreAccess = term as XTerm & {
    _core?: { _renderService?: { dimensions?: { css?: { cell?: CellDimensions } } } };
  };
  const coreDims = coreAccess._core?._renderService?.dimensions?.css?.cell;
  if (coreDims && coreDims.width > 0 && coreDims.height > 0) {
    // Update cache while we have a good value
    const id = getTermId(term);
    cachedDims = { width: coreDims.width, height: coreDims.height };
    cachedTermId = id;
    return cachedDims;
  }

  // Check cache (same terminal instance)
  const id = getTermId(term);
  if (cachedDims && cachedTermId === id) {
    return cachedDims;
  }

  // Fallback: measure from DOM (triggers single reflow)
  const dims = measureCellFromDOM(term);
  cachedDims = dims;
  cachedTermId = id;
  return dims;
}

/**
 * Measure cell dimensions by inserting a temporary span into the terminal element.
 * Triggers a single reflow (reading offsetWidth + offsetHeight).
 */
function measureCellFromDOM(term: XTerm): CellDimensions {
  const element = term.element;
  if (!element) return { width: 8, height: 16 };

  const span = document.createElement("span");
  span.textContent = "W";
  Object.assign(span.style, {
    position: "absolute",
    visibility: "hidden",
    fontFamily: term.options.fontFamily || "monospace",
    fontSize: `${term.options.fontSize}px`,
    lineHeight: "normal",
  });
  element.appendChild(span);
  const width = span.offsetWidth || 8;
  const height = span.offsetHeight || 16;
  span.remove();
  return { width, height };
}

/**
 * Invalidate the cached cell dimensions (call on terminal resize).
 */
export function invalidateCellDimensionCache(): void {
  cachedDims = null;
}
