const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = __dirname;

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), 'utf8');
}

const WINDOW_SOURCES_WITH_SPELLCHECK = [
  'bridges/windowManager/mainWindow.cjs',
  'bridges/windowManager/settingsWindow.cjs',
  'bridges/windowManager/terminalPopupWindow.cjs',
  'bridges/windowManager/editorWindow.cjs',
  'bridges/globalShortcutBridge.cjs',
  'bridges/windowManager/externalWindows.cjs',
  'plugins/contributionIconRasterizer.cjs',
];

test('BrowserWindow webPreferences disable spellcheck for app windows', () => {
  for (const relativePath of WINDOW_SOURCES_WITH_SPELLCHECK) {
    const source = read(relativePath);
    assert.match(
      source,
      /webPreferences:\s*\{[\s\S]*?spellcheck:\s*false/,
      relativePath,
    );
  }
});

test('default session spell checker is disabled after ready', () => {
  const source = read('main.cjs');
  assert.match(source, /setSpellCheckerEnabled\?\.\(false\)/);
  assert.match(source, /app\.whenReady\(\)\.then\(/);
});

test('SpareRendererForSitePerProcess is disabled via command-line switch', () => {
  const source = read('main.cjs');
  assert.match(
    source,
    /appendSwitch\(\s*["']disable-features["']\s*,\s*["']SpareRendererForSitePerProcess["']\s*\)/,
  );
});

test('settings prewarm is off by default and only runs behind NETCATTY_PREWARM_SETTINGS=1', () => {
  const source = read('main.cjs');
  assert.match(source, /NETCATTY_PREWARM_SETTINGS\s*===\s*["']1["']/);
  assert.match(source, /setTimeout\(\s*\(\)\s*=>\s*\{[\s\S]*?prewarmSettingsWindow[\s\S]*?\},\s*15000\s*\)/);
  assert.doesNotMatch(source, /setTimeout\(\s*\(\)\s*=>\s*\{[\s\S]*?prewarmSettingsWindow[\s\S]*?\},\s*3000\s*\)/);
});

test('aggressive GPU switches are gated by NETCATTY_COMPAT_GPU and keep both ignore aliases', () => {
  const source = read('main.cjs');
  assert.match(source, /NETCATTY_COMPAT_GPU\s*!==\s*["']1["']/);
  assert.match(source, /appendSwitch\(\s*["']ignore-gpu-blocklist["']\s*\)/);
  assert.match(source, /appendSwitch\(\s*["']ignore-gpu-blacklist["']\s*\)/);
  const gateIdx = source.indexOf('NETCATTY_COMPAT_GPU');
  const blocklistIdx = source.indexOf('ignore-gpu-blocklist');
  const blacklistIdx = source.indexOf('ignore-gpu-blacklist');
  assert.ok(gateIdx >= 0 && blocklistIdx > gateIdx && blacklistIdx > gateIdx);
});

test('backgroundThrottling:false stays on terminal windows only, not settings', () => {
  const main = read('bridges/windowManager/mainWindow.cjs');
  const popup = read('bridges/windowManager/terminalPopupWindow.cjs');
  const settings = read('bridges/windowManager/settingsWindow.cjs');
  assert.match(main, /backgroundThrottling:\s*false/);
  assert.match(popup, /backgroundThrottling:\s*false/);
  assert.doesNotMatch(settings, /backgroundThrottling:\s*false/);
});
