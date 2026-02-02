/**
 * useSftpKeyboardShortcuts
 * 
 * Hook that handles keyboard shortcuts for SFTP operations.
 * Supports copy, cut, paste, select all, rename, delete, refresh, and new folder.
 */

import { useCallback, useEffect } from "react";
import type { MutableRefObject } from "react";
import { KeyBinding, matchesKeyBinding } from "../../../domain/models";
import { sftpClipboardStore, SftpClipboardFile } from "./useSftpClipboard";
import { sftpFocusStore } from "./useSftpFocusedPane";
import { sftpDialogActionStore } from "./useSftpDialogAction";
import type { SftpStateApi } from "../../../application/state/useSftpState";
import { isNavigableDirectory } from "../index";
import { toast } from "../../ui/toast";

// SFTP action names that we handle
const SFTP_ACTIONS = new Set([
  "sftpCopy",
  "sftpCut",
  "sftpPaste",
  "sftpSelectAll",
  "sftpRename",
  "sftpDelete",
  "sftpRefresh",
  "sftpNewFolder",
]);

interface UseSftpKeyboardShortcutsParams {
  keyBindings: KeyBinding[];
  hotkeyScheme: "disabled" | "mac" | "pc";
  sftpRef: MutableRefObject<SftpStateApi>;
  isActive: boolean;
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

export const useSftpKeyboardShortcuts = ({
  keyBindings,
  hotkeyScheme,
  sftpRef,
  isActive,
}: UseSftpKeyboardShortcutsParams) => {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Skip if shortcuts are disabled or SFTP is not active
      if (hotkeyScheme === "disabled" || !isActive) return;

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
      if (!SFTP_ACTIONS.has(action)) return;

      // Prevent default behavior
      e.preventDefault();
      e.stopPropagation();

      const sftp = sftpRef.current;
      const focusedSide = sftpFocusStore.getFocusedSide();
      
      // Get the active pane for the focused side
      const pane = focusedSide === "left" 
        ? sftp.leftTabs.tabs.find(p => p.id === sftp.leftTabs.activeTabId)
        : sftp.rightTabs.tabs.find(p => p.id === sftp.rightTabs.activeTabId);

      if (!pane || !pane.connection) return;

      switch (action) {
        case "sftpCopy": {
          // Copy selected files to clipboard
          const selectedFiles = Array.from(pane.selectedFiles) as string[];
          if (selectedFiles.length === 0) return;
          
          const clipboardFiles: SftpClipboardFile[] = selectedFiles.map((name: string) => {
            const file = pane.files.find((f) => f.name === name);
            return {
              name,
              isDirectory: file ? isNavigableDirectory(file) : false,
            };
          });
          
          sftpClipboardStore.copy(
            clipboardFiles,
            pane.connection.currentPath,
            pane.connection.id,
            focusedSide
          );
          break;
        }

        case "sftpCut": {
          // Cut selected files to clipboard
          const selectedFiles = Array.from(pane.selectedFiles) as string[];
          if (selectedFiles.length === 0) return;
          
          const clipboardFiles: SftpClipboardFile[] = selectedFiles.map((name: string) => {
            const file = pane.files.find((f) => f.name === name);
            return {
              name,
              isDirectory: file ? isNavigableDirectory(file) : false,
            };
          });
          
          sftpClipboardStore.cut(
            clipboardFiles,
            pane.connection.currentPath,
            pane.connection.id,
            focusedSide
          );
          break;
        }

        case "sftpPaste": {
          // Paste files from clipboard
          const clipboard = sftpClipboardStore.get();
          if (!clipboard || clipboard.files.length === 0) return;
          
          // Use startTransfer to paste files from source to current pane
          // The transfer direction is determined by clipboard sourceSide and current focusedSide
          if (clipboard.sourceSide !== focusedSide) {
            // Cross-pane paste - use startTransfer
            sftp.startTransfer(clipboard.files, clipboard.sourceSide, focusedSide);
            
            // Clear clipboard only for cut operations
            if (clipboard.operation === "cut") {
              sftpClipboardStore.clear();
            }
          } else {
            // Same-pane paste is not supported - show info toast
            toast.info("Paste within the same pane is not supported. Use copy to other pane instead.", "SFTP");
          }
          break;
        }

        case "sftpSelectAll": {
          // Select all files in the current pane
          const allFileNames = pane.files
            .filter((f) => f.name !== "..")
            .map((f) => f.name);
          sftp.rangeSelect(focusedSide, allFileNames);
          break;
        }

        case "sftpRename": {
          // Trigger rename for the first selected file
          const selectedFiles = Array.from(pane.selectedFiles) as string[];
          if (selectedFiles.length !== 1) return;
          sftpDialogActionStore.trigger("rename", selectedFiles);
          break;
        }

        case "sftpDelete": {
          // Delete selected files
          const selectedFiles = Array.from(pane.selectedFiles) as string[];
          if (selectedFiles.length === 0) return;
          sftpDialogActionStore.trigger("delete", selectedFiles);
          break;
        }

        case "sftpRefresh": {
          // Refresh the current pane
          sftp.refresh(focusedSide);
          break;
        }

        case "sftpNewFolder": {
          // Create new folder
          sftpDialogActionStore.trigger("newFolder");
          break;
        }
      }
    },
    [hotkeyScheme, isActive, keyBindings, sftpRef]
  );

  useEffect(() => {
    // Use capture phase to intercept before other handlers
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [handleKeyDown]);
};
