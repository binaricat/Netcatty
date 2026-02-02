/**
 * SFTP Clipboard Store
 * 
 * Manages clipboard state for SFTP file operations (copy/cut/paste)
 * This is a simple store that holds the clipboard state and operation type.
 */

import { useSyncExternalStore } from "react";

export type SftpClipboardOperation = "copy" | "cut";

export interface SftpClipboardFile {
  name: string;
  isDirectory: boolean;
}

export interface SftpClipboardState {
  files: SftpClipboardFile[];
  sourcePath: string;
  sourceConnectionId: string;
  sourceSide: "left" | "right";
  operation: SftpClipboardOperation;
}

type ClipboardListener = () => void;

let clipboardState: SftpClipboardState | null = null;
const clipboardListeners = new Set<ClipboardListener>();

const notifyListeners = () => {
  clipboardListeners.forEach((listener) => listener());
};

export const sftpClipboardStore = {
  getSnapshot: (): SftpClipboardState | null => clipboardState,
  
  subscribe: (listener: ClipboardListener) => {
    clipboardListeners.add(listener);
    return () => clipboardListeners.delete(listener);
  },

  /**
   * Copy files to clipboard
   */
  copy: (
    files: SftpClipboardFile[],
    sourcePath: string,
    sourceConnectionId: string,
    sourceSide: "left" | "right"
  ) => {
    clipboardState = {
      files,
      sourcePath,
      sourceConnectionId,
      sourceSide,
      operation: "copy",
    };
    notifyListeners();
  },

  /**
   * Cut files to clipboard
   */
  cut: (
    files: SftpClipboardFile[],
    sourcePath: string,
    sourceConnectionId: string,
    sourceSide: "left" | "right"
  ) => {
    clipboardState = {
      files,
      sourcePath,
      sourceConnectionId,
      sourceSide,
      operation: "cut",
    };
    notifyListeners();
  },

  /**
   * Clear clipboard (called after paste for cut operation)
   */
  clear: () => {
    clipboardState = null;
    notifyListeners();
  },

  /**
   * Update clipboard file list (used for partial cut transfers)
   */
  updateFiles: (files: SftpClipboardFile[]) => {
    if (!clipboardState) return;
    if (files.length === 0) {
      clipboardState = null;
    } else {
      clipboardState = {
        ...clipboardState,
        files,
      };
    }
    notifyListeners();
  },

  /**
   * Check if there are files in the clipboard
   */
  hasFiles: (): boolean => clipboardState !== null && clipboardState.files.length > 0,

  /**
   * Get the clipboard state
   */
  get: (): SftpClipboardState | null => clipboardState,
};

/**
 * React hook to subscribe to clipboard state changes
 */
export const useSftpClipboard = (): SftpClipboardState | null => {
  return useSyncExternalStore(
    sftpClipboardStore.subscribe,
    sftpClipboardStore.getSnapshot,
    sftpClipboardStore.getSnapshot
  );
};
