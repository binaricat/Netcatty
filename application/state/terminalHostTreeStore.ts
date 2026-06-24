import { useCallback, useSyncExternalStore } from 'react';

import { STORAGE_KEY_TERMINAL_HOST_TREE_COLLAPSED } from '../../infrastructure/config/storageKeys';
import { localStorageAdapter } from '../../infrastructure/persistence/localStorageAdapter';

type Listener = () => void;

export const TERMINAL_HOST_TREE_MIN_WIDTH = 132;
export const TERMINAL_HOST_TREE_DEFAULT_WIDTH = 220;
export const TERMINAL_HOST_TREE_MAX_WIDTH = 360;

export function clampTerminalHostTreeWidth(width: number): number {
  return Math.max(
    TERMINAL_HOST_TREE_MIN_WIDTH,
    Math.min(TERMINAL_HOST_TREE_MAX_WIDTH, width),
  );
}

function readIsOpen(): boolean {
  const stored = localStorageAdapter.readString(STORAGE_KEY_TERMINAL_HOST_TREE_COLLAPSED);
  // Legacy key stores "collapsed"; open is the inverse.
  if (stored === 'true') return false;
  if (stored === 'false') return true;
  return false;
}

class TerminalHostTreeStore {
  private isOpen = readIsOpen();
  /** Live sidebar width (0 when collapsed) for top-tab alignment. */
  private layoutWidth = 0;
  private listeners = new Set<Listener>();

  getIsOpen = () => this.isOpen;

  getLayoutWidth = () => this.layoutWidth;

  setIsOpen = (open: boolean) => {
    if (this.isOpen === open) return;
    this.isOpen = open;
    localStorageAdapter.writeString(
      STORAGE_KEY_TERMINAL_HOST_TREE_COLLAPSED,
      open ? 'false' : 'true',
    );
    this.listeners.forEach((listener) => listener());
  };

  setLayoutWidth = (width: number) => {
    const next = Math.max(0, Math.round(width));
    if (this.layoutWidth === next) return;
    this.layoutWidth = next;
    this.listeners.forEach((listener) => listener());
  };

  toggle = () => {
    this.setIsOpen(!this.isOpen);
  };

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export const terminalHostTreeStore = new TerminalHostTreeStore();

export const useTerminalHostTreeOpen = () => {
  return useSyncExternalStore(
    terminalHostTreeStore.subscribe,
    terminalHostTreeStore.getIsOpen,
    terminalHostTreeStore.getIsOpen,
  );
};

export const useToggleTerminalHostTree = () => {
  return useCallback(() => terminalHostTreeStore.toggle(), []);
};

export const useTerminalHostTreeLayoutWidth = () => {
  return useSyncExternalStore(
    terminalHostTreeStore.subscribe,
    terminalHostTreeStore.getLayoutWidth,
    terminalHostTreeStore.getLayoutWidth,
  );
};
