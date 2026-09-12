import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const appSideEffectsSource = readFileSync(join(here, 'AppSideEffects.tsx'), 'utf8');

test('terminal keyboard focus tracking is always published to the main process', () => {
  assert.match(
    appSideEffectsSource,
    /useTerminalKeyboardFocus\(\s*\)/,
    'the terminal keyboard focus signal must be unconditional',
  );
});

test('terminal keyboard focus is not gated on hotkey scheme or font zoom settings', () => {
  // When the signal is turned off, the main process falls back to window zoom
  // for Ctrl+= / Ctrl+- / Ctrl+0 while the user is typing in a terminal, so
  // "disable terminal zoom" and per-binding overrides stop having any effect
  // on those chords (#3327).
  assert.doesNotMatch(appSideEffectsSource, /useTerminalKeyboardFocus\(\s*hotkeyScheme/);
  assert.doesNotMatch(
    appSideEffectsSource,
    /useTerminalKeyboardFocus\(\s*[^)\s][^)]*disableTerminalFontZoom/,
  );
});
