const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createMainWindowApi } = require("./mainWindow.cjs");

const large = {
  id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};
const small = {
  id: 2, bounds: { x: 0, y: 0, width: 1093, height: 614 },
  workArea: { x: 0, y: 0, width: 1093, height: 585 },
};
const intersects = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x
  && a.y < b.y + b.height && a.y + a.height > b.y;

// Exercise the real constructor and lifecycle with recorded native calls.
async function create(saved, primary = large, displays = [primary], matching) {
  const writes = [];
  const screen = new EventEmitter();
  screen.getPrimaryDisplay = () => primary;
  screen.getAllDisplays = () => displays;
  screen.getDisplayMatching = matching || ((bounds) => displays.find((d) => intersects(bounds, d.bounds)) || displays.at(-1));
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
    DEFAULT_WINDOW_WIDTH: 1400, DEFAULT_WINDOW_HEIGHT: 900, MIN_WINDOW_WIDTH: 960, MIN_WINDOW_HEIGHT: 540,
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

test("ordinary large-display default stays 1400x900 with 960x540 minimum", async () => {
  assert.deepEqual(geometry((await create(null)).options), [1400, 900, 960, 540]);
});

test("fresh small-display default fits each overflowing axis", async () => {
  assert.deepEqual(geometry((await create(null, small)).options), [983, 526, 960, 526]);
});

test("huge saved bounds fit the target work area without mutating saved settings", async () => {
  const saved = Object.freeze({ x: 10, y: 20, width: 4000, height: 3000 });
  const { options } = await create(saved, small);
  assert.deepEqual(geometry(options), [983, 526, 960, 526]);
  assert.deepEqual([options.x, options.y], [10, 20]);
});

test("fitting dimensions and usable partial placements remain exact", async () => {
  for (const [x, y] of [[30, 15], [-20, -10], [1000, 500]]) {
    const { options } = await create({ x, y, width: 1000, height: 560 }, small);
    assert.deepEqual([options.x, options.y, options.width, options.height], [x, y, 1000, 560]);
  }
});

test("only overflowing axes shrink; undersized axes rise to the effective minimum", async () => {
  for (const [width, height, expected] of [
    [1600, 560, [983, 560]], [1000, 1000, [1000, 526]],
    [800, 400, [960, 526]], [1093, 585, [1093, 585]],
  ]) {
    const { options } = await create({ x: 0, y: 0, width, height }, small);
    assert.deepEqual([options.width, options.height], expected);
  }
});

test("workArea offsets/taskbars recover inaccessible positions only", async () => {
  const display = { ...small, workArea: { x: 80, y: 40, width: 1013, height: 545 } };
  const { options } = await create({ x: -950, y: 0, width: 1000, height: 540 }, display);
  assert.deepEqual([options.x, options.y, options.width, options.height], [80, 40, 1000, 540]);
  const usable = (await create({ x: 90, y: 42, width: 1000, height: 540 }, display)).options;
  assert.deepEqual([usable.x, usable.y, usable.width, usable.height], [90, 42, 1000, 540]);
});

test("negative secondary origin selects that display and preserves valid position", async () => {
  const secondary = { ...small, bounds: { ...small.bounds, x: -1093 }, workArea: { ...small.workArea, x: -1093 } };
  const { options } = await create({ x: -1080, y: 15, width: 1000, height: 560 }, large, [large, secondary]);
  assert.deepEqual([options.x, options.y, ...geometry(options)], [-1080, 15, 1000, 560, 960, 526]);
});

test("removed saved screen falls back to primary even when Electron matches the nearest secondary", async () => {
  const secondary = { ...large, id: 3, bounds: { ...large.bounds, x: 1920 }, workArea: { ...large.workArea, x: 1920 } };
  const { options } = await create({ x: 8000, y: 100, width: 4000, height: 3000 }, small, [small, secondary], () => secondary);
  assert.deepEqual(geometry(options), [983, 526, 960, 526]);
  assert.ok(intersects({ ...options }, small.workArea));
});

test("DIP startup sizing does not rescale at 1, 1.25, 1.5 or 2", async () => {
  for (const scaleFactor of [1, 1.25, 1.5, 2]) {
    const { options } = await create(null, { ...small, scaleFactor });
    assert.deepEqual(geometry(options), [983, 526, 960, 526]);
  }
});

test("representative work areas retain the adaptive 90 percent minimum and emergency floor", async () => {
  for (const [width, height, expected] of [
    [1366, 728, [1229, 655, 960, 540]], [1280, 680, [1152, 612, 960, 540]],
    [960, 540, [864, 486, 864, 486]], [300, 200, [320, 240, 320, 240]],
  ]) {
    const display = { bounds: { x: 0, y: 0, width, height }, workArea: { x: 0, y: 0, width, height } };
    assert.deepEqual(geometry((await create(null, display)).options), expected);
  }
});

test("legacy dimension-only state and unavailable screen keep usable dimensions", async () => {
  assert.deepEqual(geometry((await create({ width: 1000, height: 560 }, small)).options), [1000, 560, 960, 526]);
  const { options } = await create({ width: 800, height: 400 }, null, []);
  assert.deepEqual(geometry(options), [960, 540, 960, 540]);
});

test("saved flags retain existing startup semantics with fitted normal bounds and no startup write", async () => {
  for (const [isMaximized, isFullScreen] of [[true, false], [false, true], [true, true]]) {
    const { win, options, writes } = await create({ x: 10, y: 20, width: 4000, height: 3000, isMaximized, isFullScreen }, small);
    assert.deepEqual(geometry(options), [983, 526, 960, 526]);
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
  assert.deepEqual(win.minimum, [960, 526]);
  screen.getDisplayMatching = () => large;
  screen.emit("display-removed");
  assert.deepEqual(win.minimum, [960, 540]);
  screen.getDisplayMatching = () => small;
  screen.emit("display-metrics-changed");
  assert.deepEqual(win.minimum, [960, 526]);
  win.emit("close", { preventDefault() {} });
  win.emit("closed");
  assert.equal(screen.listenerCount("display-removed"), 0);
  assert.equal(screen.listenerCount("display-metrics-changed"), 0);
});
