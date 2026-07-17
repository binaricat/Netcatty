import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const source = readFileSync(
  new URL('./TerminalCjkFontSelect.tsx', import.meta.url),
  'utf8',
);

test('font warnings follow the value currently shown in the preview', () => {
  assert.match(
    source,
    /getTerminalCjkFontSelectionStatus\(\s*previewSelection,/,
  );
  assert.match(
    source,
    /previewSelection && isFontInstalled\(previewSelection\)/,
  );
});
