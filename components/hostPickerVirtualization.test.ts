import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  buildItemIndexToVisualIndexMap,
  clampListIndex,
  getFixedSizeVirtualWindow,
  stepListIndex,
} from './ui/virtualListMath.ts';
import { getQuickSwitcherVisualRowHeight } from './QuickSwitcher.tsx';

const root = path.dirname(fileURLToPath(import.meta.url));

const read = (relativePath: string) =>
  readFileSync(path.join(root, relativePath), 'utf8');

test('SelectHostPanelContent virtualizes with listbox keyboard model', () => {
  const source = read('SelectHostPanelContent.tsx');
  assert.match(source, /VariableSizeVirtualList/);
  assert.match(source, /data-host-picker-virtual="select-host"/);
  assert.match(source, /role="listbox"/);
  assert.match(source, /handleListKeyDown/);
  assert.match(source, /stepListIndex/);
  // Screen readers need active option linkage while focus stays on the listbox.
  assert.match(source, /aria-activedescendant=\{activeDescendantId\}/);
  assert.match(source, /optionDomId/);
  // Navigable-index IDs avoid collisions when group paths sanitize identically.
  assert.match(source, /id=\{navIndex >= 0 \? optionDomId\(navIndex\) : undefined\}/);
  assert.match(source, /\$\{listboxId\}-opt-\$\{navIndex\}/);
  // Virtual rows must O(1)-lookup nav indices, not findIndex the full navigable list.
  assert.match(source, /navigableIndexByKey/);
  assert.match(source, /navigableIndexByKey\.get\(row\.key\)/);
  assert.doesNotMatch(source, /navigable\.findIndex/);
  // Selected hosts must still show the keyboard active ring.
  assert.match(source, /isSelected \? 'bg-muted' : isActive \? 'bg-primary\/10' : 'hover:bg-muted\/70'/);
  assert.match(source, /isActive && 'ring-1 ring-primary\/40'/);
  assert.doesNotMatch(
    source,
    /isSelected \? 'bg-muted' : isActive \? 'bg-primary\/10 ring-1 ring-primary\/40'/,
  );
  assert.doesNotMatch(source, /filteredHosts\.map\(\(host\) =>/);
  // One listbox tab stop — not per-host tabIndex under virtualization.
  assert.match(source, /role="listbox"[\s\S]*tabIndex=\{0\}/);
  assert.doesNotMatch(source, /data-host-id=\{host\.id\}[\s\S]{0,120}tabIndex=\{0\}/);
  // Path/filter changes must reset the cursor; length-only shrinks still clamp.
  assert.match(
    source,
    /setActiveNavIndex\(0\);\s*\}, \[currentPath, searchQuery, selectedTags, sortMode\]/,
  );
  assert.match(
    source,
    /setActiveNavIndex\(\(prev\) => clampListIndex\(prev, navigable\.length\)\);\s*\}, \[navigable\.length\]/,
  );
  // Multi-select listbox must advertise multi-selection to AT.
  assert.match(source, /aria-multiselectable=\{multiSelect \|\| undefined\}/);
});

test('QuickSwitcher virtualizes categorized rows and clamps empty-list keyboard', () => {
  const source = read('QuickSwitcher.tsx');
  assert.match(source, /VariableSizeVirtualList/);
  assert.match(source, /data-host-picker-virtual="quick-switcher"/);
  assert.match(source, /stepListIndex/);
  assert.match(source, /clampListIndex/);
  // Two-line plugin rows need a taller virtual slot than QS_ROW_HEIGHT.
  assert.match(source, /QS_PLUGIN_ROW_HEIGHT/);
  // Fixed-height slots must clip/truncate so long titles never overlap the next row.
  assert.match(source, /overflow-hidden/);
  assert.match(source, /max-w-\[12rem\] shrink-0 truncate/);
  // List scroller needs a definite max height under max-h-only popup chrome.
  assert.match(source, /max-h-\[min\(360px,calc\(100vh-14rem\)\)\]/);
  assert.doesNotMatch(source, /results\.map\(\(host\) =>/);
  // Must not use bare length-1 which yields -1 on empty lists.
  assert.doesNotMatch(
    source,
    /setSelectedIndex\(\(prev\) => Math\.min\(prev \+ 1, flatItems\.length - 1\)\)/,
  );
});

test('AddToWorkspaceDialog virtualizes and clamps selection on shrink', () => {
  const source = read('workspace/AddToWorkspaceDialog.tsx');
  assert.match(source, /VariableSizeVirtualList/);
  assert.match(source, /data-host-picker-virtual="add-workspace"/);
  assert.match(source, /clampListIndex\(prev, items\.length\)/);
  assert.match(source, /onClick=\{\(\) => handleTargetClick\(idx, LOCAL_ITEM_ID\)\}/);
  assert.match(source, /onClick=\{\(\) => handleTargetClick\(idx, host\.id\)\}/);
  // Long group paths must not wrap out of the fixed virtual row.
  assert.match(source, /max-w-\[12rem\] truncate text-\[11px\] text-muted-foreground/);
  assert.match(source, /max-h-\[min\(360px,calc\(100vh-14rem\)\)\]/);
  assert.doesNotMatch(source, /filteredHosts\.map\(\(host, i\) =>/);
});

test('CreateWorkspaceDialog virtualizes selectable hosts', () => {
  const source = read('CreateWorkspaceDialog.tsx');
  assert.match(source, /FixedSizeVirtualList/);
  assert.match(source, /data-host-picker-virtual="create-workspace"/);
  assert.doesNotMatch(source, /filteredHosts\.map\(host =>/);
});

test('FixedSizeVirtualList uses shared window math (render path clamp)', () => {
  const source = read('ui/FixedSizeVirtualList.tsx');
  assert.match(source, /getFixedSizeVirtualWindow/);
  assert.match(source, /effectiveScrollTop/);
});

test('shipped virtual window math proves large lists only render a viewport slice', () => {
  const window = getFixedSizeVirtualWindow({
    itemCount: 8_000,
    itemHeight: 52,
    scrollTop: 12_000,
    viewportHeight: 300,
    overscan: 8,
  });
  const rendered = window.endIndex - window.startIndex;
  assert.ok(rendered > 0);
  assert.ok(rendered < 80);
  assert.ok(window.startIndex > 0);
  assert.ok(window.endIndex < 8_000);
});

test('shipped keyboard helpers block empty-list ArrowDown crash path', () => {
  // Reproduce the review finding: empty list + ArrowDown must not yield -1.
  let index = 0;
  index = stepListIndex(index, 0, 1);
  assert.equal(index, 0);
  index = clampListIndex(index, 0);
  assert.equal(index, 0);
  // List repopulates with 5 items — index stays valid for Enter.
  index = clampListIndex(index, 5);
  assert.equal(index, 0);
});

test('shipped visual index map matches picker header/item interleaving', () => {
  // Mirrors QuickSwitcher / SFTP / AddToWorkspace visual row shape.
  const visual = [
    { kind: 'header' },
    { kind: 'item' },
    { kind: 'item' },
    { kind: 'header' },
    { kind: 'item' },
  ];
  const map = buildItemIndexToVisualIndexMap(visual);
  assert.deepEqual([...map.entries()], [[0, 1], [1, 2], [2, 4]]);
});

test('QuickSwitcher plugin rows use a taller virtual slot than single-line hosts', () => {
  assert.equal(
    getQuickSwitcherVisualRowHeight({ kind: 'header', key: 'h', label: 'Hosts' }),
    32,
  );
  assert.equal(
    getQuickSwitcherVisualRowHeight({
      kind: 'item',
      key: 'host:1',
      itemIndex: 0,
      item: { type: 'host', id: '1' },
    }),
    44,
  );
  // Two-line plugin chrome must not share the 44px host slot (overflow/overlap).
  assert.equal(
    getQuickSwitcherVisualRowHeight({
      kind: 'item',
      key: 'plugin:1',
      itemIndex: 1,
      item: {
        type: 'plugin-command',
        id: 'p1',
        commandId: 'cmd',
        title: 'Run',
        pluginTitle: 'Plugin',
      },
    }),
    56,
  );
  assert.equal(
    getQuickSwitcherVisualRowHeight({
      kind: 'item',
      key: 'view:1',
      itemIndex: 2,
      item: { type: 'plugin-view', id: 'v1', title: 'View', pluginTitle: 'Plugin' },
    }),
    56,
  );
  assert.ok(
    getQuickSwitcherVisualRowHeight({
      kind: 'item',
      key: 'plugin:1',
      itemIndex: 1,
      item: {
        type: 'plugin-command',
        id: 'p1',
        commandId: 'cmd',
        title: 'Run',
        pluginTitle: 'Plugin',
      },
    }) > getQuickSwitcherVisualRowHeight({
      kind: 'item',
      key: 'host:1',
      itemIndex: 0,
      item: { type: 'host', id: '1' },
    }),
  );
});
