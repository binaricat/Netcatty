import assert from 'node:assert/strict';
import test from 'node:test';

import {
  areVaultNavConfigsEqual,
  canHideVaultNavItem,
  createDefaultVaultNavConfig,
  DEFAULT_BUILTIN_VAULT_NAV_ORDER,
  getManageableVaultNavIds,
  getVisibleVaultNavIds,
  isCustomVaultNavConfig,
  isLockedVaultNavId,
  moveVaultNavItem,
  normalizeVaultNavConfig,
  reconcileVaultNavConfig,
  reorderVaultNavItems,
  resetVaultNavConfig,
  resolveFallbackVaultSection,
  setVaultNavItemVisibility,
  toggleVaultNavItemVisibility,
  type PluginVaultNavId,
} from './vaultNavConfig';

const DB_PLUGIN: PluginVaultNavId = 'plugin-vault:com.binaricat.netcatty-database.main';
const MONITOR_PLUGIN: PluginVaultNavId = 'plugin-vault:com.binaricat.netcatty-monitor.main';

test('createDefaultVaultNavConfig includes all built-in items without built-in monitor and appends deduplicated plugins', () => {
  const config = createDefaultVaultNavConfig([DB_PLUGIN, MONITOR_PLUGIN, DB_PLUGIN]);
  assert.deepEqual(config.order, [...DEFAULT_BUILTIN_VAULT_NAV_ORDER, DB_PLUGIN, MONITOR_PLUGIN]);
  assert.deepEqual(config.hidden, []);
  assert.equal((config.order as string[]).includes('monitor'), false);
});

test('normalizeVaultNavConfig handles null, corrupted, duplicate, legacy monitor, and invalid entries', () => {
  assert.deepEqual(normalizeVaultNavConfig(null), createDefaultVaultNavConfig());
  assert.deepEqual(normalizeVaultNavConfig('corrupt'), createDefaultVaultNavConfig());
  assert.deepEqual(normalizeVaultNavConfig(['hosts']), createDefaultVaultNavConfig());

  const normalized = normalizeVaultNavConfig(
    {
      order: ['logs', 'monitor', 'hosts', 'hosts', 'plugin-vault:', 'unknown', DB_PLUGIN, 'keys'],
      hidden: ['hosts', 'logs', 'logs', 'monitor', 'unknown'],
    },
    [DB_PLUGIN, MONITOR_PLUGIN],
  );

  assert.deepEqual(normalized.order, [
    'logs',
    'hosts',
    DB_PLUGIN,
    'keys',
    'proxies',
    'port',
    'snippets',
    'notes',
    'knownhosts',
    MONITOR_PLUGIN,
  ]);
  // 'hosts' is locked and must never be hidden.
  assert.deepEqual(normalized.hidden, ['logs']);
});

test('cold start keeps saved plugin preferences while loading, and prunes uninstalled plugins once loaded', () => {
  const stored = {
    order: ['hosts', MONITOR_PLUGIN, DB_PLUGIN, 'keys', 'proxies', 'port', 'snippets', 'notes', 'knownhosts', 'logs'],
    hidden: [DB_PLUGIN, 'logs'],
  };

  // While plugins are still loading (activePluginIds = [], pruneMissingPlugins = false):
  const duringLoad = normalizeVaultNavConfig(stored, [], { pruneMissingPlugins: false });
  assert.ok(duringLoad.order.includes(MONITOR_PLUGIN));
  assert.ok(duringLoad.order.includes(DB_PLUGIN));
  assert.ok(duringLoad.hidden.includes(DB_PLUGIN));
  // Visible items only render currently active entries (no ghost plugin rows).
  assert.equal(getVisibleVaultNavIds(duringLoad, []).includes(MONITOR_PLUGIN), false);
  assert.equal(getVisibleVaultNavIds(duringLoad, []).includes(DB_PLUGIN), false);

  // After load completes and DB_PLUGIN was uninstalled, only MONITOR_PLUGIN remains active:
  const afterLoad = reconcileVaultNavConfig(duringLoad, [MONITOR_PLUGIN], { pruneMissingPlugins: true });
  assert.equal(afterLoad.order.includes(DB_PLUGIN), false);
  assert.equal(afterLoad.hidden.includes(DB_PLUGIN), false);
  assert.equal(afterLoad.order[1], MONITOR_PLUGIN, 'remaining plugin keeps its custom slot');
  assert.deepEqual(afterLoad.hidden, ['logs'], 'other hidden preferences remain intact');
});

test('newly installed plugin appears automatically even when a custom order is saved', () => {
  const saved = normalizeVaultNavConfig(
    {
      order: ['hosts', 'notes', 'keys', 'proxies', 'port', 'snippets', 'knownhosts', 'logs'],
      hidden: ['logs'],
    },
    [],
  );

  const reconciled = reconcileVaultNavConfig(saved, [MONITOR_PLUGIN]);
  assert.deepEqual(reconciled.order, [
    'hosts',
    'notes',
    'keys',
    'proxies',
    'port',
    'snippets',
    'knownhosts',
    'logs',
    MONITOR_PLUGIN,
  ]);
  assert.equal(reconciled.hidden.includes(MONITOR_PLUGIN), false);
  assert.ok(getVisibleVaultNavIds(reconciled, [MONITOR_PLUGIN]).includes(MONITOR_PLUGIN));
});

test('reorderVaultNavItems moves built-in and plugin items before or after targets without losing hidden state', () => {
  const base = setVaultNavItemVisibility(
    createDefaultVaultNavConfig([DB_PLUGIN, MONITOR_PLUGIN]),
    'knownhosts',
    false,
    [DB_PLUGIN, MONITOR_PLUGIN],
  );

  const movedMonitorUp = reorderVaultNavItems(base, MONITOR_PLUGIN, 'keys', 'before');
  assert.equal(movedMonitorUp.order.indexOf(MONITOR_PLUGIN), 1);
  assert.equal(movedMonitorUp.order.indexOf('keys'), 2);
  assert.deepEqual(movedMonitorUp.hidden, ['knownhosts']);

  const movedHostsAfter = reorderVaultNavItems(movedMonitorUp, 'hosts', 'proxies', 'after');
  assert.equal(movedHostsAfter.order.indexOf('hosts'), movedHostsAfter.order.indexOf('proxies') + 1);

  // No-op cases return same reference.
  assert.equal(reorderVaultNavItems(movedHostsAfter, 'keys', 'keys', 'before'), movedHostsAfter);
  assert.equal(
    reorderVaultNavItems(movedHostsAfter, 'plugin-vault:missing', 'keys', 'before'),
    movedHostsAfter,
  );
});

test('moveVaultNavItem swaps across active scope neighbors and ignores boundary moves', () => {
  const base = createDefaultVaultNavConfig([DB_PLUGIN]);
  const hiddenKeys = setVaultNavItemVisibility(base, 'keys', false, [DB_PLUGIN]);
  const visibleScope = getVisibleVaultNavIds(hiddenKeys, [DB_PLUGIN]);

  // Moving 'proxies' up within visible scope should jump over hidden 'keys' and swap with 'hosts'.
  const movedUp = moveVaultNavItem(hiddenKeys, 'proxies', 'up', visibleScope);
  assert.equal(movedUp.order[0], 'proxies');
  assert.equal(movedUp.order[1], 'keys');
  assert.equal(movedUp.order[2], 'hosts');

  // Boundary no-ops
  assert.equal(moveVaultNavItem(movedUp, 'proxies', 'up', getVisibleVaultNavIds(movedUp, [DB_PLUGIN])), movedUp);
  assert.equal(moveVaultNavItem(movedUp, DB_PLUGIN, 'down', getVisibleVaultNavIds(movedUp, [DB_PLUGIN])), movedUp);
});

test('visibility guardrails lock hosts and allow toggling non-locked built-in and plugin items', () => {
  const base = createDefaultVaultNavConfig([DB_PLUGIN]);
  assert.equal(isLockedVaultNavId('hosts'), true);
  assert.equal(canHideVaultNavItem(base, 'hosts', [DB_PLUGIN]), false);
  assert.equal(canHideVaultNavItem(base, 'logs', [DB_PLUGIN]), true);
  assert.equal(canHideVaultNavItem(base, DB_PLUGIN, [DB_PLUGIN]), true);

  // Attempting to hide 'hosts' is a no-op.
  assert.equal(setVaultNavItemVisibility(base, 'hosts', false, [DB_PLUGIN]), base);

  // Hiding and unhiding preserves order position.
  const hidden = toggleVaultNavItemVisibility(base, 'snippets', [DB_PLUGIN]);
  assert.deepEqual(hidden.hidden, ['snippets']);
  assert.equal(getVisibleVaultNavIds(hidden, [DB_PLUGIN]).includes('snippets'), false);
  assert.equal(getManageableVaultNavIds(hidden, [DB_PLUGIN]).includes('snippets'), true);

  const restored = toggleVaultNavItemVisibility(hidden, 'snippets', [DB_PLUGIN]);
  assert.deepEqual(restored.hidden, []);
  assert.deepEqual(restored.order, base.order);
});

test('isCustomVaultNavConfig, resetVaultNavConfig, areVaultNavConfigsEqual, and resolveFallbackVaultSection work accurately', () => {
  const defaults = createDefaultVaultNavConfig([DB_PLUGIN]);
  assert.equal(isCustomVaultNavConfig(defaults, [DB_PLUGIN]), false);

  const reordered = reorderVaultNavItems(defaults, DB_PLUGIN, 'hosts', 'after');
  assert.equal(isCustomVaultNavConfig(reordered, [DB_PLUGIN]), true);
  assert.equal(areVaultNavConfigsEqual(defaults, reordered), false);

  const reset = resetVaultNavConfig([DB_PLUGIN]);
  assert.equal(isCustomVaultNavConfig(reset, [DB_PLUGIN]), false);
  assert.equal(areVaultNavConfigsEqual(defaults, reset), true);

  const hiddenNotes = setVaultNavItemVisibility(defaults, 'notes', false, [DB_PLUGIN]);
  const visible = getVisibleVaultNavIds(hiddenNotes, [DB_PLUGIN]);
  assert.equal(resolveFallbackVaultSection('notes', visible), 'hosts');
  assert.equal(resolveFallbackVaultSection('keys', visible), 'keys');
  assert.equal(resolveFallbackVaultSection('plugin-vault:gone', visible), 'hosts');

  // If user reordered keys first, fallback picks the first visible section.
  const keysFirst = reorderVaultNavItems(hiddenNotes, 'keys', 'hosts', 'before');
  assert.equal(resolveFallbackVaultSection('notes', getVisibleVaultNavIds(keysFirst, [DB_PLUGIN])), 'keys');
});
