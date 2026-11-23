/**
 * SFTP Dialog Action Store
 *
 * Manages dialog action triggers for SFTP operations.
 * This store allows keyboard shortcuts to trigger dialogs in the appropriate pane.
 */

import { useEffect } from "react";
import { createExternalStore } from "../createExternalStore";
import { sftpFocusStore, SftpFocusedSide } from "./sftpFocusStore";

type SftpDialogActionType = "rename" | "delete" | "newFolder" | "newFile" | null;

interface SftpDialogAction {
  type: SftpDialogActionType;
  targetSide: SftpFocusedSide;
  targetScopeId: string;
  targetFiles?: string[]; // For rename (single file) or delete (multiple files)
  timestamp: number; // To distinguish different triggers of the same action
}

const store = createExternalStore<SftpDialogAction | null>(null, {
  isEqual: () => false,
});

export const sftpDialogActionStore = {
  getSnapshot: store.getSnapshot,
  subscribe: store.subscribe,

  /**
   * Trigger a dialog action
   */
  trigger: (type: SftpDialogActionType, targetScopeId: string, targetFiles?: string[]) => {
    if (!type) {
      store.setSnapshot(null);
    } else {
      store.setSnapshot({
        type,
        targetSide: sftpFocusStore.getFocusedSide(),
        targetScopeId,
        targetFiles,
        timestamp: Date.now(),
      });
    }
  },

  /**
   * Clear the current action (called after a pane handles it)
   */
  clear: () => {
    store.setSnapshot(null);
  },

  /**
   * Get the current action
   */
  get: store.getSnapshot,
};

/**
 * React hook to subscribe to dialog action changes
 */
export const useSftpDialogAction = (): SftpDialogAction | null => store.useStore();

/**
 * React hook for a pane to respond to dialog actions
 * Only the pane matching the targetSide will execute the callback
 */
export const useSftpDialogActionHandler = (
  side: SftpFocusedSide,
  scopeId: string,
  handlers: {
    onRename?: (fileName: string) => void;
    onDelete?: (fileNames: string[]) => void;
    onNewFolder?: () => void;
    onNewFile?: () => void;
  },
  isActive = true
) => {
  const action = useSftpDialogAction();

  useEffect(() => {
    if (!action || action.targetSide !== side || action.targetScopeId !== scopeId || !isActive) return;

    // Handle the action and clear it
    switch (action.type) {
      case "rename":
        if (handlers.onRename && action.targetFiles?.[0]) {
          handlers.onRename(action.targetFiles[0]);
        }
        break;
      case "delete":
        if (handlers.onDelete && action.targetFiles) {
          handlers.onDelete(action.targetFiles);
        }
        break;
      case "newFolder":
        handlers.onNewFolder?.();
        break;
      case "newFile":
        handlers.onNewFile?.();
        break;
    }

    // Clear the action after handling
    sftpDialogActionStore.clear();
  }, [action, side, scopeId, handlers, isActive]);
};
