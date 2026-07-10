import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APP_ICON_VARIANT_ASSET_PATH } from './appIconVariants';

test('original icon preview uses the desktop-sized runtime asset', () => {
  assert.equal(APP_ICON_VARIANT_ASSET_PATH.original, '/icons/variants/original.png');
});
