const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const modulePath = path.join(__dirname, 'systemTheme.cjs');

test('native theme updates reach every live window without a plugin host', () => {
  assert.ok(fs.existsSync(modulePath), 'native system theme broadcaster must exist independently of plugins');
  const { registerSystemThemeListener } = require('./systemTheme.cjs');
  const nativeTheme = new EventEmitter();
  nativeTheme.shouldUseDarkColors = false;
  const calls = [];
  const live = (id) => ({
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel, payload) => calls.push({ id, channel, payload }),
    },
  });
  const windows = [live('main'), live('settings'),
    { isDestroyed: () => true },
    { isDestroyed: () => false, webContents: { isDestroyed: () => true } },
  ];
  const cleanup = registerSystemThemeListener({ nativeTheme, getWindows: () => windows });
  nativeTheme.shouldUseDarkColors = true;
  nativeTheme.emit('updated');
  nativeTheme.shouldUseDarkColors = false;
  nativeTheme.emit('updated');
  assert.deepEqual(calls, [
    { id: 'main', channel: 'netcatty:system-theme-changed', payload: { isDark: true } },
    { id: 'settings', channel: 'netcatty:system-theme-changed', payload: { isDark: true } },
    { id: 'main', channel: 'netcatty:system-theme-changed', payload: { isDark: false } },
    { id: 'settings', channel: 'netcatty:system-theme-changed', payload: { isDark: false } },
  ]);
  cleanup();
  nativeTheme.emit('updated');
  assert.equal(calls.length, 4);
  assert.equal(nativeTheme.listenerCount('updated'), 0);
});
