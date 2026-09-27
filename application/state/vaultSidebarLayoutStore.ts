import { useSyncExternalStore } from 'react';

type Listener = () => void;

/**
 * Live width of the vault sidebar rail. VaultViewLayout publishes its sidebar
 * width here so the root SFTP surface can offset itself beside the rail while
 * the vault sidebar stays visible during the SFTP tab (the "SFTP in sidebar"
 * setting). Mirrors the terminalHostTreeStore layout-width pattern.
 */
class VaultSidebarLayoutStore {
  private layoutWidth = 0;
  private listeners = new Set<Listener>();

  getLayoutWidth = () => this.layoutWidth;

  setLayoutWidth = (width: number) => {
    const next = Math.max(0, Math.round(width));
    if (this.layoutWidth === next) return;
    this.layoutWidth = next;
    this.listeners.forEach((listener) => listener());
  };

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
}

export const vaultSidebarLayoutStore = new VaultSidebarLayoutStore();

export const useVaultSidebarLayoutWidth = () => {
  return useSyncExternalStore(
    vaultSidebarLayoutStore.subscribe,
    vaultSidebarLayoutStore.getLayoutWidth,
    vaultSidebarLayoutStore.getLayoutWidth,
  );
};

/**
 * Horizontal offset applied to the root SFTP view so it starts to the right
 * of the vault sidebar rail. Zero unless the SFTP-in-sidebar mode is on and
 * the SFTP tab is the active surface.
 */
export function computeSftpViewRailOffset(params: {
  sftpInSidebar: boolean;
  isSftpActive: boolean;
  vaultRailWidth: number;
}): number {
  return params.sftpInSidebar && params.isSftpActive
    ? Math.max(0, params.vaultRailWidth)
    : 0;
}
