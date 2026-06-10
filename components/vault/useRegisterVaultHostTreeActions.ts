import { useEffect } from 'react';

import { activeTabStore } from '../../application/state/activeTabStore';
import {
  vaultHostTreeActionsStore,
  type VaultHostTreeActions,
} from '../../application/state/vaultHostTreeActionsStore';
import type { Host } from '../../types';

type RegisterVaultHostTreeActionsParams = {
  handleCopyCredentials: (host: Host) => void;
  handleDuplicateHost: (host: Host) => void;
  startInlineRenameHost: (host: Host) => void;
  onDeleteHost: (hostId: string) => void;
  handleUnmanageGroup?: (groupPath: string) => void;
  moveHostToGroup: (hostId: string, groupPath: string | null) => void;
  moveGroup: (sourcePath: string, targetParent: string | null) => void;
  managedGroupPaths?: Set<string>;
  startInlineNewGroup: (parentPath?: string) => void;
  startInlineRenameGroup: (groupPath: string) => void;
  startInlineDeleteGroup: (groupPath: string) => void;
  commitInlineGroupRename: (name: string) => void;
  cancelInlineGroupEdit: () => void;
  commitInlineHostRename: (name: string) => void;
  cancelInlineHostEdit: () => void;
};

function focusVaultTab() {
  activeTabStore.setActiveTabId('vault');
}

function withVaultFocus<T extends (...args: never[]) => void>(fn: T): T {
  return ((...args: Parameters<T>) => {
    focusVaultTab();
    fn(...args);
  }) as T;
}

export function useRegisterVaultHostTreeActions({
  handleCopyCredentials,
  handleDuplicateHost,
  startInlineRenameHost,
  onDeleteHost,
  handleUnmanageGroup,
  moveHostToGroup,
  moveGroup,
  managedGroupPaths,
  startInlineNewGroup,
  startInlineRenameGroup,
  startInlineDeleteGroup,
  commitInlineGroupRename,
  cancelInlineGroupEdit,
  commitInlineHostRename,
  cancelInlineHostEdit,
}: RegisterVaultHostTreeActionsParams) {
  useEffect(() => {
    const actions: VaultHostTreeActions = {
      onCopyCredentials: handleCopyCredentials,
      onDuplicateHost: withVaultFocus(handleDuplicateHost),
      onRenameHost: startInlineRenameHost,
      onDeleteHost: (host) => onDeleteHost(host.id),
      onNewGroup: startInlineNewGroup,
      onRenameGroup: startInlineRenameGroup,
      onDeleteGroup: startInlineDeleteGroup,
      commitInlineGroupRename,
      cancelInlineGroupEdit,
      commitInlineHostRename,
      cancelInlineHostEdit,
      moveHostToGroup,
      moveGroup,
      managedGroupPaths,
      onUnmanageGroup: handleUnmanageGroup
        ? withVaultFocus(handleUnmanageGroup)
        : undefined,
    };

    vaultHostTreeActionsStore.setActions(actions);
    return () => vaultHostTreeActionsStore.setActions(null);
  }, [
    cancelInlineGroupEdit,
    cancelInlineHostEdit,
    commitInlineGroupRename,
    commitInlineHostRename,
    handleCopyCredentials,
    handleDuplicateHost,
    handleUnmanageGroup,
    managedGroupPaths,
    moveGroup,
    moveHostToGroup,
    onDeleteHost,
    startInlineRenameHost,
    startInlineDeleteGroup,
    startInlineNewGroup,
    startInlineRenameGroup,
  ]);
}
