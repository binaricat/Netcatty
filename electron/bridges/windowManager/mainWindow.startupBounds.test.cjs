const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createMainWindowApi, resolveStartupBounds } = require("./mainWindow.cjs");

// 1470x956 logical MacBook display with menu bar and dock excluded from workArea.
const MAC_BOOK = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1470, height: 956 },
  workArea: { x: 0, y: 33, width: 1470, height: 848 },
};
const large = {
  id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};
const ultrawide = {
  id: 4, bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  workArea: { x: 0, y: 0, width: 2560, height: 1400 },
};
const small = {
  id: 2, bounds: { x: 0, y: 0, width: 1093, height: 614 },
  workArea: { x: 0, y: 0, width: 1093, height: 585 },
};
const defaults = { width: 1400, height: 900 };
const NOMINAL_MIN_WIDTH = 960;
const NOMINAL_MIN_HEIGHT = 540;

const intersects = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x
  && a.y < b.y + b.height && a.y + a.height > b.y;

function screenWith(...displays) {
  return {
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => displays[0],
    getDisplayMatching: () => displays[0],
  };
}

// Exercise the real constructor and lifecycle with recorded native calls.
async function create(saved, primary = large, displays = [primary], matching) {
  const writes = [];
  const screen = new EventEmitter();
  screen.getPrimaryDisplay = () => primary;
  screen.getAllDisplays = () => displays.filter(Boolean);
  screen.getDisplayMatching = matching || ((bounds) => displays.find((d) => d && intersects(bounds, d.bounds)) || displays.at(-1));
  let options;
  class Window extends EventEmitter {
    constructor(opts) {
      super();
      options = opts;
      this.bounds = { x: opts.x ?? primary?.workArea.x ?? 0, y: opts.y ?? primary?.workArea.y ?? 0, width: opts.width, height: opts.height };
      this.minimum = [opts.minWidth, opts.minHeight];
      this.maximized = false;
      this.fullscreen = false;
      this.webContents = Object.assign(new EventEmitter(), {
        id: 71, isDestroyed: () => false, setWindowOpenHandler() {}, send() {},
      });
    }
    isDestroyed() { return false; }
    isMaximized() { return this.maximized; }
    isFullScreen() { return this.fullscreen; }
    isMinimized() { return this.minimized === true; }
    getBounds() { return { ...this.bounds }; }
    getMinimumSize() { return this.minimum; }
    setMinimumSize(w, h) { this.minimum = [w, h]; }
    maximize() { this.maximized = true; }
    setFullScreen(value) { this.fullscreen = value; }
    setBackgroundColor() {}
    loadURL() { return Promise.resolve(); }
    close() {}
  }
  const api = createMainWindowApi({
    mainWindow: null, electronApp: null, currentTheme: "light", isQuitting: true,
    pendingWindowStateWrite: null, queuedWindowState: null,
    DEFAULT_WINDOW_WIDTH: 1400, DEFAULT_WINDOW_HEIGHT: 900,
    MIN_WINDOW_WIDTH: NOMINAL_MIN_WIDTH, MIN_WINDOW_HEIGHT: NOMINAL_MIN_HEIGHT,
    V8_CACHE_OPTIONS: "code", THEME_COLORS: { light: {} },
    unhealthyWebContentsIds: new Set(), rendererReadySeenByWebContentsId: new Set(),
    __dirname, URL, require, console, setTimeout, clearTimeout,
    debugLog() {}, resolveFrontendBackgroundColor() { return null; }, loadWindowState() { return saved; },
    getWindowBoundsState(win, normal) {
      return { ...(normal || win.getBounds()), isMaximized: win.isMaximized(), isFullScreen: win.isFullScreen() };
    },
    queueWindowStateSave: (state) => writes.push(state), saveWindowStateSync: (state) => writes.push(state),
    setupDeferredShow() {}, createExternalOnlyWindowOpenHandler() { return {}; }, createAppWindowOpenHandler() { return {}; },
    attachOAuthLoadingOverlay() {}, registerWindowHandlers() {}, registerMainWindow() {}, unregisterMainWindow() {},
    closeSettingsWindow() {}, applyWindowOpacityToWindow() {},
  });
  const win = await api.createWindow(
    { BrowserWindow: Window, nativeTheme: {}, app: {}, screen, shell: {}, ipcMain: {} },
    { preload: "/unused/preload.cjs", isDev: false, isMac: true, electronDir: __dirname },
  );
  assert.deepEqual(writes, [], "calculating startup bounds must not persist settings");
  return { win, options, screen, writes };
}
const geometry = (o) => [o.width, o.height, o.minWidth, o.minHeight];

test("pulls a partially off-screen saved window back inside the work area", () => {
  // The saved window's right/bottom edges hang past the screen edge.
  const { bounds, minimum } = resolveStartupBounds(
    screenWith(MAC_BOOK),
    { x: 499, y: 253, width: 1100, height: 838 },
    defaults,
    NOMINAL_MIN_WIDTH,
    NOMINAL_MIN_HEIGHT,
  );

  assert.deepEqual(minimum, { width: 719, height: 408 });
  assert.deepEqual(bounds, { x: 370, y: 43, width: 1100, height: 838 });
});

test("caps a saved window larger than the display to the work area", () => {
  const { bounds } = resolveStartupBounds(
    screenWith(MAC_BOOK),
    { x: -200, y: 100, width: 2000, height: 1200 },
    defaults,
    NOMINAL_MIN_WIDTH,
    NOMINAL_MIN_HEIGHT,
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
    NOMINAL_MIN_WIDTH,
    NOMINAL_MIN_HEIGHT,
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
    NOMINAL_MIN_WIDTH,
    NOMINAL_MIN_HEIGHT,
  );

  assert.deepEqual(minimum, { width: 944, height: 524 });
  assert.deepEqual(bounds, { x: 1920, y: 500, width: 944, height: 600 });
});

test("centers a default window without starting larger than the work area", () => {
  const { bounds } = resolveStartupBounds(
    screenWith(MAC_BOOK),
    null,
    defaults,
    NOMINAL_MIN_WIDTH,
    NOMINAL_MIN_HEIGHT,
  );

  assert.deepEqual(bounds, { width: 1400, height: 848 });
  assert.equal("x" in bounds, false);
  assert.equal("y" in bounds, false);
});

test("grows a saved window to the tiling minimum and keeps it on screen", () => {
  const { bounds } = resolveStartupBounds(
    screenWith(MAC_BOOK),
    { x: 100, y: 100, width: 500, height: 300 },
    defaults,
    NOMINAL_MIN_WIDTH,
    NOMINAL_MIN_HEIGHT,
  );

  assert.deepEqual(bounds, { x: 100, y: 100, width: 719, height: 408 });
});

test("preserves macOS half-screen, quarter-screen, and margined tiling bounds", () => {
  for (const tiled of [
    { x: 0, y: 33, width: 735, height: 848 },
    { x: 735, y: 33, width: 735, height: 425 },
    { x: 8, y: 41, width: 723, height: 413 },
  ]) {
    const { bounds, minimum } = resolveStartupBounds(
      screenWith(MAC_BOOK),
      tiled,
      defaults,
      NOMINAL_MIN_WIDTH,
      NOMINAL_MIN_HEIGHT,
    );
    assert.deepEqual(minimum, { width: 719, height: 408 });
    assert.deepEqual(bounds, tiled);
  }
});

test("falls back to the static nominal minimum when no display is available", () => {
  const { bounds, minimum } = resolveStartupBounds(
    { getAllDisplays: () => [], getPrimaryDisplay: () => null },
    { x: 10, y: 10, width: 500, height: 300 },
    defaults,
    NOMINAL_MIN_WIDTH,
    NOMINAL_MIN_HEIGHT,
  );

  assert.deepEqual(bounds, { x: 10, y: 10, width: 960, height: 540 });
  assert.deepEqual(minimum, { width: 960, height: 540 });
});

test("ordinary large-display default stays 1400x900 with half-screen cap, and nominal 960x540 on wide displays", async () => {
  assert.deepEqual(geometry((await create(null, large)).options), [1400, 900, 944, 504]);
  assert.deepEqual(geometry((await create(null, ultrawide)).options), [1400, 900, 960, 540]);
});

test("fresh small-display default fits each overflowing axis", async () => {
  assert.deepEqual(geometry((await create(null, small)).options), [1093, 585, 530, 276]);
});

test("huge saved bounds fit the target work area without mutating saved settings", async () => {
  const saved = Object.freeze({ x: 10, y: 20, width: 4000, height: 3000 });
  const { options } = await create(saved, small);
  assert.deepEqual(geometry(options), [1093, 585, 530, 276]);
  assert.deepEqual([options.x, options.y], [0, 0]);
});

test("fitting in-workArea placement remains exact while off-screen edges pull back inside", async () => {
  const inside = (await create({ x: 30, y: 15, width: 1000, height: 560 }, small)).options;
  assert.deepEqual([inside.x, inside.y, inside.width, inside.height], [30, 15, 1000, 560]);

  const topLeftClipped = (await create({ x: -20, y: -10, width: 1000, height: 560 }, small)).options;
  assert.deepEqual([topLeftClipped.x, topLeftClipped.y, topLeftClipped.width, topLeftClipped.height], [0, 0, 1000, 560]);

  const bottomRightClipped = (await create({ x: 1000, y: 500, width: 1000, height: 560 }, small)).options;
  assert.deepEqual([bottomRightClipped.x, bottomRightClipped.y, bottomRightClipped.width, bottomRightClipped.height], [93, 25, 1000, 560]);
});

test("only overflowing axes shrink; undersized axes rise to the effective minimum", async () => {
  for (const [width, height, expected] of [
    [1600, 560, [1093, 560]],
    [1000, 1000, [1000, 585]],
    [400, 200, [530, 276]],
    [1093, 585, [1093, 585]],
  ]) {
    const { options } = await create({ x: 0, y: 0, width, height }, small);
    assert.deepEqual([options.width, options.height], expected);
  }
});

test("workArea offsets/taskbars recover inaccessible positions while preserving valid ones", async () => {
  const display = { ...small, workArea: { x: 80, y: 40, width: 1013, height: 545 } };
  const { options } = await create({ x: -950, y: 0, width: 1000, height: 540 }, display);
  assert.deepEqual([options.x, options.y, options.width, options.height], [80, 40, 1000, 540]);
  const usable = (await create({ x: 90, y: 42, width: 1000, height: 540 }, display)).options;
  assert.deepEqual([usable.x, usable.y, usable.width, usable.height], [90, 42, 1000, 540]);
});

test("negative secondary origin selects that display and preserves valid position", async () => {
  const secondary = { ...small, bounds: { ...small.bounds, x: -1093 }, workArea: { ...small.workArea, x: -1093 } };
  const { options } = await create({ x: -1080, y: 15, width: 1000, height: 560 }, large, [large, secondary]);
  assert.deepEqual([options.x, options.y, ...geometry(options)], [-1080, 15, 1000, 560, 530, 276]);
});

test("removed saved screen falls back to primary even when Electron matches the nearest secondary", async () => {
  const secondary = { ...large, id: 3, bounds: { ...large.bounds, x: 1920 }, workArea: { ...large.workArea, x: 1920 } };
  const { options } = await create({ x: 8000, y: 100, width: 4000, height: 3000 }, small, [small, secondary], () => secondary);
  assert.deepEqual(geometry(options), [1093, 585, 530, 276]);
  assert.ok(intersects({ ...options }, small.workArea));
});

test("DIP startup sizing does not rescale at 1, 1.25, 1.5 or 2", async () => {
  for (const scaleFactor of [1, 1.25, 1.5, 2]) {
    const { options } = await create(null, { ...small, scaleFactor });
    assert.deepEqual(geometry(options), [1093, 585, 530, 276]);
  }
});

test("representative work areas apply the half-screen tiling cap and emergency floor", async () => {
  for (const [width, height, expected] of [
    [2560, 1440, [1400, 900, 960, 540]],
    [1366, 728, [1366, 728, 667, 348]],
    [1280, 680, [1280, 680, 624, 324]],
    [960, 540, [960, 540, 464, 254]],
    [300, 200, [320, 240, 320, 240]],
  ]) {
    const display = { bounds: { x: 0, y: 0, width, height }, workArea: { x: 0, y: 0, width, height } };
    assert.deepEqual(geometry((await create(null, display)).options), expected);
  }
});

test("legacy dimension-only state and unavailable screen keep usable dimensions", async () => {
  assert.deepEqual(geometry((await create({ width: 1000, height: 560 }, small)).options), [1000, 560, 530, 276]);
  const { options } = await create({ width: 800, height: 400 }, null, []);
  assert.deepEqual(geometry(options), [960, 540, 960, 540]);
});

test("saved flags retain existing startup semantics with fitted normal bounds and no startup write", async () => {
  for (const [isMaximized, isFullScreen] of [[true, false], [false, true], [true, true]]) {
    const { win, options, writes } = await create({ x: 10, y: 20, width: 4000, height: 3000, isMaximized, isFullScreen }, small);
    assert.deepEqual(geometry(options), [1093, 585, 530, 276]);
    win.emit("ready-to-show");
    assert.equal(win.isMaximized(), isMaximized && !isFullScreen);
    // Existing startup deliberately does not re-enter fullscreen.
    assert.equal(win.isFullScreen(), false);
    assert.deepEqual(writes, []);
    win.emit("close", { preventDefault() {} });
    win.emit("closed");
  }
});

test("manual normal bounds persist across maximized/fullscreen/minimized close", async () => {
  for (const state of ["maximized", "fullscreen", "minimized"]) {
    const { win, writes } = await create(null);
    const normal = { x: 75, y: 80, width: 1040, height: 620 };
    win.bounds = normal;
    win.emit("move");
    win[state] = true;
    // A minimized window retains its normal native bounds; max/fullscreen do not.
    if (state !== "minimized") win.bounds = { x: 0, y: 0, width: 1920, height: 1080 };
    win.emit("resize");
    win.emit("close", { preventDefault() {} });
    assert.deepEqual(writes.at(-1), { ...normal, isMaximized: state === "maximized", isFullScreen: state === "fullscreen" });
    win.emit("closed");
  }
});

test("live minimum sync moves between displays, recovers after removal, and detaches on close", async () => {
  const secondary = { ...small, bounds: { ...small.bounds, x: -1093 }, workArea: { ...small.workArea, x: -1093 } };
  const { win, screen } = await create(null, large, [large, secondary]);
  win.bounds = { x: -1080, y: 0, width: 1000, height: 560 };
  win.emit("move");
  assert.deepEqual(win.minimum, [530, 276]);
  screen.getDisplayMatching = () => large;
  screen.emit("display-removed");
  assert.deepEqual(win.minimum, [944, 504]);
  screen.getDisplayMatching = () => small;
  screen.emit("display-metrics-changed");
  assert.deepEqual(win.minimum, [530, 276]);
  win.emit("close", { preventDefault() {} });
  win.emit("closed");
  assert.equal(screen.listenerCount("display-removed"), 0);
  assert.equal(screen.listenerCount("display-metrics-changed"), 0);
});
