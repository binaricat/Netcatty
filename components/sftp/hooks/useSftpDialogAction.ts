/**
 * SFTP Dialog Action Store
 * 
 * Manages dialog action triggers for SFTP operations.
 * This store allows keyboard shortcuts to trigger dialogs in the appropriate pane.
 */

import { useSyncExternalStore, useCallback, useEffect } from "react";
import { sftpFocusStore, SftpFocusedSide } from "./useSftpFocusedPane";

export type SftpDialogActionType = "rename" | "delete" | "newFolder" | "newFile" | null;

export interface SftpDialogAction {
  type: SftpDialogActionType;
  targetSide: SftpFocusedSide;
  targetFiles?: string[]; // For rename (single file) or delete (multiple files)
  timestamp: number; // To distinguish different triggers of the same action
}

type ActionListener = () => void;

let dialogAction: SftpDialogAction | null = null;
const actionListeners = new Set<ActionListener>();

const notifyListeners = () => {
  actionListeners.forEach((listener) => listener());
};

export const sftpDialogActionStore = {
  getSnapshot: (): SftpDialogAction | null => dialogAction,

  subscribe: (listener: ActionListener) => {
    actionListeners.add(listener);
    return () => actionListeners.delete(listener);
  },

  /**
   * Trigger a dialog action
   */
  trigger: (type: SftpDialogActionType, targetFiles?: string[]) => {
    if (!type) {
      dialogAction = null;
    } else {
      dialogAction = {
        type,
        targetSide: sftpFocusStore.getFocusedSide(),
        targetFiles,
        timestamp: Date.now(),
      };
    }
    notifyListeners();
  },

  /**
   * Clear the current action (called after a pane handles it)
   */
  clear: () => {
    dialogAction = null;
    notifyListeners();
  },

  /**
   * Get the current action
   */
  get: (): SftpDialogAction | null => dialogAction,
};

/**
 * React hook to subscribe to dialog action changes
 */
export const useSftpDialogAction = (): SftpDialogAction | null => {
  return useSyncExternalStore(
    sftpDialogActionStore.subscribe,
    sftpDialogActionStore.getSnapshot,
    sftpDialogActionStore.getSnapshot
  );
};

/**
 * React hook for a pane to respond to dialog actions
 * Only the pane matching the targetSide will execute the callback
 */
export const useSftpDialogActionHandler = (
  side: SftpFocusedSide,
  handlers: {
    onRename?: (fileName: string) => void;
    onDelete?: (fileNames: string[]) => void;
    onNewFolder?: () => void;
    onNewFile?: () => void;
  }
) => {
  const action = useSftpDialogAction();

  useEffect(() => {
    if (!action || action.targetSide !== side) return;

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
  }, [action, side, handlers]);
};
