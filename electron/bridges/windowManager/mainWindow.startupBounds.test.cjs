const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveStartupBounds } = require("./mainWindow.cjs");

// 1470×956 logical screen with the menu bar excluded from the work area.
const MAC_BOOK = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1470, height: 956 },
  workArea: { x: 0, y: 33, width: 1470, height: 848 },
};

function screenWith(...displays) {
  return {
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => displays[0],
    getDisplayMatching: () => displays[0],
  };
}

const defaults = { width: 1400, height: 900 };

test("pulls a partially off-screen saved window back inside the work area", () => {
  // The saved window's right/bottom edges hang past the screen edge.
  const { bounds, minimum } = resolveStartupBounds(
    screenWith(MAC_BOOK),
    { x: 499, y: 253, width: 1100, height: 838 },
    defaults,
    1100,
    640,
  );

  assert.deepEqual(minimum, { width: 719, height: 408 });
  assert.deepEqual(bounds, { x: 370, y: 43, width: 1100, height: 838 });
});

test("caps a saved window larger than the display to the work area", () => {
  const { bounds } = resolveStartupBounds(
    screenWith(MAC_BOOK),
    { x: -200, y: 100, width: 2000, height: 1200 },
    defaults,
    1100,
    640,
  );

  assert.deepEqual(bounds, { x: 0, y: 33, width: 1470, height: 848 });
});

test("keeps a window that intentionally spans adjacent displays", () => {
  const left = { workArea: { x: 0, y: 33, width: 1470, height: 848 } };
  const right = { workArea: { x: 1470, y: 33, width: 1470, height: 848 } };
  const { bounds } = resolveStartupBounds(
    screenWith(left, right),
    { x: 1200, y: 100, width: 1000, height: 700 },
    defaults,
    1100,
    640,
  );

  assert.deepEqual(bounds, { x: 1200, y: 100, width: 1000, height: 700 });
});

test("clamps a window that hangs into the gap between offset displays", () => {
  const top = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
  const lowerRight = { workArea: { x: 1920, y: 500, width: 1920, height: 1080 } };
  const { bounds, minimum } = resolveStartupBounds(
    screenWith(top, lowerRight),
    { x: 1800, y: 100, width: 800, height: 600 },
    defaults,
    1100,
    640,
  );

  assert.deepEqual(minimum, { width: 944, height: 524 });
  assert.deepEqual(bounds, { x: 1920, y: 500, width: 944, height: 600 });
});

test("centers a default window without starting larger than the work area", () => {
  const { bounds } = resolveStartupBounds(screenWith(MAC_BOOK), null, defaults, 1100, 640);

  assert.deepEqual(bounds, { width: 1400, height: 848 });
  assert.equal("x" in bounds, false);
  assert.equal("y" in bounds, false);
});

test("grows a saved window to the tiling minimum and keeps it on screen", () => {
  const { bounds } = resolveStartupBounds(
    screenWith(MAC_BOOK),
    { x: 100, y: 100, width: 500, height: 300 },
    defaults,
    1100,
    640,
  );

  assert.deepEqual(bounds, { x: 100, y: 100, width: 719, height: 408 });
});

test("falls back to the saved size when no display is available", () => {
  const { bounds, minimum } = resolveStartupBounds(
    { getAllDisplays: () => [], getPrimaryDisplay: () => null },
    { x: 10, y: 10, width: 500, height: 300 },
    defaults,
    1100,
    640,
  );

  assert.deepEqual(bounds, { x: 10, y: 10, width: 1100, height: 640 });
  assert.deepEqual(minimum, { width: 1100, height: 640 });
});
