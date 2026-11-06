const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const test = require('node:test');

function loadWindowManager(platform, trayWindow = null) {
  const filename = path.resolve(__dirname, '../windowManager.cjs');
  const loadedModule = { exports: {} };
  const context = vm.createContext({
    process: { ...process, platform },
    console,
    URL,
    setTimeout,
    clearTimeout,
  });
  const load = vm.runInContext(
    `(function(exports, require, module, __filename, __dirname) { ${fs.readFileSync(filename, 'utf8')}\n})`,
    context,
  );
  const originalRequire = createRequire(filename);
  const requireWithTray = (name) => name === './globalShortcutBridge.cjs'
    ? { getTrayPanelWindow: () => trayWindow }
    : originalRequire(name);
  load(loadedModule.exports, requireWithTray, loadedModule, filename, path.dirname(filename));
  const handlers = new Map();
  loadedModule.exports.registerWindowHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    on: (channel, handler) => handlers.set(channel, handler),
  }, {});
  const state = { opacity: 1, vibrancy: null, background: '#123456' };
  const win = {
    isDestroyed: () => false,
    setOpacity: (value) => { state.opacity = value; },
    setVibrancy: (value) => { state.vibrancy = value; },
    setBackgroundColor: (value) => { state.background = value; },
    webContents: { id: 1, isDestroyed: () => false },
  };
  loadedModule.exports.registerMainWindow(win);
  const invoke = (name, value) => handlers.get(`netcatty:${name}`)({}, value);
  return { invoke, state, windowManager: loadedModule.exports };
}

test('macOS tray blur follows the saved preference and opacity without repainting its clear backing', () => {
  const materials = [];
  const backgrounds = [];
  const opacities = [];
  const trayWindow = {
    isDestroyed: () => false,
    setVibrancy: (value) => materials.push(value),
    setBackgroundColor: (value) => backgrounds.push(value),
    setOpacity: (value) => opacities.push(value),
  };
  const { invoke, windowManager } = loadWindowManager('darwin', trayWindow);
  invoke('setWindowOpacity', 0.7);
  invoke('setWindowBackgroundBlur', true);
  assert.equal(materials.at(-1), 'hud');
  invoke('setWindowOpacity', 1);
  assert.equal(materials.at(-1), null);
  invoke('setWindowOpacity', 0.85);
  assert.equal(materials.at(-1), 'hud');
  invoke('setWindowBackgroundBlur', false);
  assert.equal(materials.at(-1), null);
  assert.deepEqual(backgrounds, []);
  assert.deepEqual(opacities, []);
  assert.equal(windowManager.getAppContentWindows().includes(trayWindow), false);
});

test('a tray created after blur is enabled receives the current native material', () => {
  const { invoke, windowManager } = loadWindowManager('darwin');
  invoke('setWindowOpacity', 0.7);
  invoke('setWindowBackgroundBlur', true);
  const materials = [];
  windowManager.applyTrayPanelBackgroundBlur({
    isDestroyed: () => false,
    setVibrancy: (value) => materials.push(value),
  });
  assert.deepEqual(materials, ['hud']);
  windowManager.applyTrayPanelBackgroundBlur({
    isDestroyed: () => true,
    setVibrancy: () => assert.fail('destroyed tray must not be updated'),
  });
});

test('tray vibrancy is untouched on Windows and Linux', () => {
  for (const platform of ['win32', 'linux']) {
    const { invoke } = loadWindowManager(platform, {
      isDestroyed: () => false,
      setVibrancy: () => assert.fail('non-macOS tray must not use vibrancy'),
    });
    invoke('setWindowOpacity', 0.7);
    invoke('setWindowBackgroundBlur', true);
  }
});

test('macOS blur keeps native opacity at one and restores normal opacity on disable', () => {
  const { invoke, state } = loadWindowManager('darwin');
  assert.equal(state.background, '#123456');
  invoke('setBackgroundColor', '#123456');
  invoke('setWindowBackgroundBlur', true);
  assert.equal(state.vibrancy, null);
  invoke('setWindowOpacity', 0.7);
  assert.equal(state.opacity, 1);
  assert.equal(state.vibrancy, 'hud');
  assert.equal(state.background, '#00000000');
  invoke('setWindowOpacity', 0.85);
  assert.equal(state.opacity, 1);
  invoke('setWindowBackgroundBlur', false);
  assert.equal(state.opacity, 0.85);
  assert.equal(state.vibrancy, null);
  assert.equal(state.background, '#123456');
});

test('restoring 100% removes native vibrancy and restores the theme background', () => {
  const { invoke, state } = loadWindowManager('darwin');
  invoke('setWindowOpacity', 0.7);
  invoke('setWindowBackgroundBlur', true);
  invoke('setBackgroundColor', '#abcdef');
  assert.equal(state.background, '#00000000');
  invoke('setWindowOpacity', 1);
  assert.equal(state.opacity, 1);
  assert.equal(state.vibrancy, null);
  assert.equal(state.background, '#abcdef');
  invoke('setWindowOpacity', 0.7);
  assert.equal(state.opacity, 1);
  assert.equal(state.vibrancy, 'hud');
});

test('unsupported platforms retain the existing opacity behavior', () => {
  for (const platform of ['win32', 'linux']) {
    const { invoke, state } = loadWindowManager(platform);
    invoke('setWindowOpacity', 0.7);
    assert.equal(invoke('setWindowBackgroundBlur', true), false);
    assert.equal(state.opacity, 0.7);
    assert.equal(state.vibrancy, null);
  }
});

test('disabling blur before any theme color push restores the current theme background', () => {
  const { invoke, state } = loadWindowManager('darwin');
  // No setBackgroundColor / setTheme call yet: currentWindowBackgroundColor is
  // still null, so the fallback must come from the active theme.
  invoke('setWindowOpacity', 0.7);
  invoke('setWindowBackgroundBlur', true);
  assert.equal(state.background, '#00000000');
  invoke('setWindowBackgroundBlur', false);
  assert.equal(state.vibrancy, null);
  assert.notEqual(state.background, '#00000000');
  assert.match(String(state.background), /^#[0-9a-fA-F]{6}$/);
});

test('explicit theme and background-color pushes repaint windows that never used blur', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    const { invoke, state } = loadWindowManager(platform);
    assert.equal(state.background, '#123456');
    // Registration-time chrome setup must leave the creation-time color alone...
    invoke('setWindowBackgroundBlur', false);
    assert.equal(state.background, '#123456');
    // ...but an explicit theme color must always land.
    invoke('setBackgroundColor', '#abcdef');
    assert.equal(state.background, '#abcdef');
    invoke('setTheme', 'dark');
    assert.match(String(state.background), /^#[0-9a-fA-F]{6}$/);
    assert.notEqual(state.background, '#abcdef');
  }
});
