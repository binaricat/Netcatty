import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

/**
 * useSettingsIpcSync is a React hook (useEffect-driven); without
 * react-test-renderer available in this environment we can't mount it and
 * assert on live cross-window broadcast behavior. These structural checks
 * instead verify the source wiring end-to-end: every other window's
 * useSettingsState instance (mounted via AppLockGate, even though the
 * auto-launch toggle only ever renders in the Settings window) must consume
 * the STORAGE_KEY_AUTO_LAUNCH_ENABLED broadcast, matching the established
 * pattern used by every other synchronized boolean setting in this file.
 */

test('settingsIpcSync handles the auto-launch broadcast key like other synced booleans', () => {
  const source = fs.readFileSync(new URL('./settingsIpcSync.ts', import.meta.url), 'utf8');

  assert.match(
    source,
    /STORAGE_KEY_AUTO_LAUNCH_ENABLED/,
    'must import the storage key',
  );
  assert.match(
    source,
    /if \(key === STORAGE_KEY_AUTO_LAUNCH_ENABLED && typeof value === 'boolean'\) \{\s*[\s\S]*?setAutoLaunchEnabled\(/,
    'must apply the broadcast value to local state, same as e.g. STORAGE_KEY_GLOBAL_HOTKEY_ENABLED',
  );
  assert.match(
    source,
    /setAutoLaunchEnabled: Dispatch<SetStateAction<boolean>>/,
    'the setter prop must be declared on the params interface',
  );

  // The dependency array of the effect must list the setter, or the
  // listener could close over a stale setter reference after a re-render.
  const effectStart = source.indexOf('useEffect(() => {');
  const depsStart = source.indexOf('}, [', effectStart);
  assert.ok(effectStart > -1 && depsStart > effectStart, 'expected to find the sync effect and its deps array');
  const depsSlice = source.slice(depsStart, source.indexOf(']);', depsStart));
  assert.match(depsSlice, /setAutoLaunchEnabled/, 'setAutoLaunchEnabled must be listed in the effect deps array');
});

test('useSettingsState wires the real autoLaunchEnabled setter into useSettingsIpcSync (not a no-op)', () => {
  const source = fs.readFileSync(new URL('./useSettingsState.ts', import.meta.url), 'utf8');

  const hookCallStart = source.indexOf('useSettingsIpcSync({');
  assert.notEqual(hookCallStart, -1, 'expected to find the useSettingsIpcSync(...) call');
  const hookCallEnd = source.indexOf('});', hookCallStart);
  const callSlice = source.slice(hookCallStart, hookCallEnd);

  assert.match(
    callSlice,
    /setAutoLaunchEnabled,/,
    'useSettingsIpcSync must receive the real setAutoLaunchEnabled state setter, ' +
      'or a broadcast from another window silently does nothing in this one',
  );
});
