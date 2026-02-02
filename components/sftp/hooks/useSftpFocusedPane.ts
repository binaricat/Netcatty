/**
 * SFTP Focused Pane Store
 * 
 * Tracks which SFTP pane (left or right) is currently focused.
 * This is used to determine which pane should receive keyboard shortcut actions.
 */

import { useSyncExternalStore } from "react";

export type SftpFocusedSide = "left" | "right";

type FocusListener = () => void;

let focusedSide: SftpFocusedSide = "left";
const focusListeners = new Set<FocusListener>();

const notifyListeners = () => {
  focusListeners.forEach((listener) => listener());
};

export const sftpFocusStore = {
  getSnapshot: (): SftpFocusedSide => focusedSide,

  subscribe: (listener: FocusListener) => {
    focusListeners.add(listener);
    return () => focusListeners.delete(listener);
  },

  /**
   * Set the focused side
   */
  setFocusedSide: (side: SftpFocusedSide) => {
    if (focusedSide !== side) {
      focusedSide = side;
      notifyListeners();
    }
  },

  /**
   * Get the current focused side
   */
  getFocusedSide: (): SftpFocusedSide => focusedSide,
};

/**
 * React hook to subscribe to focused side changes
 */
export const useSftpFocusedSide = (): SftpFocusedSide => {
  return useSyncExternalStore(
    sftpFocusStore.subscribe,
    sftpFocusStore.getSnapshot,
    sftpFocusStore.getSnapshot
  );
};
