import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isWindowBackgroundBlurActive,
} from './windowBackgroundBlur';

test('window background blur is visible only with a translucent surface', () => {
  assert.equal(isWindowBackgroundBlurActive(true, 1), false);
  assert.equal(isWindowBackgroundBlurActive(true, 0.99), true);
  assert.equal(isWindowBackgroundBlurActive(true, 0.5), true);
  assert.equal(isWindowBackgroundBlurActive(true, Number.NaN), false);
});

test('window background blur becomes inactive without losing the request state', () => {
  assert.equal(isWindowBackgroundBlurActive(true, 0.85), true);
  assert.equal(isWindowBackgroundBlurActive(true, 1), false);
  assert.equal(isWindowBackgroundBlurActive(false, 0.85), false);
});
