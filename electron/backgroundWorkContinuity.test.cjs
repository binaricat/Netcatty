const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = __dirname;

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

test('Netcatty windows do not throttle work while hidden or unfocused', () => {
  const windowSources = [
    'bridges/windowManager/mainWindow.cjs',
    'bridges/windowManager/terminalPopupWindow.cjs',
    'bridges/windowManager/settingsWindow.cjs',
    'bridges/windowManager/externalWindows.cjs',
    'bridges/globalShortcutBridge.cjs',
  ];

  for (const relativePath of windowSources) {
    const source = read(relativePath);
    assert.match(source, /webPreferences:\s*\{[\s\S]*?backgroundThrottling:\s*false/, relativePath);
  }

  const externalWindowsSource = read('bridges/windowManager/externalWindows.cjs');
  assert.equal(externalWindowsSource.match(/backgroundThrottling:\s*false/g)?.length, 2);
});

test('the app asks the operating system not to suspend background work', () => {
  const source = read('main.cjs');

  assert.match(source, /powerSaveBlocker/);
  assert.match(source, /powerSaveBlocker\.start\(['"]prevent-app-suspension['"]\)/);
  assert.match(source, /powerSaveBlocker\.stop\(/);
});
