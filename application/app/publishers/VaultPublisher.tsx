import { useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';

import {
  AppVaultRuntimeContext,
  registerAppVaultRuntime,
  type AppVaultContextValue,
} from '../../state/appRuntimeBridge';
import {
  publishVaultSnapshot,
  registerVaultSnapshotActions,
} from '../../state/vaultSnapshotStore';
import { useVaultState } from '../../state/useVaultState';
import { getEffectiveKnownHosts } from '../../../infrastructure/syncHelpers';

export type VaultPublisherProps = {
  children?: ReactNode;
};

function vaultContextValuesEqual(
  prev: AppVaultContextValue,
  next: AppVaultContextValue,
): boolean {
  const keys = Object.keys(next) as Array<keyof AppVaultContextValue>;
  return keys.every((key) => prev[key] === next[key]);
}

/**
 * Owns `useVaultState` and publishes it three ways: the catalog into
 * `vaultSnapshotStore` for shell surfaces that subscribe to a slice, the
 * mutators into the same store's action slot, and a **catalog-only** runtime
 * onto `AppVaultRuntimeContext` for App.
 *
 * `notes` / `noteGroups` / `connectionLogs` / `shellHistory` are intentionally
 * absent from the context value: they churn on a different cadence and already
 * fan out through dedicated stores. Including them would force App (the
 * domain-bag builder) to re-render on every note edit or session log append.
 * Imperative callers that still need the full hook return use
 * `getAppVaultRuntime()`.
 */
export function VaultPublisher({ children }: VaultPublisherProps) {
  const vault = useVaultState();
  const {
    isInitialized,
    hosts,
    keys,
    identities,
    proxyProfiles,
    snippets,
    snippetPackages,
    customGroups,
    knownHosts,
    managedSources,
    groupConfigs,
    updateHosts,
    updateKeys,
    importOrReuseKey,
    updateIdentities,
    updateProxyProfiles,
    updateSnippets,
    updateSnippetPackages,
    updateCustomGroups,
    updateKnownHosts,
    updateManagedSources,
    updateGroupConfigs,
    convertKnownHostToHost,
    readPersistedHosts,
    readPersistedManagedSources,
    commitPluginImporterData,
    commitVaultImportTransaction,
    commitVaultGroupMutation,
    updateHostDistro,
    updateHostLastConnected,
    addShellHistoryEntry,
    removeShellHistoryEntry,
    clearAllCommandHistory,
  } = vault;

  useLayoutEffect(() => {
    registerAppVaultRuntime(vault);
  }, [vault]);

  // Only a real unmount clears the slot. A re-render re-registers through the
  // effect above, and StrictMode's simulated remount re-runs both.
  useLayoutEffect(() => () => {
    registerAppVaultRuntime(null);
  }, []);

  // useVaultState decrypts hosts/keys before it reads known hosts, so the state
  // is briefly empty at boot even when storage has entries. Publish the same
  // storage fallback App uses so a subscriber connecting during that window
  // does not re-prompt for a fingerprint it already trusts.
  const effectiveKnownHosts = useMemo(
    () => getEffectiveKnownHosts(knownHosts) ?? [],
    [knownHosts],
  );

  useLayoutEffect(() => {
    publishVaultSnapshot({
      isVaultInitialized: isInitialized,
      hosts,
      keys,
      identities,
      proxyProfiles,
      snippets,
      snippetPackages,
      customGroups,
      knownHosts: effectiveKnownHosts,
      managedSources,
      groupConfigs,
    });
  }, [
    customGroups,
    effectiveKnownHosts,
    groupConfigs,
    hosts,
    identities,
    isInitialized,
    keys,
    managedSources,
    proxyProfiles,
    snippetPackages,
    snippets,
  ]);

  useLayoutEffect(() => {
    registerVaultSnapshotActions({
      updateHosts,
      updateKeys,
      importOrReuseKey,
      updateIdentities,
      updateProxyProfiles,
      updateSnippets,
      updateSnippetPackages,
      updateCustomGroups,
      updateKnownHosts,
      updateManagedSources,
      updateGroupConfigs,
      convertKnownHostToHost,
      readPersistedHosts,
      readPersistedManagedSources,
      commitPluginImporterData,
      commitVaultImportTransaction,
      commitVaultGroupMutation,
      updateHostDistro,
      updateHostLastConnected,
      addShellHistoryEntry,
      removeShellHistoryEntry,
      clearAllCommandHistory,
    });
    return () => {
      registerVaultSnapshotActions(null);
    };
  }, [
    addShellHistoryEntry,
    clearAllCommandHistory,
    commitPluginImporterData,
    commitVaultImportTransaction,
    commitVaultGroupMutation,
    convertKnownHostToHost,
    importOrReuseKey,
    readPersistedHosts,
    readPersistedManagedSources,
    removeShellHistoryEntry,
    updateCustomGroups,
    updateGroupConfigs,
    updateHostDistro,
    updateHostLastConnected,
    updateHosts,
    updateIdentities,
    updateKeys,
    updateKnownHosts,
    updateManagedSources,
    updateProxyProfiles,
    updateSnippetPackages,
    updateSnippets,
  ]);

  // Strip high-churn fields, then retain the previous object identity when only
  // those fields (or exportData) changed so React context consumers stay quiet.
  const vaultForAppRef = useRef<AppVaultContextValue | null>(null);
  const vaultForApp = useMemo((): AppVaultContextValue => {
    const {
      notes: _notes,
      noteGroups: _noteGroups,
      connectionLogs: _connectionLogs,
      shellHistory: _shellHistory,
      exportData: _exportData,
      ...catalog
    } = vault;
    const prev = vaultForAppRef.current;
    if (prev && vaultContextValuesEqual(prev, catalog)) {
      return prev;
    }
    vaultForAppRef.current = catalog;
    return catalog;
  }, [vault]);

  return (
    <AppVaultRuntimeContext.Provider value={vaultForApp}>
      {children}
    </AppVaultRuntimeContext.Provider>
  );
}
