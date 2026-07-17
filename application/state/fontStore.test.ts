import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = readFileSync(new URL('./fontStore.ts', import.meta.url), 'utf8');

test('refresh clears local font and availability detection caches', () => {
  assert.match(source, /clearLocalFontsCache\(\);\s*clearFontAvailabilityCache\(\);/);
});
