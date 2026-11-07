import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

// All visible rows share one IPC subscription. No catalog fetch or polling here.
const generations = new Map<string, number>();
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | undefined;
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) unsubscribe = netcattyBridge.get()?.onPluginCatalogChanged?.(({ sourceId }) => {
    generations.set(sourceId, (generations.get(sourceId) ?? 0) + 1);
    for (const notify of listeners) notify();
  });
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { unsubscribe?.(); unsubscribe = undefined; generations.clear(); }
  };
}

export function usePluginAuthorIdentity({ entry, plugin, sourceId = 'official' }: {
  entry?: NetcattyPluginCatalogEntry; plugin?: NetcattyInstalledPlugin; sourceId?: string;
}) {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [loaded, setLoaded] = useState<{ key: string; value: NetcattyPluginAuthorPresentation } | null>(null);
  const pluginId = plugin?.id;
  const entryId = entry?.id;
  const selectionToken = entry?.selectionToken;
  const request = useMemo<NetcattyPluginAuthorRequest | null>(() => pluginId
    ? { kind: 'installed', pluginId }
    : entryId && selectionToken ? { kind: 'catalog', pluginId: entryId, selectionToken, sourceId } : null,
  [pluginId, entryId, selectionToken, sourceId]);
  const identitySource = plugin?.source?.id ?? sourceId;
  const generation = useSyncExternalStore(subscribe, () => generations.get(identitySource) ?? 0, () => 0);
  const key = JSON.stringify([request, plugin?.activeVersion, plugin?.archiveSha256, plugin?.source?.id, plugin?.runtime?.quarantinedAt, generation]);
  const installed = Boolean(plugin);
  const version = plugin?.activeVersion;
  const archiveSha256 = plugin?.archiveSha256 ?? null;
  const installedSourceId = plugin?.source?.id ?? 'local';
  useEffect(() => {
    if (!element || !request) return;
    let active = true;
    let started = false;
    const load = () => {
      if (started) return;
      started = true;
      void netcattyBridge.get()?.getPluginAuthorPresentation?.(request).then((value) => {
        if (!active || !value) return;
        if (installed && (value.version !== version || value.archiveSha256 !== archiveSha256 || value.sourceId !== installedSourceId)) return;
        setLoaded({ key, value });
      }).catch(() => { /* The visible author placeholder remains usable offline. */ });
    };
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { load(); observer?.disconnect(); }
    }, { rootMargin: '64px' });
    if (observer) observer.observe(element); else load();
    return () => { active = false; observer?.disconnect(); };
  }, [element, request, key, installed, version, archiveSha256, installedSourceId]);
  return { ref: setElement, identity: loaded?.key === key ? loaded.value : null };
}
