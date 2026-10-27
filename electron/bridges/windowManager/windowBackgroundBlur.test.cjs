const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const test = require('node:test');

function loadWindowManager(platform) {
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
  load(loadedModule.exports, createRequire(filename), loadedModule, filename, path.dirname(filename));
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
  return { invoke, state };
}

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
