const test = require("node:test");
const assert = require("node:assert/strict");

const {
  TRAY_PANEL_WIDTH,
  TRAY_PANEL_HEIGHT,
  isValidRect,
  resolveTrayAnchor,
  resolveTrayDisplayPoint,
  placeTrayPanel,
} = require("./trayPanelBounds.cjs");

const BOTTOM_WORK_AREA = { x: 0, y: 0, width: 1920, height: 1040 };
const TOP_TRAY = { x: 900, y: 0, width: 24, height: 24 };
const BOTTOM_TRAY = { x: 1680, y: 1044, width: 24, height: 24 };
const OTHER_MONITOR_CURSOR = { x: 2600, y: 400 };

test("isValidRect rejects zero-size Windows getBounds placeholders", () => {
  assert.equal(isValidRect({ x: 0, y: 0, width: 0, height: 0 }), false);
  assert.equal(isValidRect({ x: 10, y: 10, width: 24, height: 24 }), true);
});

test("resolveTrayAnchor keeps event bounds that match the cursor", () => {
  assert.deepEqual(
    resolveTrayAnchor({
      eventBounds: BOTTOM_TRAY,
      cursorPoint: { x: 1690, y: 1050 },
      workArea: BOTTOM_WORK_AREA,
    }),
    BOTTOM_TRAY,
  );
});

test("resolveTrayAnchor keeps event bounds when the cursor is on another monitor", () => {
  assert.deepEqual(
    resolveTrayAnchor({
      eventBounds: BOTTOM_TRAY,
      trayBounds: { x: 0, y: 0, width: 0, height: 0 },
      cursorPoint: OTHER_MONITOR_CURSOR,
      workArea: BOTTOM_WORK_AREA,
    }),
    BOTTOM_TRAY,
  );
});

test("resolveTrayDisplayPoint uses event bounds even when the cursor is elsewhere", () => {
  assert.deepEqual(
    resolveTrayDisplayPoint({
      eventBounds: BOTTOM_TRAY,
      cursorPoint: OTHER_MONITOR_CURSOR,
    }),
    { x: BOTTOM_TRAY.x, y: BOTTOM_TRAY.y },
  );
});

test("resolveTrayAnchor ignores a top-left y=0 getBounds lie when the cursor is on a bottom taskbar", () => {
  const lied = { x: 1680, y: 0, width: 24, height: 24 };
  const cursor = { x: 1692, y: 1058 };
  assert.deepEqual(
    resolveTrayAnchor({
      trayBounds: lied,
      cursorPoint: cursor,
      workArea: BOTTOM_WORK_AREA,
    }),
    { x: 1692, y: 1058, width: 1, height: 1 },
  );
});

test("resolveTrayAnchor falls back to the cursor when tray bounds are empty", () => {
  const cursor = { x: 1700, y: 1040 };
  assert.deepEqual(
    resolveTrayAnchor({
      eventBounds: { x: 0, y: 0, width: 0, height: 0 },
      trayBounds: { x: 0, y: 0, width: 0, height: 0 },
      cursorPoint: cursor,
      workArea: BOTTOM_WORK_AREA,
    }),
    { x: 1700, y: 1040, width: 1, height: 1 },
  );
});

test("placeTrayPanel puts the designed size below a top tray (macOS)", () => {
  assert.deepEqual(
    placeTrayPanel({
      anchor: TOP_TRAY,
      workArea: BOTTOM_WORK_AREA,
    }),
    {
      x: 900 + 12 - TRAY_PANEL_WIDTH / 2,
      y: 24 + 6,
      width: TRAY_PANEL_WIDTH,
      height: TRAY_PANEL_HEIGHT,
    },
  );
});

test("placeTrayPanel puts the designed size above a bottom tray (Windows)", () => {
  assert.deepEqual(
    placeTrayPanel({
      anchor: BOTTOM_TRAY,
      workArea: BOTTOM_WORK_AREA,
    }),
    {
      x: 1680 + 12 - TRAY_PANEL_WIDTH / 2,
      y: 1044 - TRAY_PANEL_HEIGHT - 6,
      width: TRAY_PANEL_WIDTH,
      height: TRAY_PANEL_HEIGHT,
    },
  );
});

test("placeTrayPanel never adopts a blown-up getBounds size", () => {
  const placed = placeTrayPanel({
    anchor: BOTTOM_TRAY,
    workArea: BOTTOM_WORK_AREA,
    width: TRAY_PANEL_WIDTH,
    height: TRAY_PANEL_HEIGHT,
  });
  assert.equal(placed.width, 360);
  assert.equal(placed.height, 520);
});

test("placeTrayPanel clamps to the work area on the trailing edge", () => {
  const placed = placeTrayPanel({
    anchor: { x: 1900, y: 1044, width: 24, height: 24 },
    workArea: BOTTOM_WORK_AREA,
  });
  assert.equal(placed.x, 1920 - TRAY_PANEL_WIDTH);
  assert.equal(placed.y, 1044 - TRAY_PANEL_HEIGHT - 6);
});

test("Windows y=0 lie plus cursor still docks above the taskbar at designed size", () => {
  const cursor = { x: 1700, y: 1040 };
  const anchor = resolveTrayAnchor({
    eventBounds: { x: 0, y: 0, width: 0, height: 0 },
    trayBounds: { x: 0, y: 0, width: 0, height: 0 },
    cursorPoint: cursor,
    workArea: BOTTOM_WORK_AREA,
  });
  const placed = placeTrayPanel({ anchor, workArea: BOTTOM_WORK_AREA });
  assert.deepEqual(
    placed,
    placeTrayPanel({
      anchor: { x: cursor.x, y: cursor.y, width: 1, height: 1 },
      workArea: BOTTOM_WORK_AREA,
    }),
  );
  assert.equal(placed.width, TRAY_PANEL_WIDTH);
  assert.equal(placed.height, TRAY_PANEL_HEIGHT);
  assert.ok(placed.y > 400, "panel should sit in the lower half, not at the top of the desktop");
  assert.ok(placed.y < 600, "panel should stay near the taskbar instead of the top of the screen");
});
