"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  attachDisplayRecovery: attachDisplayRecoveryForPlatform,
  boundsIntersectDisplay,
  clampBoundsToDisplay,
  pickDisplayRecoveryBounds,
} = require("./displayRecovery.cjs");

function attachDisplayRecovery(options) {
  return attachDisplayRecoveryForPlatform({ ...options, platform: "win32" });
}

const PRIMARY = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
const SECONDARY = { id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 } };

function createMockWindow(initialBounds) {
  const listeners = new Map();
  const webContentsListeners = new Map();
  const win = {
    bounds: { ...initialBounds },
    destroyed: false,
    maximized: false,
    fullScreen: false,
    setBoundsCalls: [],
    webContents: {
      on(event, handler) {
        if (!webContentsListeners.has(event)) webContentsListeners.set(event, []);
        webContentsListeners.get(event).push(handler);
      },
      removeListener(event, handler) {
        const list = webContentsListeners.get(event) || [];
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      },
      emit(event, ...args) {
        for (const handler of webContentsListeners.get(event) || []) handler(...args);
      },
    },
    isDestroyed() {
      return win.destroyed;
    },
    isMaximized() {
      return win.maximized;
    },
    isFullScreen() {
      return win.fullScreen;
    },
    getBounds() {
      return { ...win.bounds };
    },
    getNormalBounds() {
      return { ...(win.normalBounds || win.bounds) };
    },
    unmaximize() {
      win.maximized = false;
      for (const handler of listeners.get("unmaximize") || []) handler();
    },
    setBounds(next) {
      win.setBoundsCalls.push({ ...next });
      win.bounds = { ...next };
      for (const handler of listeners.get("move") || []) handler();
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    removeListener(event, handler) {
      const list = listeners.get(event) || [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    __listeners: listeners,
    __webContentsListeners: webContentsListeners,
  };
  return win;
}

function createMockScreen({ primary = PRIMARY, displays = [PRIMARY, SECONDARY] } = {}) {
  const listeners = new Map();
  const connected = [...displays];
  const mock = {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    removeListener(event, handler) {
      const list = listeners.get(event) || [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    emit(event, ...args) {
      const display = args[1] || args[0];
      if (event === "display-removed" && display) {
        const displayIdIsTransient =
          typeof display.id !== "number" || !Number.isFinite(display.id) || display.id < 0;
        let index = displayIdIsTransient
          ? connected.indexOf(display)
          : connected.findIndex((candidate) => candidate.id === display.id);
        if (index < 0 && display.bounds) {
          index = connected.findIndex(
            (candidate) =>
              candidate.bounds?.x === display.bounds.x &&
              candidate.bounds?.y === display.bounds.y &&
              candidate.bounds?.width === display.bounds.width &&
              candidate.bounds?.height === display.bounds.height
          );
        }
        if (index >= 0) connected.splice(index, 1);
      }
      if (event === "display-added" && display) {
        const displayIdIsTransient =
          typeof display.id !== "number" || !Number.isFinite(display.id) || display.id < 0;
        if (
          (displayIdIsTransient && !connected.includes(display)) ||
          (!displayIdIsTransient && !connected.some((candidate) => candidate.id === display.id))
        ) {
          connected.push(display);
        }
      }
      for (const handler of listeners.get(event) || []) handler(...args);
    },
    getPrimaryDisplay() {
      return primary;
    },
    getAllDisplays() {
      return [...connected];
    },
    getDisplayMatching(bounds) {
      let best = null;
      let bestArea = 0;
      for (const display of connected) {
        const overlap = boundsIntersectDisplay(bounds, display.bounds)
          ? Math.min(bounds.x + bounds.width, display.bounds.x + display.bounds.width) -
            Math.max(bounds.x, display.bounds.x)
          : 0;
        if (overlap > bestArea) {
          bestArea = overlap;
          best = display;
        }
      }
      return best || connected[0];
    },
    __listeners: listeners,
  };
  return mock;
}

function createMockPowerMonitor() {
  const listeners = new Map();
  return {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    },
    removeListener(event, handler) {
      const list = listeners.get(event) || [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    emit(event) {
      for (const handler of listeners.get(event) || []) handler();
    },
    __listeners: listeners,
  };
}

function moveWindowManually(win, nextBounds) {
  for (const handler of win.__listeners.get("will-move") || []) {
    handler({}, { ...nextBounds });
  }
  win.bounds = { ...nextBounds };
  for (const handler of win.__listeners.get("move") || []) handler();
}

function lockSleepUnlockRestore({
  win,
  screen,
  powerMonitor,
  secondary = SECONDARY,
  afterLockBounds = { x: 100, y: 100, width: 1400, height: 900 },
} = {}) {
  powerMonitor.emit("lock-screen");
  screen.emit("display-removed", {}, secondary);
  win.bounds = { ...afterLockBounds };
  for (const handler of win.__listeners.get("move") || []) handler();
  screen.emit("display-added", {}, secondary);
  powerMonitor.emit("unlock-screen");
}

test("boundsIntersectDisplay detects overlap and rejects invalid input", () => {
  assert.equal(
    boundsIntersectDisplay({ x: 2000, y: 100, width: 800, height: 600 }, SECONDARY.bounds),
    true
  );
  assert.equal(
    boundsIntersectDisplay({ x: 0, y: 0, width: 800, height: 600 }, SECONDARY.bounds),
    false
  );
  assert.equal(boundsIntersectDisplay(null, SECONDARY.bounds), false);
});

test("pickDisplayRecoveryBounds restores a remembered placement on the re-added display", () => {
  const restored = pickDisplayRecoveryBounds({
    addedDisplay: SECONDARY,
    currentBounds: { x: 100, y: 100, width: 1200, height: 800 },
    candidates: [{ x: 2000, y: 100, width: 1200, height: 800 }],
  });
  assert.deepEqual(restored, { x: 2000, y: 100, width: 1200, height: 800 });
});

test("pickDisplayRecoveryBounds does nothing when the window is already on the display", () => {
  const restored = pickDisplayRecoveryBounds({
    addedDisplay: SECONDARY,
    currentBounds: { x: 2000, y: 100, width: 1200, height: 800 },
    candidates: [{ x: 2100, y: 100, width: 1200, height: 800 }],
  });
  assert.equal(restored, null);
});

test("pickDisplayRecoveryBounds matches a candidate by display identity when bounds changed", () => {
  const restored = pickDisplayRecoveryBounds({
    addedDisplay: { id: 2, bounds: { x: 1920, y: 0, width: 1024, height: 768 } },
    currentBounds: { x: 100, y: 100, width: 1200, height: 800 },
    candidates: [{ bounds: { x: 2000, y: 100, width: 1200, height: 800 }, displayId: 2 }],
  });
  assert.deepEqual(restored, { x: 2000, y: 100, width: 1200, height: 800 });
});

test("pickDisplayRecoveryBounds falls back to geometry while the added display id is unknown", () => {
  const rememberedBounds = { x: 2000, y: 100, width: 1400, height: 900 };
  const restored = pickDisplayRecoveryBounds({
    addedDisplay: { id: -1, bounds: SECONDARY.bounds },
    currentBounds: { x: 100, y: 100, width: 1200, height: 800 },
    candidates: [{ bounds: rememberedBounds, displayId: SECONDARY.id }],
  });
  assert.deepEqual(restored, rememberedBounds);
});

test("clampBoundsToDisplay keeps the restored window fully visible", () => {
  const clamped = clampBoundsToDisplay(
    { x: 3000, y: -200, width: 3000, height: 2000 },
    SECONDARY.bounds
  );
  assert.deepEqual(clamped, { x: 1920, y: 0, width: 2560, height: 1440 });
});

test("attachDisplayRecovery restores after lock and display sleep", () => {
  const secondaryBounds = { x: 2100, y: 120, width: 1400, height: 900 };
  const win = createMockWindow({ ...secondaryBounds });
  const screen = createMockScreen();
  const powerMonitor = createMockPowerMonitor();

  attachDisplayRecovery({ win, screen, powerMonitor });
  lockSleepUnlockRestore({ win, screen, powerMonitor });

  assert.equal(win.setBoundsCalls.length, 1);
  assert.deepEqual(win.setBoundsCalls[0], secondaryBounds);
});

test("attachDisplayRecovery restores when the display returns with changed bounds", () => {
  const secondaryBounds = { x: 2100, y: 120, width: 1400, height: 900 };
  const returning = { id: 2, bounds: { x: 1920, y: 0, width: 1024, height: 768 } };
  const win = createMockWindow({ ...secondaryBounds });
  const screen = createMockScreen();
  const powerMonitor = createMockPowerMonitor();

  attachDisplayRecovery({ win, screen, powerMonitor });
  powerMonitor.emit("lock-screen");
  screen.emit("display-removed", {}, SECONDARY);
  win.bounds = { x: 100, y: 100, width: 1400, height: 900 };
  for (const handler of win.__listeners.get("move") || []) handler();
  screen.emit("display-added", {}, returning);
  powerMonitor.emit("unlock-screen");

  assert.equal(win.setBoundsCalls.length, 1);
  assert.equal(boundsIntersectDisplay(win.setBoundsCalls[0], returning.bounds), true);
});

test("attachDisplayRecovery restores a sole secondary that returns with an unknown id", () => {
  const secondaryBounds = { x: 2100, y: 120, width: 1400, height: 900 };
  const returning = { id: -1, bounds: { x: -2560, y: 0, width: 2560, height: 1440 } };
  const win = createMockWindow({ ...secondaryBounds });
  const screen = createMockScreen();
  const powerMonitor = createMockPowerMonitor();

  attachDisplayRecovery({ win, screen, powerMonitor });
  powerMonitor.emit("lock-screen");
  screen.emit("display-removed", {}, SECONDARY);
  win.bounds = { x: 100, y: 100, width: 1400, height: 900 };
  for (const handler of win.__listeners.get("move") || []) handler();
  screen.emit("display-added", {}, returning);
  powerMonitor.emit("unlock-screen");

  assert.equal(win.setBoundsCalls.length, 1);
  assert.equal(boundsIntersectDisplay(win.setBoundsCalls[0], returning.bounds), true);
});

test("attachDisplayRecovery keeps the snapshot when Windows relocates before display-removed", () => {
  const secondaryBounds = { x: 2100, y: 120, width: 1400, height: 900 };
  const win = createMockWindow({ ...secondaryBounds });
  const screen = createMockScreen();
  const powerMonitor = createMockPowerMonitor();

  attachDisplayRecovery({ win, screen, powerMonitor });
  powerMonitor.emit("lock-screen");
  win.bounds = { x: 100, y: 100, width: 1400, height: 900 };
  for (const handler of win.__listeners.get("move") || []) handler();
  screen.emit("display-removed", {}, SECONDARY);
  screen.emit("display-added", {}, SECONDARY);
  powerMonitor.emit("unlock-screen");

  assert.equal(win.setBoundsCalls.length, 1);
  assert.deepEqual(win.setBoundsCalls[0], secondaryBounds);
});

test("attachDisplayRecovery restores after a long sleep because lock/suspend stays active", () => {
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  const secondaryBounds = { x: 2100, y: 120, width: 1400, height: 900 };
  const win = createMockWindow({ ...secondaryBounds });
  const screen = createMockScreen();
  const powerMonitor = createMockPowerMonitor();

  try {
    attachDisplayRecovery({ win, screen, powerMonitor });
    powerMonitor.emit("lock-screen");
    powerMonitor.emit("suspend");
    screen.emit("display-removed", {}, SECONDARY);
    win.bounds = { x: 100, y: 100, width: 1400, height: 900 };
    now += 8 * 60 * 60 * 1000;
    powerMonitor.emit("resume");
    powerMonitor.emit("unlock-screen");
    screen.emit("display-added", {}, SECONDARY);

    assert.equal(win.setBoundsCalls.length, 1);
    assert.deepEqual(win.setBoundsCalls[0], secondaryBounds);
  } finally {
    Date.now = realNow;
  }
});

test("attachDisplayRecovery keeps a deferred restore until the window is unmaximized", () => {
  const secondaryBounds = { x: 2100, y: 120, width: 1400, height: 900 };
  const win = createMockWindow({ ...secondaryBounds });
  win.maximized = true;
  win.normalBounds = { ...secondaryBounds };
  const screen = createMockScreen();
  const powerMonitor = createMockPowerMonitor();

  attachDisplayRecovery({ win, screen, powerMonitor });
  powerMonitor.emit("lock-screen");
  screen.emit("display-removed", {}, SECONDARY);
  win.bounds = { x: 100, y: 100, width: 1400, height: 900 };
  win.normalBounds = { ...win.bounds };
  for (const handler of win.__listeners.get("move") || []) handler();
  screen.emit("display-added", {}, SECONDARY);
  powerMonitor.emit("unlock-screen");

  assert.equal(win.setBoundsCalls.length, 0);
  win.unmaximize();
  assert.equal(win.setBoundsCalls.length, 1);
  assert.deepEqual(win.setBoundsCalls[0], secondaryBounds);
});

test("attachDisplayRecovery retries restore when unlock follows a locked relocation", () => {
  const secondaryBounds = { x: 2100, y: 120, width: 1400, height: 900 };
  const win = createMockWindow({ ...secondaryBounds });
  const screen = createMockScreen();
  const powerMonitor = createMockPowerMonitor();

  attachDisplayRecovery({ win, screen, powerMonitor });
  powerMonitor.emit("lock-screen");
  screen.emit("display-removed", {}, SECONDARY);
  screen.emit("display-added", {}, SECONDARY);
  assert.equal(win.setBoundsCalls.length, 0);

  // Windows relocates the window while the session is still locked. Unlock
  // must retry; no later display event is guaranteed.
  win.bounds = { x: 100, y: 100, width: 1400, height: 900 };
  for (const handler of win.__listeners.get("move") || []) handler();
  assert.equal(win.setBoundsCalls.length, 0);
  powerMonitor.emit("unlock-screen");

  assert.equal(win.setBoundsCalls.length, 1);
  assert.deepEqual(win.setBoundsCalls[0], secondaryBounds);
});

test("attachDisplayRecovery restores a late OS move that arrives after the display returns", () => {
  const secondaryBounds = { x: 2100, y: 120, width: 1400, height: 900 };
  const win = createMockWindow({ ...secondaryBounds });
  const screen = createMockScreen();
  const powerMonitor = createMockPowerMonitor();

  attachDisplayRecovery({ win, screen, powerMonitor });
  powerMonitor.emit("lock-screen");
  screen.emit("display-removed", {}, SECONDARY);
  screen.emit("display-added", {}, SECONDARY);
  powerMonitor.emit("unlock-screen");
  assert.equal(win.setBoundsCalls.length, 0);

  win.bounds = { x: 100, y: 100, width: 1400, height: 900 };
  for (const handler of win.__listeners.get("move") || []) handler();

  assert.equal(win.setBoundsCalls.length, 1);
  assert.deepEqual(win.setBoundsCalls[0], secondaryBounds);
});

test("attachDisplayRecovery does not restore a user move to the primary before lock", () => {
  const secondaryBounds = { x: 2100, y: 120, width: 1400, height: 900 };
  const primaryBounds = { x: 100, y: 100, width: 1400, height: 900 };
  const win = createMockWindow({ ...secondaryBounds });
  const screen = createMockScreen();
  const powerMonitor = createMockPowerMonitor();

  attachDisplayRecovery({ win, screen, powerMonitor, restoreGraceMs: 0 });
  moveWindowManually(win, primaryBounds);
  lockSleepUnlockRestore({ win, screen, powerMonitor, afterLockBounds: primaryBounds });

  assert.equal(win.setBoundsCalls.length, 0);
  assert.deepEqual(win.bounds, primaryBounds);
});

test("attachDisplayRecovery does not restore a stale snapshot on a later lock after the user stayed on primary", () => {
  const secondaryBounds = { x: 2100, y: 120, width: 1400, height: 900 };
  const primaryBounds = { x: 300, y: 200, width: 1400, height: 900 };
  const win = createMockWindow({ ...secondaryBounds });
  const screen = createMockScreen();
  const powerMonitor = createMockPowerMonitor();

  attachDisplayRecovery({ win, screen, powerMonitor });
  powerMonitor.emit("lock-screen");
  screen.emit("display-removed", {}, SECONDARY);
  win.bounds = { x: 100, y: 100, width: 1400, height: 900 };
  for (const handler of win.__listeners.get("move") || []) handler();
  powerMonitor.emit("unlock-screen");
  assert.equal(win.setBoundsCalls.length, 0);

  moveWindowManually(win, primaryBounds);
  screen.emit("display-added", {}, SECONDARY);
  powerMonitor.emit("lock-screen");
  powerMonitor.emit("unlock-screen");

  assert.equal(win.setBoundsCalls.length, 0);
  assert.deepEqual(win.bounds, primaryBounds);
});

test("attachDisplayRecovery lets an immediate post-unlock user move win", () => {
  const secondaryBounds = { x: 2100, y: 120, width: 1400, height: 900 };
  const primaryBounds = { x: 300, y: 200, width: 1400, height: 900 };
  const win = createMockWindow({ ...secondaryBounds });
  const screen = createMockScreen();
  const powerMonitor = createMockPowerMonitor();

  attachDisplayRecovery({ win, screen, powerMonitor });
  lockSleepUnlockRestore({ win, screen, powerMonitor });
  assert.equal(win.setBoundsCalls.length, 1);

  moveWindowManually(win, primaryBounds);
  win.bounds = { x: 80, y: 80, width: 1400, height: 900 };
  for (const handler of win.__listeners.get("move") || []) handler();

  assert.equal(win.setBoundsCalls.length, 1);
  assert.deepEqual(win.bounds, { x: 80, y: 80, width: 1400, height: 900 });
});

test("attachDisplayRecovery does not restore ordinary unplug while unlocked", () => {
  const secondaryBounds = { x: 2100, y: 120, width: 1400, height: 900 };
  const win = createMockWindow({ ...secondaryBounds });
  const screen = createMockScreen();
  const powerMonitor = createMockPowerMonitor();

  attachDisplayRecovery({ win, screen, powerMonitor, restoreGraceMs: 0 });
  screen.emit("display-removed", {}, SECONDARY);
  win.bounds = { x: 100, y: 100, width: 1400, height: 900 };
  for (const handler of win.__listeners.get("move") || []) handler();
  screen.emit("display-added", {}, SECONDARY);

  assert.equal(win.setBoundsCalls.length, 0);
});

test("attachDisplayRecovery cancels restore when the user presses Win+Shift+Arrow", () => {
  const secondaryBounds = { x: 2100, y: 120, width: 1400, height: 900 };
  const win = createMockWindow({ ...secondaryBounds });
  const screen = createMockScreen();
  const powerMonitor = createMockPowerMonitor();

  attachDisplayRecovery({ win, screen, powerMonitor });
  powerMonitor.emit("lock-screen");
  screen.emit("display-removed", {}, SECONDARY);
  screen.emit("display-added", {}, SECONDARY);
  powerMonitor.emit("unlock-screen");

  win.webContents.emit("before-input-event", {}, {
    type: "keyDown",
    key: "ArrowLeft",
    meta: true,
    shift: true,
  });
  win.bounds = { x: 100, y: 100, width: 1400, height: 900 };
  for (const handler of win.__listeners.get("move") || []) handler();

  assert.equal(win.setBoundsCalls.length, 0);
});

test("attachDisplayRecovery clamps restored windows to the display work area", () => {
  const DOCKED = {
    id: 2,
    bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
    workArea: { x: 1920, y: 40, width: 2560, height: 1400 },
  };
  const win = createMockWindow({ x: 2000, y: 20, width: 1400, height: 900 });
  const screen = createMockScreen({ displays: [PRIMARY, DOCKED] });
  const powerMonitor = createMockPowerMonitor();

  attachDisplayRecovery({ win, screen, powerMonitor });
  powerMonitor.emit("lock-screen");
  screen.emit("display-removed", {}, DOCKED);
  win.bounds = { x: 100, y: 100, width: 1400, height: 900 };
  for (const handler of win.__listeners.get("move") || []) handler();
  screen.emit("display-added", {}, DOCKED);
  powerMonitor.emit("unlock-screen");

  assert.equal(win.setBoundsCalls.length, 1);
  assert.equal(win.setBoundsCalls[0].y >= 40, true);
});

test("attachDisplayRecovery does nothing when the window never left the primary display", () => {
  const win = createMockWindow({ x: 100, y: 100, width: 1200, height: 800 });
  const screen = createMockScreen();
  const powerMonitor = createMockPowerMonitor();

  attachDisplayRecovery({ win, screen, powerMonitor });
  lockSleepUnlockRestore({ win, screen, powerMonitor, afterLockBounds: win.bounds });

  assert.equal(win.setBoundsCalls.length, 0);
});

test("detach removes all listeners and stops recovery", () => {
  const secondaryBounds = { x: 2100, y: 120, width: 1400, height: 900 };
  const win = createMockWindow({ ...secondaryBounds });
  const screen = createMockScreen();
  const powerMonitor = createMockPowerMonitor();

  const detach = attachDisplayRecovery({ win, screen, powerMonitor });
  detach();
  lockSleepUnlockRestore({ win, screen, powerMonitor });

  assert.equal(win.setBoundsCalls.length, 0);
});

test("attachDisplayRecovery stays disabled outside Windows", () => {
  const win = createMockWindow({ x: 2100, y: 120, width: 1400, height: 900 });
  const screen = createMockScreen();
  const detach = attachDisplayRecoveryForPlatform({ win, screen, platform: "darwin" });
  screen.emit("display-removed", {}, SECONDARY);
  screen.emit("display-added", {}, SECONDARY);
  detach();
  assert.equal(win.setBoundsCalls.length, 0);
});

test("attachDisplayRecovery tolerates a missing screen module", () => {
  const detach = attachDisplayRecoveryForPlatform({ win: {}, screen: null, platform: "win32" });
  assert.equal(typeof detach, "function");
  detach();
});
