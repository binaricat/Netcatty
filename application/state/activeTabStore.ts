import { useCallback, useSyncExternalStore } from 'react';

import { terminalLayoutSuppressStore } from './terminalLayoutSuppressStore';

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
  private notifyRafId: number | null = null;

  getActiveTabId = () => this.activeTabId;

  private scheduleNotify = () => {
    if (this.notifyRafId !== null) return;
    const schedule = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: () => void) => window.setTimeout(cb, 0) as unknown as number;
    this.notifyRafId = schedule(() => {
      this.notifyRafId = null;
      this.listeners.forEach((listener) => listener());
    });
  };

  setActiveTabId = (id: string) => {
    if (this.activeTabId !== id) {
      terminalLayoutSuppressStore.begin();
      this.activeTabId = id;
      // Coalesce rapid tab switches into one notification per frame and avoid
      // "setState during render" if called from a render phase.
      this.scheduleNotify();
      const schedule = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (cb: () => void) => window.setTimeout(cb, 0) as unknown as number;
      schedule(() => {
        schedule(() => {
          terminalLayoutSuppressStore.end();
        });
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
    activeTabStore.getActiveTabId,
    activeTabStore.getActiveTabId,
  );
};

// Hook to get setter - never causes re-render
export const useSetActiveTabId = () => {
  return activeTabStore.setActiveTabId;
};

// Check if a specific tab is active - only re-renders when this specific tab's active state changes
export const useIsTabActive = (tabId: string) => {
  const getSnapshot = useCallback(() => activeTabStore.getActiveTabId() === tabId, [tabId]);
  return useSyncExternalStore(activeTabStore.subscribe, getSnapshot, getSnapshot);
};

// Stable snapshot functions - defined once outside components
const getIsVaultActive = () => activeTabStore.getActiveTabId() === 'vault';
const getIsSftpActive = () => activeTabStore.getActiveTabId() === 'sftp';

// Check if vault is active
export const useIsVaultActive = () => {
  return useSyncExternalStore(
    activeTabStore.subscribe,
    getIsVaultActive,
    getIsVaultActive,
  );
};

// Check if sftp is active
export const useIsSftpActive = () => {
  return useSyncExternalStore(
    activeTabStore.subscribe,
    getIsSftpActive,
    getIsSftpActive,
  );
};

// Check if a specific editor tab is currently active
export const useIsEditorTabActive = (tabId: string): boolean => {
  const editorTopId = toEditorTabId(tabId);
  const getSnapshot = useCallback(() => activeTabStore.getActiveTabId() === editorTopId, [editorTopId]);
  return useSyncExternalStore(activeTabStore.subscribe, getSnapshot, getSnapshot);
};

export const isTerminalLayerVisibleTab = (activeTabId: string): boolean => {
  return activeTabId !== 'vault' && activeTabId !== 'sftp';
};

// Check if terminal layer should be visible
// Editor tabs share the terminal work surface so the host sidebar remains usable.
export const useIsTerminalLayerVisible = (draggingSessionId: string | null) => {
  const getSnapshot = useCallback(() => {
    const activeTabId = activeTabStore.getActiveTabId();
    return isTerminalLayerVisibleTab(activeTabId) || !!draggingSessionId;
  }, [draggingSessionId]);

  return useSyncExternalStore(activeTabStore.subscribe, getSnapshot, getSnapshot);
};
