import { useSyncExternalStore } from 'react';

import type { Host } from '../../types';

export interface VaultHostTreeActions {
  onDeleteHost: (host: Host) => void;
  onDuplicateHost: (host: Host) => void;
  onCopyCredentials: (host: Host) => void;
  onRenameHost: (host: Host) => void;
  onNewGroup: (parentPath?: string) => void;
  onRenameGroup: (groupPath: string) => void;
  onDeleteGroup: (groupPath: string) => void;
  commitInlineGroupRename: (name: string) => void;
  cancelInlineGroupEdit: () => void;
  commitInlineHostRename: (name: string) => void;
  cancelInlineHostEdit: () => void;
  moveHostToGroup: (hostId: string, groupPath: string | null) => void;
  moveGroup: (sourcePath: string, targetParent: string | null) => void;
  managedGroupPaths?: Set<string>;
  onUnmanageGroup?: (groupPath: string) => void;
}

type Listener = () => void;

class VaultHostTreeActionsStore {
  private actions: VaultHostTreeActions | null = null;
  private listeners = new Set<Listener>();

  getActions = () => this.actions;

  setActions = (actions: VaultHostTreeActions | null) => {
    this.actions = actions;
    this.listeners.forEach((listener) => listener());
  };

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export const vaultHostTreeActionsStore = new VaultHostTreeActionsStore();

export const useVaultHostTreeActions = () => {
  return useSyncExternalStore(
    vaultHostTreeActionsStore.subscribe,
    vaultHostTreeActionsStore.getActions,
    vaultHostTreeActionsStore.getActions,
  );
};
