import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcilePluginViewTabCatalog, resolvePluginViewSnapshotSelection, shouldReconcilePluginViewTabCatalog } from './pluginViewLifecycle';
import { PluginViewTabStore } from './pluginViewTabStore';

test('locale-only snapshot refresh keeps the owned view alive without weakening context fail-closed behavior', () => {
  const previous = {
    requestViewId: 'publisher.plugin.view',
    contextKey: '{"netcatty.surface":"view"}',
    value: { id: 'resolved-view' },
  };
  assert.equal(resolvePluginViewSnapshotSelection({
    resolved: null,
    previous,
    loading: true,
    requestedViewId: previous.requestViewId,
    contextKey: previous.contextKey,
  }), previous.value);
  assert.equal(resolvePluginViewSnapshotSelection({
    resolved: null,
    previous,
    loading: true,
    requestedViewId: previous.requestViewId,
    contextKey: '{"netcatty.surface":"terminal/toolbar"}',
  }), null);
  assert.equal(resolvePluginViewSnapshotSelection({
    resolved: null,
    previous,
    loading: false,
    requestedViewId: previous.requestViewId,
    contextKey: previous.contextKey,
  }), null);
});

test('native tab catalog reconciliation pauses for every in-flight query', () => {
  assert.equal(shouldReconcilePluginViewTabCatalog({
    loading: true,
  }), false);
  assert.equal(shouldReconcilePluginViewTabCatalog({
    loading: false,
  }), true);
});

test('active-tab context refresh cannot withdraw the plugin tab that triggered it', () => {
  let activeTabId = 'vault';
  const store = new PluginViewTabStore({
    getActiveTabId: () => activeTabId,
    setActiveTabId: (next) => { activeTabId = next; },
  });
  const tab = store.open({
    pluginId: 'publisher.plugin',
    pluginName: 'Plugin',
    viewId: 'publisher.plugin.view',
    title: 'View',
  });

  assert.equal(reconcilePluginViewTabCatalog({
    loading: true,
    plugins: [],
    store,
  }), false);
  assert.deepEqual(store.getTabs().map((candidate) => candidate.id), [tab.id]);
  assert.equal(activeTabId, tab.id);

  const plugins = [{
    id: 'publisher.plugin',
    displayName: 'Plugin',
    views: [{
      id: 'publisher.plugin.view',
      title: 'Localized View',
      location: 'tab',
    }],
  }] as unknown as NetcattyPluginContributionSnapshot['plugins'];
  assert.equal(reconcilePluginViewTabCatalog({
    loading: false,
    plugins,
    store,
  }), true);
  assert.deepEqual(store.getTabs().map((candidate) => candidate.id), [tab.id]);
  assert.equal(store.getTabs()[0]?.title, 'Localized View');
  assert.equal(activeTabId, tab.id);
});
