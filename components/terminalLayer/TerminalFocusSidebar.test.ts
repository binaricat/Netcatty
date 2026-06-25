import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./TerminalFocusSidebar.tsx', import.meta.url), 'utf8');

test('focus sidebar row memo refreshes when dynamic title mode changes', () => {
  assert.match(source, /prev\.dynamicTabTitleMode === next\.dynamicTabTitleMode/);
});
