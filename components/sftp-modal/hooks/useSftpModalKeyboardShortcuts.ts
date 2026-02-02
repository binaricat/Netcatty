/**
 * useSftpModalKeyboardShortcuts
 * 
 * Hook that handles keyboard shortcuts for SFTPModal operations.
 * Supports select all, rename, delete, refresh, and new folder.
 * Note: Copy/Cut/Paste are not supported in the modal as it's a single-pane view.
 */

import { useCallback, useEffect } from "react";
import { KeyBinding, matchesKeyBinding } from "../../../domain/models";
import type { RemoteFile } from "../../../types";

// SFTP Modal action names that we handle (subset of main SFTP actions)
const SFTP_MODAL_ACTIONS = new Set([
  "sftpSelectAll",
  "sftpRename",
  "sftpDelete",
  "sftpRefresh",
  "sftpNewFolder",
]);

interface UseSftpModalKeyboardShortcutsParams {
  keyBindings: KeyBinding[];
  hotkeyScheme: "disabled" | "mac" | "pc";
  open: boolean;
  files: RemoteFile[];
  visibleFiles: RemoteFile[];
  selectedFiles: Set<string>;
  setSelectedFiles: (files: Set<string>) => void;
  onRefresh: () => void;
  onRename?: (file: RemoteFile) => void;
  onDelete?: (fileNames: string[]) => void;
  onNewFolder?: () => void;
}

/**
 * Check if a keyboard event matches any SFTP action
 */
const matchSftpAction = (
  e: KeyboardEvent,
  keyBindings: KeyBinding[],
  isMac: boolean
): { action: string; binding: KeyBinding } | null => {
  for (const binding of keyBindings) {
    if (binding.category !== "sftp") continue;
    const keyStr = isMac ? binding.mac : binding.pc;
    if (matchesKeyBinding(e, keyStr, isMac)) {
      return { action: binding.action, binding };
    }
  }
  return null;
};

export const useSftpModalKeyboardShortcuts = ({
  keyBindings,
  hotkeyScheme,
  open,
  files,
  visibleFiles,
  selectedFiles,
  setSelectedFiles,
  onRefresh,
  onRename,
  onDelete,
  onNewFolder,
}: UseSftpModalKeyboardShortcutsParams) => {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Skip if shortcuts are disabled or modal is not open
      if (hotkeyScheme === "disabled" || !open) return;

      // Skip if focus is on an input element
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        return;
      }

      const isMac = hotkeyScheme === "mac";
      const matched = matchSftpAction(e, keyBindings, isMac);
      if (!matched) return;

      const { action } = matched;
      if (!SFTP_MODAL_ACTIONS.has(action)) return;

      // Prevent default behavior
      e.preventDefault();
      e.stopPropagation();

      switch (action) {
        case "sftpSelectAll": {
          // Select all files
          const allFileNames = new Set(
            visibleFiles.filter((f) => f.name !== "..").map((f) => f.name)
          );
          setSelectedFiles(allFileNames);
          break;
        }

        case "sftpRename": {
          // Trigger rename for the first selected file
          const selectedArray = Array.from(selectedFiles);
          if (selectedArray.length !== 1) return;
          const file = files.find((f) => f.name === selectedArray[0]);
          if (file && onRename) {
            onRename(file);
          }
          break;
        }

        case "sftpDelete": {
          // Delete selected files
          const selectedArray = Array.from(selectedFiles);
          if (selectedArray.length === 0) return;
          onDelete?.(selectedArray);
          break;
        }

        case "sftpRefresh": {
          // Refresh file list
          onRefresh();
          break;
        }

        case "sftpNewFolder": {
          // Create new folder
          onNewFolder?.();
          break;
        }
      }
    },
    [
      hotkeyScheme,
      open,
      files,
      visibleFiles,
      selectedFiles,
      setSelectedFiles,
      onRefresh,
      onRename,
      onDelete,
      onNewFolder,
      keyBindings,
    ]
  );

  useEffect(() => {
    // Use capture phase to intercept before other handlers
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [handleKeyDown]);
};
