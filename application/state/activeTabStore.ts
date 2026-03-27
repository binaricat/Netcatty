import { useCallback,useSyncExternalStore } from 'react';

// Simple store for active tab that allows fine-grained subscriptions
type Listener = () => void;

class ActiveTabStore {
  private activeTabId: string = 'vault';
  private listeners = new Set<Listener>();
  private pendingNotify = false;

  getActiveTabId = () => this.activeTabId;

  setActiveTabId = (id: string) => {
    if (this.activeTabId !== id) {
      this.activeTabId = id;
      // Defer listener notification to avoid "setState during render" if called from a render phase
      if (this.pendingNotify) return;
      this.pendingNotify = true;
      Promise.resolve().then(() => {
        this.pendingNotify = false;
        this.listeners.forEach(listener => listener());
      });
    }
  };

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export const activeTabStore = new ActiveTabStore();

// Hook to read active tab ID - only re-renders when activeTabId changes
export const useActiveTabId = () => {
  return useSyncExternalStore(
    activeTabStore.subscribe,
    activeTabStore.getActiveTabId
  );
};

// Hook to get setter - never causes re-render
export const useSetActiveTabId = () => {
  return activeTabStore.setActiveTabId;
};

// Check if a specific tab is active - only re-renders when this specific tab's active state changes
export const useIsTabActive = (tabId: string) => {
  const getSnapshot = useCallback(() => activeTabStore.getActiveTabId() === tabId, [tabId]);
  return useSyncExternalStore(activeTabStore.subscribe, getSnapshot);
};

// Stable snapshot functions - defined once outside components
const getIsVaultActive = () => activeTabStore.getActiveTabId() === 'vault';
const getIsSftpActive = () => activeTabStore.getActiveTabId() === 'sftp';

// Check if vault is active
export const useIsVaultActive = () => {
  return useSyncExternalStore(
    activeTabStore.subscribe,
    getIsVaultActive
  );
};

// Check if sftp is active
export const useIsSftpActive = () => {
  return useSyncExternalStore(
    activeTabStore.subscribe,
    getIsSftpActive
  );
};

// Check if terminal layer should be visible
export const useIsTerminalLayerVisible = (draggingSessionId: string | null) => {
  const activeTabId = useActiveTabId();
  const isTerminalTab = activeTabId !== 'vault' && activeTabId !== 'sftp';
  return isTerminalTab || !!draggingSessionId;
};
