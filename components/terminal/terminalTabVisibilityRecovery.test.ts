import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./useTerminalEffects.ts', import.meta.url), 'utf8');

test('clears committed layout state when a terminal pane hides', () => {
  assert.match(source, /if \(isVisible\) return;[\s\S]*lastCommittedVisibleLayoutKeyRef\.current = null/);
  assert.match(source, /lastWebglRecoveryLayoutKeyRef\.current = null/);
});

test('forces full recovery when a terminal pane becomes visible again', () => {
  assert.match(source, /const becameVisible = isVisible && !wasVisibleRef\.current/);
  assert.match(source, /recoverTerminalAfterBecomeVisible\(\)/);
  assert.match(source, /nudgeAlternateScreenRedraw\(term\)/);
  assert.match(source, /syncPtySizeAfterLayout/);
});

test('layout recovery refit also syncs PTY size for full-screen TUIs', () => {
  assert.match(source, /runImmediateRefit\(\{ force: true, repeatOnNextFrame: false \}\);\s*finishLayoutRecoveryAfterFit\(\)/);
  assert.match(source, /finishLayoutRecoveryAfterFit/);
});
