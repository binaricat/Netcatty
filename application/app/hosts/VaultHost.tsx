import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react';

import { getEffectiveKnownHosts } from '../../../infrastructure/syncHelpers';
import {
  useVaultSnapshot,
  useVaultSnapshotActions,
} from '../../state/vaultSnapshotStore';
import { getAppHandlers, subscribeAppHandlers } from '../appHandlersBridge';
import { publishAppShellDomainSlice } from '../appShellPropsStore';
import { useAppLocalUiStore } from '../appLocalUiStore';
import { APP_MOUNTS_DOMAIN } from './mountsDomain';

/**
 * Vault island: catalog from `vaultSnapshotStore`, glue handlers from the
 * app handlers bridge, local vault UI from `appLocalUiStore`. Assembles the
 * full vault domain bag field-by-field — never spreads a prepared bag from
 * AppSideEffects.
 */
export function VaultHost() {
  const vault = useVaultSnapshot();
  const actions = useVaultSnapshotActions();
  const local = useAppLocalUiStore();
  const handlers = useSyncExternalStore(
    subscribeAppHandlers,
    getAppHandlers,
    getAppHandlers,
  );

  const effectiveKnownHosts = useMemo(
    () => getEffectiveKnownHosts(vault.knownHosts as never) ?? [],
    [vault.knownHosts],
  );

  const vaultDomain = useMemo(() => {
    if (!handlers) return null;
    return {
      addShellHistoryEntry: actions?.addShellHistoryEntry,
      removeShellHistoryEntry: actions?.removeShellHistoryEntry,
      clearAllCommandHistory: actions?.clearAllCommandHistory,
      commitPluginImporterData: actions?.commitPluginImporterData,
      commitVaultImportTransaction: actions?.commitVaultImportTransaction,
      commitVaultGroupMutation: actions?.commitVaultGroupMutation,
      convertKnownHostToHost: actions?.convertKnownHostToHost,
      customGroups: vault.customGroups,
      deepLinkHostDraft: local.deepLinkHostDraft,
      effectiveKnownHosts,
      groupConfigs: vault.groupConfigs,
      handleAddKnownHost: handlers.handleAddKnownHost,
      handleDeleteHost: handlers.handleDeleteHost,
      handleOpenHostFromVaultNote: handlers.handleOpenHostFromVaultNote,
      handleOpenVaultHostFromChat: handlers.handleOpenVaultHostFromChat,
      handleOpenVaultNoteFromChat: handlers.handleOpenVaultNoteFromChat,
      handleOpenVaultSectionFromChat: handlers.handleOpenVaultSectionFromChat,
      handleOpenVaultSnippetFromChat: handlers.handleOpenVaultSnippetFromChat,
      hosts: vault.hosts,
      identities: vault.identities,
      importOrReuseKey: actions?.importOrReuseKey,
      keys: vault.keys,
      managedSources: vault.managedSources,
      navigateToSection: local.navigateToSection,
      proxyProfiles: vault.proxyProfiles,
      readPersistedHosts: actions?.readPersistedHosts,
      readPersistedManagedSources: actions?.readPersistedManagedSources,
      setDeepLinkHostDraft: handlers.setDeepLinkHostDraft,
      setNavigateToSection: handlers.setNavigateToSection,
      setVaultFocusRequest: handlers.setVaultFocusRequest,
      snippetPackages: vault.snippetPackages,
      snippets: vault.snippets,
      unmanageSource: handlers.unmanageSource,
      updateCustomGroups: actions?.updateCustomGroups,
      updateGroupConfigs: actions?.updateGroupConfigs,
      updateHosts: actions?.updateHosts,
      updateIdentities: actions?.updateIdentities,
      updateKeys: actions?.updateKeys,
      updateKnownHosts: actions?.updateKnownHosts,
      updateManagedSources: actions?.updateManagedSources,
      updateProxyProfiles: actions?.updateProxyProfiles,
      updateSnippetPackages: actions?.updateSnippetPackages,
      updateSnippets: actions?.updateSnippets,
      vaultFocusRequest: local.vaultFocusRequest,
    };
  }, [
    actions,
    effectiveKnownHosts,
    handlers,
    local.deepLinkHostDraft,
    local.navigateToSection,
    local.vaultFocusRequest,
    vault.customGroups,
    vault.groupConfigs,
    vault.hosts,
    vault.identities,
    vault.keys,
    vault.managedSources,
    vault.proxyProfiles,
    vault.snippetPackages,
    vault.snippets,
  ]);

  useLayoutEffect(() => {
    if (vaultDomain) publishAppShellDomainSlice('vault', vaultDomain);
    publishAppShellDomainSlice('mounts', APP_MOUNTS_DOMAIN);
  }, [vaultDomain]);

  return null;
}
