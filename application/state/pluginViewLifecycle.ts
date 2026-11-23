export interface PluginViewSnapshotSelection<T> {
  requestViewId: string;
  contextKey: string;
  value: T;
}

export interface PluginViewTabCatalogEntry {
  pluginId: string;
  pluginName: string;
  viewId: string;
  title: string;
  icon?: NetcattyPluginIconReference;
}

export interface PluginViewTabCatalogStore {
  retain(viewIds: ReadonlySet<string>): void;
  refreshMetadata(entries: readonly PluginViewTabCatalogEntry[]): void;
}

export function resolvePluginViewSnapshotSelection<T>({
  resolved,
  previous,
  loading,
  requestedViewId,
  contextKey,
}: {
  resolved: T | null;
  previous: PluginViewSnapshotSelection<T> | null;
  loading: boolean;
  requestedViewId: string | undefined;
  contextKey: string;
}): T | null {
  if (resolved) return resolved;
  if (!loading || !previous || previous.requestViewId !== requestedViewId
    || previous.contextKey !== contextKey) return null;
  return previous.value;
}

export function shouldReconcilePluginViewTabCatalog({
  loading,
}: {
  loading: boolean;
}): boolean {
  return !loading;
}

export function collectPluginViewTabCatalog(
  plugins: NetcattyPluginContributionSnapshot['plugins'],
): PluginViewTabCatalogEntry[] {
  return plugins.flatMap((plugin) => plugin.views
    .filter((view) => view.location === 'tab')
    .map((view) => ({
      pluginId: plugin.id,
      pluginName: plugin.displayName,
      viewId: view.id,
      title: view.title,
      icon: view.icon,
    })));
}

export function reconcilePluginViewTabCatalog({
  loading,
  plugins,
  store,
}: {
  loading: boolean;
  plugins: NetcattyPluginContributionSnapshot['plugins'];
  store: PluginViewTabCatalogStore;
}): boolean {
  if (!shouldReconcilePluginViewTabCatalog({ loading })) return false;
  const entries = collectPluginViewTabCatalog(plugins);
  store.retain(new Set(entries.map((entry) => entry.viewId)));
  store.refreshMetadata(entries);
  return true;
}
