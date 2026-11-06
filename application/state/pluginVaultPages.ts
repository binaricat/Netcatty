export const PLUGIN_VAULT_PAGE_PREFIX = 'plugin-vault:';

export interface PluginVaultPage {
  key: `plugin-vault:${string}`;
  pluginId: string;
  pluginName: string;
  version: string;
  viewId: string;
  title: string;
  icon?: NetcattyPluginIconReference;
  order: number;
}

export function collectPluginVaultPages(plugins: NetcattyPluginContributionSnapshot['plugins']): PluginVaultPage[] {
  return plugins.flatMap((plugin) => plugin.views
    .filter((view) => view.location === 'vault-page' && view.visible)
    .map((view): PluginVaultPage => ({
      key: `${PLUGIN_VAULT_PAGE_PREFIX}${view.id}`,
      pluginId: plugin.id, pluginName: plugin.displayName, version: plugin.version,
      viewId: view.id, title: view.title, icon: view.icon, order: view.order ?? 0,
    })))
    .sort((left, right) => left.order - right.order || left.viewId.localeCompare(right.viewId));
}

export function resolvePluginVaultPage(pages: readonly PluginVaultPage[], section: string): PluginVaultPage | null {
  return pages.find((page) => page.key === section) ?? null;
}
