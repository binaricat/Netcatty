import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldFadeImmersiveRestoreForTab } from './useImmersiveMode';

test('skips immersive restore fade when switching to an editor tab', () => {
  assert.equal(shouldFadeImmersiveRestoreForTab('editor:/tmp/example.txt'), false);
});

test('keeps immersive restore fade for root pages and log tabs', () => {
  assert.equal(shouldFadeImmersiveRestoreForTab('vault'), true);
  assert.equal(shouldFadeImmersiveRestoreForTab('sftp'), true);
  assert.equal(shouldFadeImmersiveRestoreForTab('log-127.0.0.1'), true);
});
