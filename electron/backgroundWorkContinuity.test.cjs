const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = __dirname;

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

test('terminal windows do not throttle work while hidden or unfocused', () => {
  const windowSources = [
    'bridges/windowManager/mainWindow.cjs',
    'bridges/windowManager/terminalPopupWindow.cjs',
  ];

  for (const relativePath of windowSources) {
    const source = read(relativePath);
    assert.match(source, /webPreferences:\s*\{[\s\S]*?backgroundThrottling:\s*false/, relativePath);
  }
});

test('non-terminal windows and the app itself do not block ordinary power saving', () => {
  const sources = [
    'main.cjs',
    'bridges/windowManager/settingsWindow.cjs',
    'bridges/windowManager/externalWindows.cjs',
    'bridges/globalShortcutBridge.cjs',
  ];

  for (const relativePath of sources) {
    const source = read(relativePath);
    assert.doesNotMatch(source, /backgroundThrottling:\s*false|powerSaveBlocker/, relativePath);
  }
});
