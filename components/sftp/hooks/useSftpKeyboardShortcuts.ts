/**
 * useSftpKeyboardShortcuts
 * 
 * Hook that handles keyboard shortcuts for SFTP operations.
 * Supports copy, cut, paste, select all, rename, delete, refresh, and new folder.
 */

import { useCallback, useEffect } from "react";
import type { MutableRefObject } from "react";
import { KeyBinding, matchesKeyBinding } from "../../../domain/models";
import { getParentPath, joinPath } from "../../../application/state/sftp/utils";
import { sftpClipboardStore, SftpClipboardFile } from "./useSftpClipboard";
import { sftpFocusStore } from "./useSftpFocusedPane";
import { sftpDialogActionStore } from "./useSftpDialogAction";
import { sftpTreeSelectionStore } from "./useSftpTreeSelectionStore";
import { sftpListOrderStore } from "./useSftpListOrderStore";
import type { SftpStateApi } from "../../../application/state/useSftpState";
import { filterHiddenFiles, isNavigableDirectory } from "../index";
import type { SftpFileEntry } from "../../../types";
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

// ── Tree Enter key action store ──────────────────────────────────────
// Allows the keyboard shortcut hook to signal tree views to handle Enter.

type TreeEnterListener = () => void;

interface TreeEnterAction {
  paneId: string;
  entryPath: string;
  isDirectory: boolean;
  timestamp: number;
}

let _treeEnterAction: TreeEnterAction | null = null;
const _treeEnterListeners = new Set<TreeEnterListener>();
const notifyTreeEnterListeners = () => _treeEnterListeners.forEach((l) => l());

export const sftpTreeEnterStore = {
  trigger: (paneId: string, entryPath: string, isDirectory: boolean) => {
    _treeEnterAction = { paneId, entryPath, isDirectory, timestamp: Date.now() };
    notifyTreeEnterListeners();
  },
  get: () => _treeEnterAction,
  clear: () => {
    _treeEnterAction = null;
    notifyTreeEnterListeners();
  },
  subscribe: (listener: TreeEnterListener) => {
    _treeEnterListeners.add(listener);
    return () => { _treeEnterListeners.delete(listener); };
  },
  getSnapshot: () => _treeEnterAction,
};

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
    async (e: KeyboardEvent) => {
      // Basic SFTP keyboard navigation should work whenever the SFTP tab is active,
      // even if the user has disabled global/custom hotkeys.
      if (!isActive) return;

      // Skip if focus is on an input element
      const target = e.target as HTMLElement;
      const isEditableTarget =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable ||
        !!target.closest?.(".monaco-editor, .monaco-diff-editor, .monaco-inputbox");
      if (isEditableTarget) {
        return;
      }

      // ── Arrow Up/Down: move selection ────────────────────────────────
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const sftp = sftpRef.current;
        const focusedSide = sftpFocusStore.getFocusedSide();
        const pane = focusedSide === "left"
          ? sftp.leftTabs.tabs.find(p => p.id === sftp.leftTabs.activeTabId)
          : sftp.rightTabs.tabs.find(p => p.id === sftp.rightTabs.activeTabId);
        if (!pane || !pane.connection) return;

        const delta = e.key === 'ArrowDown' ? 1 : -1;

        // List view: navigate sorted display files.
        // Prefer the list store when it exists so stale tree selection state
        // cannot swallow keyboard navigation after switching views.
        const listItems = sftpListOrderStore.getItems(pane.id);
        if (listItems.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          const currentSelected = Array.from(pane.selectedFiles) as string[];
          let currentIdx = -1;
          if (currentSelected.length >= 1) {
            // Use the last selected item as anchor
            const lastSelected = currentSelected[currentSelected.length - 1];
            currentIdx = listItems.indexOf(lastSelected);
          }
          let nextIdx = currentIdx + delta;
          if (nextIdx < 0) nextIdx = 0;
          if (nextIdx >= listItems.length) nextIdx = listItems.length - 1;
          const nextName = listItems[nextIdx];
          if (e.shiftKey && currentSelected.length > 0) {
            // Shift+Arrow: range selection
            const anchorIdx = currentIdx >= 0 ? currentIdx : 0;
            const start = Math.min(anchorIdx, nextIdx);
            const end = Math.max(anchorIdx, nextIdx);
            sftp.rangeSelect(focusedSide, listItems.slice(start, end + 1));
          } else {
            sftp.rangeSelect(focusedSide, [nextName]);
          }
          return;
        }

        // Tree view: navigate visible items
        const treeState = sftpTreeSelectionStore.getPaneState(pane.id);
        if (treeState.visibleItems.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          const items = treeState.visibleItems;
          const currentSelected = [...treeState.selectedPaths];
          let currentIdx = -1;
          if (currentSelected.length === 1) {
            currentIdx = treeState.visibleIndexByPath.get(currentSelected[0]) ?? -1;
          }
          let nextIdx = currentIdx + delta;
          if (nextIdx < 0) nextIdx = 0;
          if (nextIdx >= items.length) nextIdx = items.length - 1;
          if (e.shiftKey && currentSelected.length > 0) {
            // Shift+Arrow: extend selection
            const anchorIdx = currentIdx >= 0 ? currentIdx : 0;
            const start = Math.min(anchorIdx, nextIdx);
            const end = Math.max(anchorIdx, nextIdx);
            const paths = items.slice(start, end + 1).map(item => item.path);
            sftpTreeSelectionStore.setSelection(pane.id, paths);
          } else {
            sftpTreeSelectionStore.setSelection(pane.id, [items[nextIdx].path]);
          }
          return;
        }
        return;
      }

      // ── Enter key: open/navigate/expand ────────────────────────────
      if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const sftp = sftpRef.current;
        const focusedSide = sftpFocusStore.getFocusedSide();
        const pane = focusedSide === "left"
          ? sftp.leftTabs.tabs.find(p => p.id === sftp.leftTabs.activeTabId)
          : sftp.rightTabs.tabs.find(p => p.id === sftp.rightTabs.activeTabId);
        if (!pane || !pane.connection) return;

        // Prefer list selection when the list store is active so stale tree
        // selection state cannot intercept Enter in list mode.
        const listItems = sftpListOrderStore.getItems(pane.id);
        const selectedFiles = Array.from(pane.selectedFiles) as string[];
        if (listItems.length > 0 && selectedFiles.length === 1) {
          e.preventDefault();
          e.stopPropagation();
          const fileName = selectedFiles[0];
          const entry = (pane.files as SftpFileEntry[]).find(f => f.name === fileName);
          if (entry) {
            if (isNavigableDirectory(entry)) {
              sftp.navigateTo(focusedSide, joinPath(pane.connection.currentPath, entry.name));
            } else {
              sftp.openEntry(focusedSide, entry);
            }
          }
          return;
        }

        const treeSelection = sftpTreeSelectionStore.getSelectedItems(pane.id);
        if (treeSelection.length === 1) {
          e.preventDefault();
          e.stopPropagation();
          const item = treeSelection[0];
          // For tree view: toggle expand for dirs, open for files
          sftpTreeEnterStore.trigger(pane.id, item.path, item.isDirectory);
          return;
        }
        return;
      }

      if (hotkeyScheme === "disabled") return;

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
      const treeSelectionState = sftpTreeSelectionStore.getPaneState(pane.id);
      const treeSelection = sftpTreeSelectionStore.getSelectedItems(pane.id);
      const treeActionSelection = treeSelection.filter((entry) => entry.name !== '..');

      switch (action) {
        case "sftpCopy": {
          if (treeActionSelection.length > 0) {
            const parentPaths = new Set(treeActionSelection.map((entry) => getParentPath(entry.path)));
            if (parentPaths.size !== 1) {
              toast.info("Tree selection across multiple folders can't be copied with shortcuts yet.", "SFTP");
              return;
            }

            const clipboardFiles: SftpClipboardFile[] = treeActionSelection.map((entry) => ({
              name: entry.name,
              isDirectory: entry.isDirectory,
            }));

            sftpClipboardStore.copy(
              clipboardFiles,
              Array.from(parentPaths)[0],
              pane.connection.id,
              focusedSide,
            );
            break;
          }

          // Copy selected files to clipboard
          const selectedFiles = Array.from(pane.selectedFiles) as string[];
          if (selectedFiles.length === 0) return;

          {
            const filesByName = new Map((pane.files as SftpFileEntry[]).map(f => [f.name, f]));
            const clipboardFiles: SftpClipboardFile[] = selectedFiles.map((name: string) => {
              const file = filesByName.get(name);
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
          }
          break;
        }

        case "sftpCut": {
          if (treeActionSelection.length > 0) {
            const parentPaths = new Set(treeActionSelection.map((entry) => getParentPath(entry.path)));
            if (parentPaths.size !== 1) {
              toast.info("Tree selection across multiple folders can't be cut with shortcuts yet.", "SFTP");
              return;
            }

            const clipboardFiles: SftpClipboardFile[] = treeActionSelection.map((entry) => ({
              name: entry.name,
              isDirectory: entry.isDirectory,
            }));

            sftpClipboardStore.cut(
              clipboardFiles,
              Array.from(parentPaths)[0],
              pane.connection.id,
              focusedSide,
            );
            break;
          }

          // Cut selected files to clipboard
          const selectedFiles = Array.from(pane.selectedFiles) as string[];
          if (selectedFiles.length === 0) return;

          {
            const filesByName = new Map((pane.files as SftpFileEntry[]).map(f => [f.name, f]));
            const clipboardFiles: SftpClipboardFile[] = selectedFiles.map((name: string) => {
              const file = filesByName.get(name);
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
          }
          break;
        }

        case "sftpPaste": {
          // Paste files from clipboard
          const clipboard = sftpClipboardStore.get();
          if (!clipboard || clipboard.files.length === 0) return;

          // Use startTransfer to paste files from source to current pane
          // The transfer direction is determined by clipboard sourceSide and current focusedSide
          if (clipboard.sourceSide !== focusedSide) {
            const sourceTabs = clipboard.sourceSide === "left" ? sftp.leftTabs.tabs : sftp.rightTabs.tabs;
            const sourcePane = sourceTabs.find((tab) => tab.connection?.id === clipboard.sourceConnectionId);

            if (!sourcePane?.connection) {
              toast.info("Paste source is no longer available.", "SFTP");
              return;
            }

            // Cross-pane paste - use startTransfer
            try {
              const isCut = clipboard.operation === "cut";
              const pendingNames = new Set(clipboard.files.map((file) => file.name));
              const completedNames = new Set<string>();
              const failedNames = new Set<string>();

              const updateClipboardAfterCompletion = (showToast: boolean) => {
                if (!isCut) return;
                const current = sftpClipboardStore.get();
                if (
                  !current ||
                  current.operation !== "cut" ||
                  current.sourceConnectionId !== clipboard.sourceConnectionId ||
                  current.sourcePath !== clipboard.sourcePath ||
                  current.sourceSide !== clipboard.sourceSide
                ) {
                  return;
                }

                const remainingFiles = current.files.filter((file) => !completedNames.has(file.name));
                if (remainingFiles.length === 0) {
                  sftpClipboardStore.clear();
                } else {
                  sftpClipboardStore.updateFiles(remainingFiles);
                }

                if (showToast && failedNames.size > 0) {
                  toast.info("Some items could not be transferred and were kept in the clipboard.", "SFTP");
                }
              };

              const handleTransferComplete = async (result: {
                fileName: string;
                originalFileName?: string;
                status: string;
              }) => {
                if (!isCut) return;
                const sourceFileName = result.originalFileName ?? result.fileName;
                if (!pendingNames.has(sourceFileName)) return;
                pendingNames.delete(sourceFileName);

                if (result.status === "completed") {
                  try {
                    await sftp.deleteFilesAtPath(
                      clipboard.sourceSide,
                      clipboard.sourceConnectionId,
                      clipboard.sourcePath,
                      [sourceFileName],
                    );
                    completedNames.add(sourceFileName);
                  } catch {
                    failedNames.add(sourceFileName);
                  }
                } else {
                  failedNames.add(sourceFileName);
                }

                updateClipboardAfterCompletion(pendingNames.size === 0);
              };

              await sftp.startTransfer(clipboard.files, clipboard.sourceSide, focusedSide, {
                sourcePane,
                sourcePath: clipboard.sourcePath,
                sourceConnectionId: clipboard.sourceConnectionId,
                onTransferComplete: handleTransferComplete,
              });
            } catch {
              toast.error("Paste failed. Please try again.", "SFTP");
            }
          } else {
            // Same-pane paste is not supported - show info toast
            toast.info("Paste within the same pane is not supported. Use copy to other pane instead.", "SFTP");
          }
          break;
        }

        case "sftpSelectAll": {
          if (treeSelectionState.visibleItems.length > 0) {
            sftpTreeSelectionStore.selectAllVisible(pane.id);
            break;
          }

          // Select all files in the current pane
          // TODO: Reference already-computed filtered files from useSftpPaneFiles
          // instead of re-implementing the hidden file + filter logic here.
          // This requires either lifting the computed files into pane state or
          // passing them via a shared store, which needs a larger refactor.
          const term = pane.filter.trim().toLowerCase();
          let visibleFiles = filterHiddenFiles(pane.files, pane.showHiddenFiles);
          if (term) {
            visibleFiles = visibleFiles.filter(
              (f) => f.name === ".." || f.name.toLowerCase().includes(term),
            );
          }
          const allFileNames = visibleFiles
            .filter((f) => f.name !== "..")
            .map((f) => f.name);
          sftp.rangeSelect(focusedSide, allFileNames);
          break;
        }

        case "sftpRename": {
          if (treeActionSelection.length === 1) {
            sftpDialogActionStore.trigger("rename", [treeActionSelection[0].path]);
            break;
          }

          // Trigger rename for the first selected file
          const selectedFiles = Array.from(pane.selectedFiles) as string[];
          if (selectedFiles.length !== 1) return;
          sftpDialogActionStore.trigger("rename", selectedFiles);
          break;
        }

        case "sftpDelete": {
          if (treeActionSelection.length > 0) {
            sftpDialogActionStore.trigger("delete", treeActionSelection.map((entry) => entry.path));
            break;
          }

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
