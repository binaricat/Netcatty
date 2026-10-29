import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeToolbarItemLayout,
  partitionToolbarItems,
  setToolbarItemPlacement,
} from '../../domain/toolbarItemLayout.ts';
import {
  SYSTEM_MANAGER_TAB_DEFAULT_ORDER,
  SYSTEM_MANAGER_TAB_LAYOUT_DEFAULTS,
} from './systemManagerTabLayout.ts';

test('system manager tab layout defaults include every known section', () => {
  assert.deepEqual(
    [...SYSTEM_MANAGER_TAB_DEFAULT_ORDER],
    ['overview', 'processes', 'ports', 'services', 'tmux', 'zellij', 'docker', 'gpu'],
  );
  assert.deepEqual(SYSTEM_MANAGER_TAB_LAYOUT_DEFAULTS.lockedIds, ['overview']);
});

test('system manager overview cannot be hidden', () => {
  const layout = normalizeToolbarItemLayout(null, SYSTEM_MANAGER_TAB_LAYOUT_DEFAULTS);
  const next = setToolbarItemPlacement(
    layout,
    'overview',
    'hide',
    SYSTEM_MANAGER_TAB_LAYOUT_DEFAULTS,
  );
  assert.equal(next.placement.overview, 'show');
});

test('system manager partition filters to available host tabs', () => {
  const layout = normalizeToolbarItemLayout(
    {
      order: [...SYSTEM_MANAGER_TAB_DEFAULT_ORDER],
      placement: {
        overview: 'show',
        processes: 'show',
        ports: 'collapse',
        services: 'hide',
        tmux: 'show',
        docker: 'show',
        gpu: 'show',
      },
    },
    SYSTEM_MANAGER_TAB_LAYOUT_DEFAULTS,
  );

  const part = partitionToolbarItems(layout, ['overview', 'processes', 'ports', 'services']);
  assert.deepEqual(part.shown, ['overview', 'processes']);
  assert.deepEqual(part.collapsed, ['ports']);
  assert.deepEqual(part.hidden, ['services']);
});
