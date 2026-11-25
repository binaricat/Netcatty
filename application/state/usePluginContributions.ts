import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';
import {
  getSharedPluginRuntimeStatus,
  invalidateSharedPluginRuntimeStatus,
} from './pluginRuntimeStatusCache';

const EMPTY_SNAPSHOT: NetcattyPluginContributionSnapshot = Object.freeze({
  locale: 'en',
  plugins: Object.freeze([]),
});

export type PluginContributionContextSensitivity = (
  snapshot: NetcattyPluginContributionSnapshot,
) => boolean;

export function hasAnyPluginContributions(
  snapshot: NetcattyPluginContributionSnapshot,
): boolean {
  return snapshot.plugins.length > 0;
}

export function canReusePluginContributionSnapshot({
  settled,
  available,
  error,
  currentRevision,
  loadedRevision,
  currentLocale,
  loadedLocale,
  snapshot,
  isContextSensitive = hasAnyPluginContributions,
}: {
  settled: boolean;
  available: boolean;
  error: Error | null;
  currentRevision: number;
  loadedRevision: number;
  currentLocale: string | undefined;
  loadedLocale: string | undefined;
  snapshot: NetcattyPluginContributionSnapshot;
  isContextSensitive?: PluginContributionContextSensitivity;
}): boolean {
  if (!settled || error !== null || currentRevision !== loadedRevision) return false;
  if (!available) return true;
  if (currentLocale !== loadedLocale) return false;
  return !isContextSensitive(snapshot);
}

export function resolvePluginContributionLoadState({
  currentQueryKey,
  loadedQueryKey,
  snapshot,
  available,
  loading,
  reuseSnapshot = false,
}: {
  currentQueryKey: string;
  loadedQueryKey: string;
  snapshot: NetcattyPluginContributionSnapshot;
  available: boolean;
  loading: boolean;
  reuseSnapshot?: boolean;
}): Pick<UsePluginContributionsResult, 'available' | 'loading' | 'snapshot'> {
  if (currentQueryKey !== loadedQueryKey && !reuseSnapshot) {
    return { available, loading: true, snapshot: EMPTY_SNAPSHOT };
  }
  return { available, loading, snapshot };
}

export function failClosedPluginContributionLoad(cause: unknown): {
  available: false;
  snapshot: NetcattyPluginContributionSnapshot;
  error: Error;
} {
  return {
    available: false,
    snapshot: EMPTY_SNAPSHOT,
    error: cause instanceof Error ? cause : new Error(String(cause)),
  };
}

export function comparePluginMenus(
  left: NetcattyPluginContributionSnapshot['plugins'][number]['menus'][number],
  right: NetcattyPluginContributionSnapshot['plugins'][number]['menus'][number],
): number {
  return (left.group ?? '').localeCompare(right.group ?? '')
    || (left.order ?? 0) - (right.order ?? 0)
    || left.id.localeCompare(right.id);
}

export function collectOwnedPluginMenus(
  plugins: NetcattyPluginContributionSnapshot['plugins'],
) {
  return plugins.flatMap((plugin) => {
    const commandById = new Map(plugin.commands.map((command) => [command.id, command] as const));
    return plugin.menus.map((menu) => ({
      ...menu,
      pluginId: plugin.id,
      icon: menu.icon ?? commandById.get(menu.command)?.icon,
    }));
  });
}

export function createPluginContributionRefreshGuard() {
  let generation = 0;
  return Object.freeze({
    begin() {
      const requestGeneration = ++generation;
      return () => generation === requestGeneration;
    },
    invalidate() {
      generation += 1;
    },
  });
}

export interface UsePluginContributionsResult {
  available: boolean;
  loading: boolean;
  error: Error | null;
  snapshot: NetcattyPluginContributionSnapshot;
  refresh(): Promise<void>;
  executeCommand(command: string, args?: unknown, context?: Record<string, unknown>): Promise<unknown>;
  updateSetting(pluginId: string, settingId: string, value: unknown, scopeId?: string): Promise<{ restartRequired: boolean }>;
  resetSetting(pluginId: string, settingId: string, scopeId?: string): Promise<{ restartRequired: boolean }>;
  selectSettingPath(kind: 'file' | 'directory', title: string, defaultPath?: string): Promise<string | null>;
  setEnvironment(environment: NetcattyPluginEnvironment): Promise<void>;
  onViewClosed(callback: (event: NetcattyPluginViewClosedEvent) => void): () => void;
}

export interface UsePluginContributionsOptions {
  enabled?: boolean;
  isContextSensitive?: PluginContributionContextSensitivity;
}

export function usePluginContributions(
  query: NetcattyPluginContributionQuery = {},
  options: UsePluginContributionsOptions = {},
): UsePluginContributionsResult {
  const enabled = options.enabled !== false;
  const isContextSensitive = options.isContextSensitive ?? hasAnyPluginContributions;
  const bridge = typeof window === 'undefined' ? undefined : netcattyBridge.get();
  const queryLocale = query.locale;
  const queryKey = useMemo(() => JSON.stringify(query), [query]);
  const [revision, setRevision] = useState(0);
  const [loadedSnapshot, setLoadedSnapshot] = useState(() => ({
    queryKey,
    locale: queryLocale,
    revision: -1,
    settled: false,
    snapshot: EMPTY_SNAPSHOT,
  }));
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const refreshGuard = useRef(createPluginContributionRefreshGuard());

  const refresh = useCallback(async () => {
    const isCurrent = refreshGuard.current.begin();
    if (!enabled || !bridge?.getPluginRuntimeStatus || !bridge.getPluginContributions) {
      if (!isCurrent()) return;
      setAvailable(false);
      setLoadedSnapshot({
        queryKey,
        locale: queryLocale,
        revision,
        settled: true,
        snapshot: EMPTY_SNAPSHOT,
      });
      setError(null);
      setLoading(false);
      return;
    }
    try {
      const status = await getSharedPluginRuntimeStatus(bridge);
      if (!isCurrent()) return;
      setAvailable(status.available);
      if (!status.available) {
        setLoadedSnapshot({
          queryKey,
          locale: queryLocale,
          revision,
          settled: true,
          snapshot: EMPTY_SNAPSHOT,
        });
        setError(null);
        return;
      }
      const nextSnapshot = await bridge.getPluginContributions(JSON.parse(queryKey));
      if (!isCurrent()) return;
      setLoadedSnapshot({
        queryKey,
        locale: queryLocale,
        revision,
        settled: true,
        snapshot: nextSnapshot,
      });
      setError(null);
    } catch (cause) {
      if (!isCurrent()) return;
      const failure = failClosedPluginContributionLoad(cause);
      setAvailable(failure.available);
      setLoadedSnapshot({
        queryKey,
        locale: queryLocale,
        revision,
        settled: false,
        snapshot: failure.snapshot,
      });
      setError(failure.error);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [bridge, enabled, queryKey, queryLocale, revision]);

  useEffect(() => {
    if (!enabled) return;
    const unsubscribe = bridge?.onPluginContributionsChanged?.(() => {
      invalidateSharedPluginRuntimeStatus(bridge);
      setRevision((current) => current + 1);
    });
    return () => {
      unsubscribe?.();
      setRevision((current) => current + 1);
    };
  }, [bridge, enabled]);

  const isCurrentSnapshotReusable = canReusePluginContributionSnapshot({
    settled: loadedSnapshot.settled,
    available,
    error,
    currentRevision: revision,
    loadedRevision: loadedSnapshot.revision,
    currentLocale: queryLocale,
    loadedLocale: loadedSnapshot.locale,
    snapshot: loadedSnapshot.snapshot,
    isContextSensitive,
  });
  const hasAttemptedCurrentQuery =
    loadedSnapshot.queryKey === queryKey && loadedSnapshot.revision === revision;
  const shouldSkipQueryRefresh = isCurrentSnapshotReusable || hasAttemptedCurrentQuery;

  useEffect(() => {
    const guard = refreshGuard.current;
    if (!enabled) return () => guard.invalidate();
    if (shouldSkipQueryRefresh) return;
    void refresh();
    return () => {
      guard.invalidate();
    };
  }, [enabled, refresh, shouldSkipQueryRefresh]);

  const executeCommand = useCallback(async (command: string, args?: unknown, context?: Record<string, unknown>) => {
    if (!bridge?.executePluginCommand) throw new Error('Plugin commands are unavailable');
    return bridge.executePluginCommand(command, args, context);
  }, [bridge]);

  const updateSetting = useCallback(async (
    pluginId: string,
    settingId: string,
    value: unknown,
    scopeId?: string,
  ) => {
    if (!bridge?.updatePluginSetting) throw new Error('Plugin settings are unavailable');
    const result = await bridge.updatePluginSetting(pluginId, settingId, value, scopeId);
    await refresh();
    return result;
  }, [bridge, refresh]);

  const resetSetting = useCallback(async (pluginId: string, settingId: string, scopeId?: string) => {
    if (!bridge?.resetPluginSetting) throw new Error('Plugin settings are unavailable');
    const result = await bridge.resetPluginSetting(pluginId, settingId, scopeId);
    await refresh();
    return result;
  }, [bridge, refresh]);

  const selectSettingPath = useCallback(async (kind: 'file' | 'directory', title: string, defaultPath?: string) => {
    const picker = kind === 'file' ? bridge?.selectFile : bridge?.selectDirectory;
    if (!picker) throw new Error('Plugin path selection is unavailable');
    return picker(title, defaultPath);
  }, [bridge]);

  const setEnvironment = useCallback(async (environment: NetcattyPluginEnvironment) => {
    if (!bridge?.setPluginEnvironment) return;
    await bridge.setPluginEnvironment(environment);
  }, [bridge]);

  const onViewClosed = useCallback((callback: (event: NetcattyPluginViewClosedEvent) => void) => (
    bridge?.onPluginViewClosed?.(callback) ?? (() => {})
  ), [bridge]);
  const currentLoadState = resolvePluginContributionLoadState({
    currentQueryKey: queryKey,
    loadedQueryKey: loadedSnapshot.queryKey,
    snapshot: loadedSnapshot.snapshot,
    available,
    loading,
    reuseSnapshot: isCurrentSnapshotReusable,
  });

  return {
    available: currentLoadState.available,
    loading: currentLoadState.loading,
    error,
    snapshot: currentLoadState.snapshot,
    refresh,
    executeCommand,
    updateSetting,
    resetSetting,
    selectSettingPath,
    setEnvironment,
    onViewClosed,
  };
}
