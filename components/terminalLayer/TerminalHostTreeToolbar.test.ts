import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const toolbarSource = readFileSync(new URL('./TerminalHostTreeToolbar.tsx', import.meta.url), 'utf8');
const menuSource = readFileSync(new URL('../host/HostTreeContextMenus.tsx', import.meta.url), 'utf8');

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
  const source = toolbarSource;

  assert.match(source, /<FolderPlus size=\{14\} \/>/);
  assert.match(source, /<TerminalSquare size=\{14\} \/>/);
  assert.match(source, /<Expand size=\{14\} \/>/);
  assert.match(source, /disabled=\{!canExpandCollapse\}/);
});

test('host tree toolbar exposes host creation alongside the context menus', () => {
  assert.match(toolbarSource, /onNewHost: \(\) => void/);
  assert.match(toolbarSource, /disabled=\{!canNewHost\}/);
  assert.match(toolbarSource, /onClick=\{onNewHost\}/);
  assert.match(toolbarSource, /<Plus size=\{14\} \/>/);
  assert.match(toolbarSource, /terminal\.layer\.hostTree\.newHost/);
});

test('shared host tree menus expose optional full edit and group host creation actions', () => {
  assert.match(menuSource, /onEditHost\?: \(host: Host\) => void/);
  assert.match(menuSource, /onNewHost\?: \(groupPath: string\) => void/);
  assert.match(menuSource, /terminal\.layer\.hostTree\.editHost/);
  assert.match(menuSource, /terminal\.layer\.hostTree\.newHostInGroup/);
});

test('host tree sidebar wires expand/collapse availability without compact hiding', () => {
  const source = readFileSync(new URL('./TerminalHostTreeSidebar.tsx', import.meta.url), 'utf8');

  assert.match(source, /canExpandCollapse=\{canExpandCollapse\}/);
  assert.match(source, /canNewHost=\{Boolean\(onNewHost\)\}/);
  assert.doesNotMatch(source, /compactActions/);
  assert.doesNotMatch(source, /shouldCompactTerminalHostTreeToolbar/);
});
