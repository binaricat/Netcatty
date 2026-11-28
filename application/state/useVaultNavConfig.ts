import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  areVaultNavConfigsEqual,
  canHideVaultNavItem,
  getManageableVaultNavIds,
  getVisibleVaultNavIds,
  isCustomVaultNavConfig,
  moveVaultNavItem,
  normalizeVaultNavConfig,
  reconcileVaultNavConfig,
  reorderVaultNavItems,
  resetVaultNavConfig,
  setVaultNavItemVisibility,
  toggleVaultNavItemVisibility,
  type PluginVaultNavId,
  type VaultNavConfig,
  type VaultNavDropPosition,
  type VaultNavItemId,
} from '../../domain/vaultNavConfig';
import { STORAGE_KEY_VAULT_NAV_CONFIG } from '../../infrastructure/config/storageKeys';
import {
  LOCAL_STORAGE_ADAPTER_CHANGED_EVENT,
  localStorageAdapter,
} from '../../infrastructure/persistence/localStorageAdapter';

export interface UseVaultNavConfigOptions {
  activePluginIds: readonly PluginVaultNavId[];
  /** Pass true while plugin contributions are still loading on cold start. */
  pluginsLoading?: boolean;
}

export interface UseVaultNavConfigResult {
  config: VaultNavConfig;
  visibleIds: VaultNavItemId[];
  manageableIds: VaultNavItemId[];
  hiddenSet: ReadonlySet<VaultNavItemId>;
  isCustomized: boolean;
  isHidden: (id: VaultNavItemId) => boolean;
  canHide: (id: VaultNavItemId) => boolean;
  setVisible: (id: VaultNavItemId, visible: boolean) => VaultNavConfig;
  toggleVisible: (id: VaultNavItemId) => VaultNavConfig;
  reorder: (
    draggedId: VaultNavItemId,
    targetId: VaultNavItemId,
    position?: VaultNavDropPosition,
  ) => VaultNavConfig;
  move: (
    id: VaultNavItemId,
    direction: 'up' | 'down',
    scopeIds?: readonly VaultNavItemId[],
  ) => VaultNavConfig;
  reset: () => VaultNavConfig;
}

function readStoredVaultNavConfig(
  activePluginIds: readonly PluginVaultNavId[],
  pruneMissingPlugins: boolean,
): VaultNavConfig {
  try {
    const raw = localStorageAdapter.read(STORAGE_KEY_VAULT_NAV_CONFIG);
    return normalizeVaultNavConfig(raw, activePluginIds, { pruneMissingPlugins });
  } catch {
    return resetVaultNavConfig(activePluginIds);
  }
}

function writeStoredVaultNavConfig(config: VaultNavConfig): void {
  try {
    localStorageAdapter.write(STORAGE_KEY_VAULT_NAV_CONFIG, config);
  } catch {
    // Best effort; in-memory state still applies for the current session.
  }
}

export function useVaultNavConfig({
  activePluginIds,
  pluginsLoading = false,
}: UseVaultNavConfigOptions): UseVaultNavConfigResult {
  const pluginKey = activePluginIds.join('\0');
  const stablePluginIds = useMemo<PluginVaultNavId[]>(
    () => (pluginKey ? (pluginKey.split('\0') as PluginVaultNavId[]) : []),
    [pluginKey],
  );
  const pruneMissingPlugins = !pluginsLoading;

  const [config, setConfig] = useState<VaultNavConfig>(() =>
    readStoredVaultNavConfig(stablePluginIds, pruneMissingPlugins),
  );
  const configRef = useRef<VaultNavConfig>(config);
  configRef.current = config;

  // Reconcile when active plugin list changes or cold-start loading finishes.
  // Kept strictly outside React state updaters so storage writes and sync events
  // never execute re-entrantly during rendering or StrictMode double-invocations.
  useEffect(() => {
    const current = configRef.current;
    const reconciled = reconcileVaultNavConfig(current, stablePluginIds, {
      pruneMissingPlugins,
    });
    if (!areVaultNavConfigsEqual(current, reconciled)) {
      configRef.current = reconciled;
      setConfig(reconciled);
    }
    if (pruneMissingPlugins) {
      try {
        const rawStored = localStorageAdapter.read(STORAGE_KEY_VAULT_NAV_CONFIG);
        if (rawStored != null) {
          const normalizedStored = normalizeVaultNavConfig(rawStored, stablePluginIds, {
            pruneMissingPlugins: false,
          });
          if (!areVaultNavConfigsEqual(normalizedStored, reconciled)) {
            writeStoredVaultNavConfig(reconciled);
          }
        }
      } catch {
        // Ignore storage read errors.
      }
    }
  }, [pruneMissingPlugins, stablePluginIds]);

  // Cross-window and adapter sync.
  useEffect(() => {
    const sync = (event: Event) => {
      if (event instanceof StorageEvent && event.key !== STORAGE_KEY_VAULT_NAV_CONFIG) {
        return;
      }
      if (
        event instanceof CustomEvent
        && event.detail?.key !== STORAGE_KEY_VAULT_NAV_CONFIG
      ) {
        return;
      }
      const next = readStoredVaultNavConfig(stablePluginIds, pruneMissingPlugins);
      if (!areVaultNavConfigsEqual(configRef.current, next)) {
        configRef.current = next;
        setConfig(next);
      }
    };
    window.addEventListener('storage', sync);
    window.addEventListener(LOCAL_STORAGE_ADAPTER_CHANGED_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(LOCAL_STORAGE_ADAPTER_CHANGED_EVENT, sync);
    };
  }, [pruneMissingPlugins, stablePluginIds]);

  const commit = useCallback((next: VaultNavConfig): VaultNavConfig => {
    if (areVaultNavConfigsEqual(configRef.current, next)) {
      return configRef.current;
    }
    configRef.current = next;
    setConfig(next);
    writeStoredVaultNavConfig(next);
    return next;
  }, []);

  const setVisible = useCallback(
    (id: VaultNavItemId, visible: boolean): VaultNavConfig =>
      commit(setVaultNavItemVisibility(configRef.current, id, visible, stablePluginIds)),
    [commit, stablePluginIds],
  );

  const toggleVisible = useCallback(
    (id: VaultNavItemId): VaultNavConfig =>
      commit(toggleVaultNavItemVisibility(configRef.current, id, stablePluginIds)),
    [commit, stablePluginIds],
  );

  const reorder = useCallback(
    (
      draggedId: VaultNavItemId,
      targetId: VaultNavItemId,
      position: VaultNavDropPosition = 'before',
    ): VaultNavConfig =>
      commit(reorderVaultNavItems(configRef.current, draggedId, targetId, position)),
    [commit],
  );

  const move = useCallback(
    (
      id: VaultNavItemId,
      direction: 'up' | 'down',
      scopeIds?: readonly VaultNavItemId[],
    ): VaultNavConfig =>
      commit(moveVaultNavItem(configRef.current, id, direction, scopeIds)),
    [commit],
  );

  const reset = useCallback((): VaultNavConfig => {
    const next = resetVaultNavConfig(stablePluginIds);
    configRef.current = next;
    setConfig(next);
    writeStoredVaultNavConfig(next);
    return next;
  }, [stablePluginIds]);

  const visibleIds = useMemo(
    () => getVisibleVaultNavIds(config, stablePluginIds),
    [config, stablePluginIds],
  );
  const manageableIds = useMemo(
    () => getManageableVaultNavIds(config, stablePluginIds),
    [config, stablePluginIds],
  );
  const hiddenSet = useMemo(
    () => new Set<VaultNavItemId>(config.hidden),
    [config.hidden],
  );
  const isCustomized = useMemo(
    () => isCustomVaultNavConfig(config, stablePluginIds),
    [config, stablePluginIds],
  );

  const isHidden = useCallback(
    (id: VaultNavItemId) => hiddenSet.has(id),
    [hiddenSet],
  );
  const canHide = useCallback(
    (id: VaultNavItemId) => canHideVaultNavItem(config, id, stablePluginIds),
    [config, stablePluginIds],
  );

  return useMemo(
    () => ({
      config,
      visibleIds,
      manageableIds,
      hiddenSet,
      isCustomized,
      isHidden,
      canHide,
      setVisible,
      toggleVisible,
      reorder,
      move,
      reset,
    }),
    [
      canHide,
      config,
      hiddenSet,
      isCustomized,
      isHidden,
      manageableIds,
      move,
      reorder,
      reset,
      setVisible,
      toggleVisible,
      visibleIds,
    ],
  );
}
