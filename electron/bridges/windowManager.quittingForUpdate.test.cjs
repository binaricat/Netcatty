const test = require("node:test");
const assert = require("node:assert/strict");

const WINDOW_MANAGER_PATH = require.resolve("./windowManager.cjs");

function loadFreshWindowManager() {
  // windowManager keeps the quitting flags in module-level closures, so reload
  // a fresh copy per test to avoid cross-test state leakage.
  delete require.cache[WINDOW_MANAGER_PATH];
  return require("./windowManager.cjs");
}

test("isQuittingForUpdate defaults to false", () => {
  const wm = loadFreshWindowManager();
  assert.equal(wm.isQuittingForUpdate(), false);
});

test("setQuittingForUpdate(true) flips the update-install flag and commits isQuitting", () => {
  const wm = loadFreshWindowManager();
  assert.equal(wm.getIsQuitting(), false);
  wm.setQuittingForUpdate(true);
  assert.equal(wm.isQuittingForUpdate(), true);
  // Must also set the generic isQuitting flag so the main-window close handler
  // bypasses close-to-tray during the update quit (#1215).
  assert.equal(wm.getIsQuitting(), true);
});

test("setQuittingForUpdate(false) clears BOTH the update flag and isQuitting", () => {
  const wm = loadFreshWindowManager();
  wm.setQuittingForUpdate(true);
  assert.equal(wm.isQuittingForUpdate(), true);
  assert.equal(wm.getIsQuitting(), true);
  // Rollback (failed install) must restore normal close behavior — resetting
  // isQuitting too, otherwise close-to-tray / settings hiding stay disabled for
  // the rest of the session (#1215 review).
  wm.setQuittingForUpdate(false);
  assert.equal(wm.isQuittingForUpdate(), false);
  assert.equal(wm.getIsQuitting(), false);
});

test("setQuittingForUpdate coerces truthy/falsy values to booleans", () => {
  const wm = loadFreshWindowManager();
  wm.setQuittingForUpdate(1);
  assert.equal(wm.isQuittingForUpdate(), true);
  wm.setQuittingForUpdate(0);
  assert.equal(wm.isQuittingForUpdate(), false);
  wm.setQuittingForUpdate(undefined);
  assert.equal(wm.isQuittingForUpdate(), false);
});
