import { gt, valid } from 'semver';

export interface PluginUpdateCandidate {
  pluginId: string;
  sourceId: string;
  installedVersion: string;
  availableVersion: string;
}
export interface PluginUpdateCheckResult {
  checkedAt: number;
  checked: number;
  updates: PluginUpdateCandidate[];
  skipped: number;
  failedSources: number;
}

type UpdateBridge = Pick<NetcattyBridge, 'listPlugins' | 'listPluginSources' | 'listPluginCatalog'>;
const sameSource = (left?: NetcattyPluginSource, right?: NetcattyPluginSource) => Boolean(left && right
  && left.id === right.id && left.kind === right.kind && left.origin === right.origin);
const sameInstallation = (left: NetcattyInstalledPlugin, right?: NetcattyInstalledPlugin) => Boolean(right
  && left.activeVersion === right.activeVersion && left.archiveSha256 === right.archiveSha256
  && sameSource(left.source, right.source));

/** Read-only: host catalogs own fetching, source consent, bounds and cache status. */
export async function checkPluginUpdates(bridge: UpdateBridge): Promise<PluginUpdateCheckResult> {
  if (!bridge.listPlugins || !bridge.listPluginSources || !bridge.listPluginCatalog) throw new Error('Plugin update checks are unavailable');
  const installed = await bridge.listPlugins();
  const sources = await bridge.listPluginSources();
  const groups = new Map<string, NetcattyInstalledPlugin[]>();
  for (const plugin of installed) {
    const source = sources.find((item) => sameSource(plugin.source, item));
    // Local/unknown/removed/disabled bindings never fall back to another market.
    if (!plugin.activeVersion || !valid(plugin.activeVersion) || !source || source.kind === 'local' || source.enabled === false) continue;
    groups.set(source.id, [...(groups.get(source.id) ?? []), plugin]);
  }
  const checked = new Set<string>();
  const candidates: PluginUpdateCandidate[] = [];
  let failedSources = 0;
  // At most one catalog read at a time; the host supports at most 32 custom sources.
  for (const [sourceId, plugins] of groups) {
    try {
      const catalog = await bridge.listPluginCatalog(sourceId);
      if (catalog.error || catalog.source !== 'registry') { failedSources++; continue; }
      for (const plugin of plugins) {
        const entry = catalog.entries.find((item) => item.id === plugin.id && item.artifact);
        if (!entry || !valid(entry.version)) continue;
        checked.add(plugin.id);
        if (gt(entry.version, plugin.activeVersion!)) candidates.push({
          pluginId: plugin.id, sourceId, installedVersion: plugin.activeVersion!, availableVersion: entry.version,
        });
      }
    } catch { failedSources++; }
  }
  // Revalidate host-owned source/package binding after every asynchronous read.
  // This publishes metadata only; installation stays in the existing manager flow.
  const current = await bridge.listPlugins();
  const currentSources = await bridge.listPluginSources();
  for (const plugin of installed) {
    const source = currentSources.find((item) => item.id === plugin.source?.id);
    if (!sameInstallation(plugin, current.find((item) => item.id === plugin.id)) || !sameSource(plugin.source, source) || source?.enabled === false) checked.delete(plugin.id);
  }
  const updates = candidates.filter((candidate) => checked.has(candidate.pluginId));
  return { checkedAt: Date.now(), checked: checked.size, updates, skipped: current.length - checked.size, failedSources };
}
