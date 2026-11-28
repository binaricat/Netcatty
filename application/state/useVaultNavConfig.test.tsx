import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const DB_PLUGIN = 'plugin-vault:com.binaricat.netcatty-database.main' as const;
const MONITOR_PLUGIN = 'plugin-vault:com.binaricat.netcatty-monitor.main' as const;

test('useVaultNavConfig persists order & visibility, survives cold-start loading, prunes uninstalled plugins, and resets cleanly', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['window', 'document', 'navigator', 'localStorage', 'StorageEvent', 'CustomEvent', 'Event']) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: key === 'window' ? dom.window : dom.window[key as keyof typeof dom.window],
    });
  }
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    writable: true,
    value: true,
  });

  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { useVaultNavConfig } = await import('./useVaultNavConfig');
  const { STORAGE_KEY_VAULT_NAV_CONFIG } = await import('../../infrastructure/config/storageKeys');

  let model!: ReturnType<typeof useVaultNavConfig>;
  let activePluginIds: (typeof DB_PLUGIN | typeof MONITOR_PLUGIN)[] = [DB_PLUGIN, MONITOR_PLUGIN];
  let pluginsLoading = false;

  function Fixture() {
    model = useVaultNavConfig({ activePluginIds, pluginsLoading });
    return <div />;
  }

  const root = createRoot(document.getElementById('root')!);
  const render = async () => {
    await act(async () => {
      root.render(
        <React.StrictMode>
          <Fixture />
        </React.StrictMode>,
      );
    });
  };

  try {
    await render();
    assert.equal(model.isCustomized, false);
    assert.ok(model.visibleIds.includes(DB_PLUGIN));
    assert.ok(model.visibleIds.includes(MONITOR_PLUGIN));

    // Back-to-back mutations in the same act batch under StrictMode return fresh
    // synchronous configs and preserve both mutations without updater side effects.
    let afterReorder!: ReturnType<typeof model.reorder>;
    let afterHide!: ReturnType<typeof model.setVisible>;
    await act(async () => {
      afterReorder = model.reorder(MONITOR_PLUGIN, 'hosts', 'after');
      afterHide = model.setVisible('logs', false);
    });
    assert.equal(afterReorder.order[1], MONITOR_PLUGIN);
    assert.equal(afterHide.order[1], MONITOR_PLUGIN);
    assert.deepEqual(afterHide.hidden, ['logs']);

    assert.equal(model.visibleIds[1], MONITOR_PLUGIN);
    assert.equal(model.isHidden('logs'), true);
    assert.equal(model.visibleIds.includes('logs'), false);
    assert.equal(model.isCustomized, true);

    // Locked 'hosts' cannot be hidden.
    await act(async () => {
      model.setVisible('hosts', false);
    });
    assert.equal(model.isHidden('hosts'), false);

    // Simulate cold start: unmount, remount with pluginsLoading = true & activePluginIds = [].
    await act(async () => {
      root.unmount();
    });
    const coldRoot = createRoot(document.getElementById('root')!);
    activePluginIds = [];
    pluginsLoading = true;
    await act(async () => {
      coldRoot.render(<Fixture />);
    });
    // Plugin preferences stay preserved in config while loading, but don't show in visibleIds yet.
    assert.equal(model.visibleIds.includes(MONITOR_PLUGIN), false);
    assert.ok(model.config.order.includes(MONITOR_PLUGIN));

    // Plugins finish loading, but DB_PLUGIN was uninstalled.
    activePluginIds = [MONITOR_PLUGIN];
    pluginsLoading = false;
    await act(async () => {
      coldRoot.render(<Fixture />);
    });
    assert.equal(model.visibleIds[1], MONITOR_PLUGIN, 'custom slot of remaining plugin survives cold start');
    assert.equal(model.config.order.includes(DB_PLUGIN), false, 'uninstalled plugin is pruned cleanly');
    const persisted = JSON.parse(dom.window.localStorage.getItem(STORAGE_KEY_VAULT_NAV_CONFIG) ?? '{}');
    assert.equal(persisted.order.includes(DB_PLUGIN), false, 'pruned plugin is also removed from storage');
    assert.deepEqual(persisted.hidden, ['logs']);

    // Reset restores defaults.
    await act(async () => {
      model.reset();
    });
    assert.equal(model.isCustomized, false);
    assert.equal(model.isHidden('logs'), false);
    assert.equal(model.visibleIds.at(-1), MONITOR_PLUGIN);

    await act(async () => {
      coldRoot.unmount();
    });
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    dom.window.close();
  }
});
