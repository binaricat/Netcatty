import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { netcattyBridge } from '../../infrastructure/services/netcattyBridge';

const EMPTY_SNAPSHOT: NetcattyPluginContributionSnapshot = Object.freeze({
  locale: 'en',
  plugins: Object.freeze([]),
});

export function resolvePluginContributionLoadState({
  currentQueryKey,
  loadedQueryKey,
  snapshot,
  available,
  loading,
}: {
  currentQueryKey: string;
  loadedQueryKey: string;
  snapshot: NetcattyPluginContributionSnapshot;
  available: boolean;
  loading: boolean;
}): Pick<UsePluginContributionsResult, 'available' | 'loading' | 'snapshot'> {
  if (currentQueryKey !== loadedQueryKey) {
    return { available: false, loading: true, snapshot: EMPTY_SNAPSHOT };
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
  openView(payload: NetcattyPluginViewOpenRequest): Promise<{ instanceId: string }>;
  closeView(instanceId: string): Promise<void>;
  setViewBounds(instanceId: string, bounds: { x: number; y: number; width: number; height: number }): Promise<void>;
  setViewVisibility(instanceId: string, visible: boolean): Promise<void>;
  setEnvironment(environment: NetcattyPluginEnvironment): Promise<void>;
  onViewClosed(callback: (event: NetcattyPluginViewClosedEvent) => void): () => void;
}

export function usePluginContributions(
  query: NetcattyPluginContributionQuery = {},
): UsePluginContributionsResult {
  const bridge = typeof window === 'undefined' ? undefined : netcattyBridge.get();
  const queryKey = useMemo(() => JSON.stringify(query), [query]);
  const [loadedSnapshot, setLoadedSnapshot] = useState(() => ({
    queryKey,
    snapshot: EMPTY_SNAPSHOT,
  }));
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const refreshGuard = useRef(createPluginContributionRefreshGuard());

  const refresh = useCallback(async () => {
    const isCurrent = refreshGuard.current.begin();
    if (!bridge?.getPluginRuntimeStatus || !bridge.getPluginContributions) {
      if (!isCurrent()) return;
      setAvailable(false);
      setLoadedSnapshot({ queryKey, snapshot: EMPTY_SNAPSHOT });
      setLoading(false);
      return;
    }
    try {
      const status = await bridge.getPluginRuntimeStatus();
      if (!isCurrent()) return;
      setAvailable(status.available);
      if (!status.available) {
        setLoadedSnapshot({ queryKey, snapshot: EMPTY_SNAPSHOT });
        setError(null);
        return;
      }
      const nextSnapshot = await bridge.getPluginContributions(JSON.parse(queryKey));
      if (!isCurrent()) return;
      setLoadedSnapshot({ queryKey, snapshot: nextSnapshot });
      setError(null);
    } catch (cause) {
      if (!isCurrent()) return;
      const failure = failClosedPluginContributionLoad(cause);
      setAvailable(failure.available);
      setLoadedSnapshot({ queryKey, snapshot: failure.snapshot });
      setError(failure.error);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [bridge, queryKey]);

  useEffect(() => {
    const guard = refreshGuard.current;
    void refresh();
    const unsubscribe = bridge?.onPluginContributionsChanged?.(() => { void refresh(); });
    return () => {
      guard.invalidate();
      unsubscribe?.();
    };
  }, [bridge, refresh]);

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

  const openView = useCallback(async (payload: NetcattyPluginViewOpenRequest) => {
    if (!bridge?.openPluginView) throw new Error('Plugin views are unavailable');
    return bridge.openPluginView(payload);
  }, [bridge]);

  const closeView = useCallback(async (instanceId: string) => {
    if (!bridge?.closePluginView) return;
    await bridge.closePluginView(instanceId);
  }, [bridge]);

  const setViewBounds = useCallback(async (
    instanceId: string,
    bounds: { x: number; y: number; width: number; height: number },
  ) => {
    if (!bridge?.setPluginViewBounds) return;
    await bridge.setPluginViewBounds(instanceId, bounds);
  }, [bridge]);

  const setViewVisibility = useCallback(async (instanceId: string, visible: boolean) => {
    if (!bridge?.setPluginViewVisibility) return;
    await bridge.setPluginViewVisibility(instanceId, visible);
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
    openView,
    closeView,
    setViewBounds,
    setViewVisibility,
    setEnvironment,
    onViewClosed,
  };
}
