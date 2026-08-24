/**
 * Tray panel size and placement.
 *
 * The panel is a fixed 360x520 overlay. Electron click / right-click events
 * already carry live tray bounds; those are trusted even when the cursor is
 * on another monitor (keyboard / accessibility activation).
 *
 * `tray.getBounds()` on Windows is a weaker fallback: it often reports a
 * zero-size rect or y=0 while the icon sits on a bottom taskbar. Only that
 * fallback is checked against the cursor.
 */

const TRAY_PANEL_WIDTH = 360;
const TRAY_PANEL_HEIGHT = 520;
const TRAY_PANEL_GAP = 6;
const ANCHOR_CURSOR_SLOP_PX = 96;

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidRect(rect) {
  return Boolean(
    rect
    && isFiniteNumber(rect.x)
    && isFiniteNumber(rect.y)
    && isFiniteNumber(rect.width)
    && isFiniteNumber(rect.height)
    && rect.width > 0
    && rect.height > 0,
  );
}

function isValidPoint(point) {
  return Boolean(point && isFiniteNumber(point.x) && isFiniteNumber(point.y));
}

function copyRect(rect) {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  };
}

function rectNearPoint(rect, point, slop = ANCHOR_CURSOR_SLOP_PX) {
  if (!isValidRect(rect) || !isValidPoint(point)) return false;
  return point.x >= rect.x - slop
    && point.x <= rect.x + rect.width + slop
    && point.y >= rect.y - slop
    && point.y <= rect.y + rect.height + slop;
}

/**
 * Pick an anchor rectangle for the tray icon.
 *
 * Event bounds win unconditionally when they are a usable rect. Cursor
 * proximity is only used to reject a stale `tray.getBounds()` fallback.
 */
function resolveTrayAnchor({
  eventBounds,
  trayBounds,
  cursorPoint,
  workArea,
} = {}) {
  if (isValidRect(eventBounds)) {
    return copyRect(eventBounds);
  }

  if (isValidRect(trayBounds) && (!isValidPoint(cursorPoint) || rectNearPoint(trayBounds, cursorPoint))) {
    return copyRect(trayBounds);
  }

  if (isValidPoint(cursorPoint)) {
    return { x: cursorPoint.x, y: cursorPoint.y, width: 1, height: 1 };
  }

  const area = isValidRect(workArea) ? workArea : { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: area.x + Math.max(area.width, 0),
    y: area.y + Math.max(area.height, 0),
    width: 1,
    height: 1,
  };
}

/**
 * Display lookup point. Event bounds choose the monitor; otherwise the
 * cursor (so a y=0 getBounds lie cannot pick the wrong screen).
 */
function resolveTrayDisplayPoint({ eventBounds, trayBounds, cursorPoint } = {}) {
  if (isValidRect(eventBounds)) {
    return { x: eventBounds.x, y: eventBounds.y };
  }
  if (isValidPoint(cursorPoint)) {
    return { x: cursorPoint.x, y: cursorPoint.y };
  }
  if (isValidRect(trayBounds)) {
    return { x: trayBounds.x, y: trayBounds.y };
  }
  return { x: 0, y: 0 };
}

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Place the designed panel next to the tray: below when there is room
 * (macOS menu bar), otherwise above (Windows / Linux bottom taskbar).
 */
function placeTrayPanel({
  anchor,
  workArea,
  width = TRAY_PANEL_WIDTH,
  height = TRAY_PANEL_HEIGHT,
  gap = TRAY_PANEL_GAP,
} = {}) {
  const area = isValidRect(workArea)
    ? workArea
    : { x: 0, y: 0, width: Math.max(width, 1), height: Math.max(height, 1) };
  const panelWidth = Math.min(Math.max(1, width), area.width || width);
  const panelHeight = Math.min(Math.max(1, height), area.height || height);
  const resolvedAnchor = isValidRect(anchor)
    ? anchor
    : { x: area.x, y: area.y, width: 1, height: 1 };

  const minX = area.x;
  const maxX = area.x + area.width - panelWidth;
  const x = Math.round(clamp(
    resolvedAnchor.x + resolvedAnchor.width / 2 - panelWidth / 2,
    minX,
    maxX,
  ));

  const minY = area.y;
  const maxY = area.y + area.height - panelHeight;
  const below = resolvedAnchor.y + resolvedAnchor.height + gap;
  const above = resolvedAnchor.y - panelHeight - gap;

  let y;
  if (below + panelHeight <= area.y + area.height) {
    y = below;
  } else if (above >= area.y) {
    y = above;
  } else {
    y = clamp(below, minY, maxY);
  }

  return {
    x,
    y: Math.round(clamp(y, minY, maxY)),
    width: panelWidth,
    height: panelHeight,
  };
}

module.exports = {
  TRAY_PANEL_WIDTH,
  TRAY_PANEL_HEIGHT,
  TRAY_PANEL_GAP,
  isValidRect,
  resolveTrayAnchor,
  resolveTrayDisplayPoint,
  placeTrayPanel,
};
