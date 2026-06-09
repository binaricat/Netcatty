import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./TerminalLayerTabBridge.tsx', import.meta.url), 'utf8');

test('terminal layer bridge forwards host tree visibility data to the view context', () => {
  assert.match(source, /const showHostTreeSidebar = s\.showHostTreeSidebar/);
  assert.match(source, /\bshowHostTreeSidebar,\n/);
  assert.match(source, /customGroups:\s*s\.customGroups/);
  assert.match(source, /\bactiveHostIdForSidebar\b/);
});
