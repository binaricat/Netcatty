const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { createPreloadApi } = require('./api.cjs');

const channel = 'netcatty:system-theme-changed';

test('system theme subscription forwards light/dark without exposing the IPC event and unsubscribes', () => {
  const ipcRenderer = new EventEmitter();
  const api = createPreloadApi({ ipcRenderer, webUtils: {} });
  const calls = [];
  const unsubscribe = api.onSystemThemeChanged((...args) => calls.push(args));
  ipcRenderer.emit(channel, { sender: 'private' }, { isDark: true });
  ipcRenderer.emit(channel, { sender: 'private' }, { isDark: false });
  assert.deepEqual(calls, [[{ isDark: true }], [{ isDark: false }]]);
  unsubscribe();
  ipcRenderer.emit(channel, {}, { isDark: true });
  assert.equal(calls.length, 2);
  assert.equal(ipcRenderer.listenerCount(channel), 0);
});

test('system theme subscription ignores malformed payloads', () => {
  const ipcRenderer = new EventEmitter();
  const api = createPreloadApi({ ipcRenderer, webUtils: {} });
  const calls = [];
  const unsubscribe = api.onSystemThemeChanged((payload) => calls.push(payload));
  for (const payload of [undefined, null, {}, { isDark: 'false' }, { isDark: 0 }]) {
    ipcRenderer.emit(channel, {}, payload);
  }
  unsubscribe();
  assert.deepEqual(calls, []);
});
