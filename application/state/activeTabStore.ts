import { useCallback,useSyncExternalStore } from 'react';

// Simple store for active tab that allows fine-grained subscriptions
type Listener = () => void;

// ----- Editor tab id helpers -----
export const EDITOR_PREFIX = 'editor:';

/** Returns true when `id` is an editor tab id (starts with "editor:"). */
export const isEditorTabId = (id: string): boolean => id.startsWith(EDITOR_PREFIX);

/** Convert an editorTab's internal id to a top-tab id understood by the tab bar. */
export const toEditorTabId = (editorId: string): string => `${EDITOR_PREFIX}${editorId}`;

/** Strip the "editor:" prefix to recover the internal editorTab id. */
export const fromEditorTabId = (tabId: string): string => tabId.slice(EDITOR_PREFIX.length);

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

// Check if a specific editor tab is currently active
export const useIsEditorTabActive = (tabId: string): boolean => {
  const editorTopId = toEditorTabId(tabId);
  const getSnapshot = useCallback(() => activeTabStore.getActiveTabId() === editorTopId, [editorTopId]);
  return useSyncExternalStore(activeTabStore.subscribe, getSnapshot);
};

// Check if terminal layer should be visible
// Editor tabs are NOT terminal tabs, so exclude them from the visibility condition.
export const useIsTerminalLayerVisible = (draggingSessionId: string | null) => {
  const activeTabId = useActiveTabId();
  const isTerminalTab = activeTabId !== 'vault' && activeTabId !== 'sftp' && !isEditorTabId(activeTabId);
  return isTerminalTab || !!draggingSessionId;
};
