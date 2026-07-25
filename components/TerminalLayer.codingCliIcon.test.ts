import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./TerminalLayer.tsx', import.meta.url), 'utf8');

test('TerminalLayer gates coding-CLI icon updates with dynamic tab title mode', () => {
  assert.match(source, /shouldUpdateCodingCliTabIcon/);
  assert.match(source, /dynamicTabTitleModeRef\.current = terminalSettings\?\.dynamicTabTitleMode/);
  assert.match(
    source,
    /handleTerminalOutput[\s\S]*?shouldUpdateCodingCliTabIcon\(dynamicTabTitleModeRef\.current\)/,
  );
});
