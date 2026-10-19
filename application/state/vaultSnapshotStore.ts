import { useSyncExternalStore } from 'react';

import type {
  GroupConfig,
  Host,
  Identity,
  KnownHost,
  ManagedSource,
  ProxyProfile,
  Snippet,
  SSHKey,
} from '../../domain/models';
import type { useVaultState } from './useVaultState';

type VaultState = ReturnType<typeof useVaultState>;

type Listener = () => void;

/**
 * The vault catalog every shell surface reads. Notes, note groups, connection
 * logs and shell history are deliberately absent: they have their own stores
 * (`notesStore`, `connectionLogsStore`, `shellHistoryStore`) because they churn
 * on a different cadence than the vault catalog.
 */
export type VaultSnapshot = {
  isVaultInitialized: boolean;
  hosts: readonly Host[];
  keys: readonly SSHKey[];
  identities: readonly Identity[];
  proxyProfiles: readonly ProxyProfile[];
  snippets: readonly Snippet[];
  snippetPackages: readonly string[];
  customGroups: readonly string[];
  knownHosts: readonly KnownHost[];
  managedSources: readonly ManagedSource[];
  groupConfigs: readonly GroupConfig[];
};

/**
 * Vault mutators the shell needs. Derived from the hook return so the store
 * contract cannot drift from `useVaultState`.
 */
export type VaultSnapshotActions = Pick<
  VaultState,
  | 'updateHosts'
  | 'updateKeys'
  | 'importOrReuseKey'
  | 'updateIdentities'
  | 'updateProxyProfiles'
  | 'updateSnippets'
  | 'updateSnippetPackages'
  | 'updateCustomGroups'
  | 'updateKnownHosts'
  | 'updateManagedSources'
  | 'updateGroupConfigs'
  | 'convertKnownHostToHost'
  | 'readPersistedHosts'
  | 'readPersistedManagedSources'
  | 'commitPluginImporterData'
  | 'commitVaultImportTransaction'
  | 'commitVaultGroupMutation'
  | 'updateHostDistro'
  | 'updateHostLastConnected'
  | 'addShellHistoryEntry'
  | 'removeShellHistoryEntry'
  | 'clearAllCommandHistory'
>;

const EMPTY_HOSTS: readonly Host[] = Object.freeze([]);
const EMPTY_KEYS: readonly SSHKey[] = Object.freeze([]);
const EMPTY_IDENTITIES: readonly Identity[] = Object.freeze([]);
const EMPTY_PROXY_PROFILES: readonly ProxyProfile[] = Object.freeze([]);
const EMPTY_SNIPPETS: readonly Snippet[] = Object.freeze([]);
const EMPTY_STRINGS: readonly string[] = Object.freeze([]);
const EMPTY_KNOWN_HOSTS: readonly KnownHost[] = Object.freeze([]);
const EMPTY_MANAGED_SOURCES: readonly ManagedSource[] = Object.freeze([]);
const EMPTY_GROUP_CONFIGS: readonly GroupConfig[] = Object.freeze([]);

export const EMPTY_VAULT_SNAPSHOT: VaultSnapshot = Object.freeze({
  isVaultInitialized: false,
  hosts: EMPTY_HOSTS,
  keys: EMPTY_KEYS,
  identities: EMPTY_IDENTITIES,
  proxyProfiles: EMPTY_PROXY_PROFILES,
  snippets: EMPTY_SNIPPETS,
  snippetPackages: EMPTY_STRINGS,
  customGroups: EMPTY_STRINGS,
  knownHosts: EMPTY_KNOWN_HOSTS,
  managedSources: EMPTY_MANAGED_SOURCES,
  groupConfigs: EMPTY_GROUP_CONFIGS,
});

const SNAPSHOT_KEYS = Object.keys(EMPTY_VAULT_SNAPSHOT) as (keyof VaultSnapshot)[];

export function vaultSnapshotsEqual(prev: VaultSnapshot, next: VaultSnapshot): boolean {
  return SNAPSHOT_KEYS.every((key) => prev[key] === next[key]);
}

/**
 * External store for the vault catalog so hosts, vault surfaces and the
 * terminal layer can subscribe to exactly the slice they render instead of
 * receiving it through the App domain bags. Values and actions live in
 * separate slots (same shape as `notesStore`) so an unstable setter identity
 * cannot invalidate the value snapshot.
 */
class VaultSnapshotStore {
  private snapshot: VaultSnapshot = EMPTY_VAULT_SNAPSHOT;
  private actions: VaultSnapshotActions | null = null;
  private listeners = new Set<Listener>();
  private actionListeners = new Set<Listener>();

  getSnapshot = (): VaultSnapshot => this.snapshot;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setSnapshot(next: VaultSnapshot): void {
    if (vaultSnapshotsEqual(this.snapshot, next)) return;
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener();
    }
  }

  getActions = (): VaultSnapshotActions | null => this.actions;

  subscribeActions = (listener: Listener): (() => void) => {
    this.actionListeners.add(listener);
    return () => {
      this.actionListeners.delete(listener);
    };
  };

  setActions(next: VaultSnapshotActions | null): void {
    if (this.actions === next) return;
    this.actions = next;
    for (const listener of this.actionListeners) {
      listener();
    }
  }
}

export const vaultSnapshotStore = new VaultSnapshotStore();

export function publishVaultSnapshot(snapshot: VaultSnapshot): void {
  vaultSnapshotStore.setSnapshot(snapshot);
}

export function getVaultSnapshot(): VaultSnapshot {
  return vaultSnapshotStore.getSnapshot();
}

export function subscribeVaultSnapshot(listener: Listener): () => void {
  return vaultSnapshotStore.subscribe(listener);
}

export function registerVaultSnapshotActions(actions: VaultSnapshotActions | null): void {
  vaultSnapshotStore.setActions(actions);
}

export function getVaultSnapshotActions(): VaultSnapshotActions | null {
  return vaultSnapshotStore.getActions();
}

export function subscribeVaultSnapshotActions(listener: Listener): () => void {
  return vaultSnapshotStore.subscribeActions(listener);
}

/** Subscribe to the whole vault catalog. Prefer a narrower selector hook. */
export function useVaultSnapshot(): VaultSnapshot {
  return useSyncExternalStore(subscribeVaultSnapshot, getVaultSnapshot, getVaultSnapshot);
}

/**
 * Subscribe to a single vault field. Consumers that only render hosts must not
 * re-render when unrelated vault slices settle.
 */
export function useVaultSnapshotField<K extends keyof VaultSnapshot>(
  field: K,
): VaultSnapshot[K] {
  const read = () => getVaultSnapshot()[field];
  return useSyncExternalStore(subscribeVaultSnapshot, read, read);
}

export function useVaultSnapshotActions(): VaultSnapshotActions | null {
  return useSyncExternalStore(
    subscribeVaultSnapshotActions,
    getVaultSnapshotActions,
    getVaultSnapshotActions,
  );
}
