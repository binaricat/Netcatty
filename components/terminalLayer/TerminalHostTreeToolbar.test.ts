import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('host tree toolbar keeps the close button outside the clipped action row', () => {
  const source = readFileSync(new URL('./TerminalHostTreeToolbar.tsx', import.meta.url), 'utf8');

  assert.match(source, /data-section="terminal-host-tree-toolbar-actions"/);
  assert.match(source, /data-section="terminal-host-tree-toolbar-close"/);
  assert.match(source, /data-section="terminal-host-tree-toolbar-actions-fade"/);
  assert.match(source, /data-section="terminal-host-tree-toolbar"/);
  assert.match(source, /backgroundColor: theme\.termBg/);
  assert.match(source, /linear-gradient\(to right, transparent, \$\{theme\.termBg\}\)/);
  assert.doesNotMatch(source, /compactActions/);
  assert.doesNotMatch(source, /flex-1 min-w-0" \/>/);
});

test('host tree toolbar keeps action buttons in the clipped row instead of hiding them', () => {
  const source = readFileSync(new URL('./TerminalHostTreeToolbar.tsx', import.meta.url), 'utf8');

  assert.match(source, /<FolderPlus size=\{14\} \/>/);
  assert.match(source, /<TerminalSquare size=\{14\} \/>/);
  assert.match(source, /<Expand size=\{14\} \/>/);
  assert.match(source, /disabled=\{!canExpandCollapse\}/);
});

test('host tree sidebar wires expand/collapse availability without compact hiding', () => {
  const source = readFileSync(new URL('./TerminalHostTreeSidebar.tsx', import.meta.url), 'utf8');

  assert.match(source, /canExpandCollapse=\{canExpandCollapse\}/);
  assert.doesNotMatch(source, /compactActions/);
  assert.doesNotMatch(source, /shouldCompactTerminalHostTreeToolbar/);
});
