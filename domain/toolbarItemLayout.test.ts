import test from 'node:test';
import assert from 'node:assert/strict';

import {
  moveToolbarItem,
  normalizeToolbarItemLayout,
  partitionToolbarItems,
  reorderToolbarItems,
  resetToolbarItemLayout,
  setToolbarItemPlacement,
  type ToolbarItemLayoutDefaults,
} from './toolbarItemLayout.ts';

const defaults: ToolbarItemLayoutDefaults = {
  order: ['a', 'b', 'c', 'd'],
  placement: {
    a: 'show',
    b: 'show',
    c: 'collapse',
    d: 'hide',
  },
  lockedIds: ['a'],
};

test('normalize restores defaults for null/invalid values', () => {
  assert.deepEqual(normalizeToolbarItemLayout(null, defaults), {
    order: ['a', 'b', 'c', 'd'],
    placement: { a: 'show', b: 'show', c: 'collapse', d: 'hide' },
  });
  assert.deepEqual(normalizeToolbarItemLayout('nope', defaults), resetToolbarItemLayout(defaults));
});

test('normalize accepts legacy order-only arrays', () => {
  const layout = normalizeToolbarItemLayout(['d', 'a', 'b', 'c'], defaults);
  assert.deepEqual(layout.order, ['d', 'a', 'b', 'c']);
  assert.equal(layout.placement.a, 'show');
  assert.equal(layout.placement.c, 'collapse');
  assert.equal(layout.placement.d, 'hide');
});

test('normalize appends new default ids and drops unknown ones', () => {
  const layout = normalizeToolbarItemLayout(
    { order: ['c', 'ghost', 'a'], placement: { c: 'show', a: 'collapse' } },
    defaults,
  );
  assert.deepEqual(layout.order, ['c', 'a', 'b', 'd']);
  assert.equal(layout.placement.a, 'collapse');
  assert.equal(layout.placement.b, 'show');
});

test('locked ids cannot be hidden', () => {
  const layout = normalizeToolbarItemLayout(
    { order: ['a', 'b', 'c', 'd'], placement: { a: 'hide', b: 'show', c: 'show', d: 'show' } },
    defaults,
  );
  assert.equal(layout.placement.a, 'show');

  const next = setToolbarItemPlacement(layout, 'a', 'hide', defaults);
  assert.equal(next.placement.a, 'show');
});

test('partition filters by availability and placement', () => {
  const layout = normalizeToolbarItemLayout(null, defaults);
  assert.deepEqual(partitionToolbarItems(layout), {
    shown: ['a', 'b'],
    collapsed: ['c'],
    hidden: ['d'],
  });
  assert.deepEqual(partitionToolbarItems(layout, ['a', 'c', 'd']), {
    shown: ['a'],
    collapsed: ['c'],
    hidden: ['d'],
  });
});

test('set placement forces at least one reachable item', () => {
  const layout = normalizeToolbarItemLayout(
    {
      order: ['a', 'b'],
      placement: { a: 'show', b: 'hide' },
    },
    { order: ['a', 'b'], requireReachable: true },
  );
  const next = setToolbarItemPlacement(layout, 'a', 'hide', {
    order: ['a', 'b'],
    requireReachable: true,
  });
  // a was the only reachable; hide is refused via ensureReachable restoring a
  assert.equal(next.placement.a, 'show');
});

test('requireReachable ignores unavailable filler ids', () => {
  const layout = normalizeToolbarItemLayout(
    {
      order: ['a', 'b', 'serialOnly'],
      placement: { a: 'hide', b: 'hide', serialOnly: 'show' },
    },
    {
      order: ['a', 'b', 'serialOnly'],
      requireReachable: true,
    },
  );
  // serialOnly is still "show" but not available for this session — must restore a/b.
  const next = setToolbarItemPlacement(
    layout,
    'a',
    'hide',
    { order: ['a', 'b', 'serialOnly'], requireReachable: true },
    ['a', 'b'],
  );
  assert.equal(next.placement.a === 'show' || next.placement.b === 'show', true);
});

test('move skips unavailable neighbors when availableIds is provided', () => {
  const layout = normalizeToolbarItemLayout(
    {
      order: ['a', 'serialOnly', 'b'],
      placement: { a: 'show', serialOnly: 'show', b: 'show' },
    },
    { order: ['a', 'serialOnly', 'b'] },
  );
  const moved = moveToolbarItem(layout, 'a', 'later', ['a', 'b']);
  assert.deepEqual(moved.order, ['b', 'serialOnly', 'a']);
});

test('reorder and move preserve placement map', () => {
  const layout = normalizeToolbarItemLayout(null, defaults);
  const reordered = reorderToolbarItems(layout, 'c', 'a', 'before');
  assert.deepEqual(reordered.order, ['c', 'a', 'b', 'd']);
  assert.equal(reordered.placement.c, 'collapse');

  const moved = moveToolbarItem(layout, 'b', 'later');
  assert.deepEqual(moved.order, ['a', 'c', 'b', 'd']);
});
