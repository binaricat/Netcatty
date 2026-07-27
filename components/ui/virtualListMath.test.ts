import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildItemIndexToVisualIndexMap,
  clampListIndex,
  clampScrollTop,
  getFixedSizeVirtualWindow,
  stepListIndex,
} from './virtualListMath.ts';

test('clampScrollTop keeps the window on-content after a deep scroll + filter shrink', () => {
  // User was deep in a long list (scrollTop large), then filter leaves few rows.
  assert.equal(clampScrollTop(50_000, 10 * 44, 360), Math.max(0, 10 * 44 - 360));
  assert.equal(clampScrollTop(-10, 1000, 200), 0);
  assert.equal(clampScrollTop(100, 1000, 200), 100);
  assert.equal(clampScrollTop(0, 0, 200), 0);
});

test('getFixedSizeVirtualWindow never starts past the last item after shrink', () => {
  const deep = getFixedSizeVirtualWindow({
    itemCount: 10_000,
    itemHeight: 44,
    scrollTop: 40_000,
    viewportHeight: 300,
    overscan: 6,
  });
  assert.ok(deep.startIndex < 10_000);
  assert.ok(deep.endIndex - deep.startIndex < 100);
  assert.ok(deep.endIndex <= 10_000);

  const shrunk = getFixedSizeVirtualWindow({
    itemCount: 8,
    itemHeight: 44,
    scrollTop: 40_000,
    viewportHeight: 300,
    overscan: 6,
  });
  assert.equal(shrunk.effectiveScrollTop, Math.max(0, 8 * 44 - 300));
  assert.ok(shrunk.startIndex >= 0);
  assert.ok(shrunk.startIndex < 8);
  assert.equal(shrunk.endIndex, 8);
  // Window must include at least one real item so the list never blanks.
  assert.ok(shrunk.endIndex > shrunk.startIndex);
});

test('getFixedSizeVirtualWindow only materializes a viewport-sized slice for large lists', () => {
  const window = getFixedSizeVirtualWindow({
    itemCount: 8_000,
    itemHeight: 44,
    scrollTop: 0,
    viewportHeight: 360,
    overscan: 8,
  });
  const rendered = window.endIndex - window.startIndex;
  assert.ok(rendered > 0);
  assert.ok(rendered < 100, `expected viewport window, got ${rendered}`);
  assert.equal(window.startIndex, 0);
});

test('clampListIndex and stepListIndex never produce -1 on empty or non-empty lists', () => {
  assert.equal(clampListIndex(-1, 0), 0);
  assert.equal(clampListIndex(5, 0), 0);
  assert.equal(clampListIndex(-1, 5), 0);
  assert.equal(clampListIndex(99, 5), 4);
  assert.equal(clampListIndex(2, 5), 2);

  assert.equal(stepListIndex(0, 0, 1), 0);
  assert.equal(stepListIndex(0, 0, -1), 0);
  // Empty list + ArrowDown must not go to -1 (QuickSwitcher regression).
  assert.equal(stepListIndex(0, 0, 1), 0);
  assert.equal(stepListIndex(0, 3, 1), 1);
  assert.equal(stepListIndex(2, 3, 1), 2);
  assert.equal(stepListIndex(0, 3, -1), 0);
});

test('buildItemIndexToVisualIndexMap skips headers for keyboard scroll targets', () => {
  const visual = [
    { kind: 'header' },
    { kind: 'item' },
    { kind: 'item' },
    { kind: 'header' },
    { kind: 'item' },
  ];
  const map = buildItemIndexToVisualIndexMap(visual);
  assert.equal(map.get(0), 1);
  assert.equal(map.get(1), 2);
  assert.equal(map.get(2), 4);
  assert.equal(map.size, 3);
  // Keyboard index 1 scrolls to visual row 2 (second host, after first header).
  assert.notEqual(map.get(1), 1);
});
