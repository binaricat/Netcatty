/**
 * useSftpKeyboardShortcuts
 * 
 * Hook that handles keyboard shortcuts for SFTP operations.
 * Supports copy, cut, paste, select all, rename, delete, refresh, and new folder.
 */

import { useCallback, useEffect, useRef } from "react";
import type { MutableRefObject } from "react";
import { KeyBinding, matchesKeyBinding } from "../../../domain/models";
import { getParentPath, joinPath } from "../../../application/state/sftp/utils";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { sftpClipboardStore, SftpClipboardFile } from "./useSftpClipboard";
import { sftpFocusStore } from "./useSftpFocusedPane";
import { sftpDialogActionStore } from "./useSftpDialogAction";
import { sftpTreeSelectionStore } from "./useSftpTreeSelectionStore";
import { sftpListOrderStore } from "./useSftpListOrderStore";
import { sftpPaneViewModeStore } from "../../../application/state/sftp/sftpPaneViewModeStore";
import { keepOnlyPaneSelections } from "./selectionScope";
import type { SftpStateApi } from "../../../application/state/useSftpState";
import { filterHiddenFiles, isNavigableDirectory } from "../utils";
import type { SftpFileEntry } from "../../../types";
import { extractDropEntries, type DropEntry } from "../../../lib/sftpFileUtils";
import { toast } from "../../ui/toast";
import {
  createDropEntriesFromClipboardFiles,
  getSftpClipboardSystemTextPaths,
  getSupportedClipboardUploadFiles,
  isSftpNativeClipboardPasteEnabled,
  resolveSftpClipboardUploadTarget,
  shouldLetNativePasteEventHandleSftpPaste,
  sftpClipboardUploadStore,
  type ClipboardLocalFile,
} from "../clipboardUpload";
import {
  advanceSftpTypeahead,
  resolveSftpTypeaheadSource,
  type SftpTypeaheadState,
} from "../../../domain/sftpTypeahead";
import {
  resolveSftpActiveSelection,
  resolveSftpSelectAllTarget,
} from "../../../domain/sftpSelection";

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
  "sftpOpen",
  "sftpGoParent",
  "sftpNavigateTo",
]);

let pendingSftpSystemClipboardWrite: Promise<void> | null = null;

const replaceSystemClipboardWithSftpPaths = async (paths: string[]) => {
  const text = paths.join("\n");
  if (!text) return;
  const writeTask = (async () => {
    const bridge = netcattyBridge.get();
    try {
      if (bridge?.writeClipboardText && await bridge.writeClipboardText(text)) return;
    } catch {
      // Fall back to the browser clipboard API.
    }
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
    await navigator.clipboard.writeText(text).catch(() => {});
  })();

  pendingSftpSystemClipboardWrite = writeTask;
  try {
    await writeTask;
  } finally {
    if (pendingSftpSystemClipboardWrite === writeTask) {
      pendingSftpSystemClipboardWrite = null;
    }
  }
};

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

// ── Keyboard selection anchor/focus tracking ────────────────────────
// Tracks the anchor (where Shift-selection started) and focus (cursor)
// indices per pane so Shift+Arrow extends correctly.
const _kbSelectionState = new Map<string, { anchor: number; focus: number }>();

export const sftpKeyboardSelectionStore = {
  get: (paneId: string) => _kbSelectionState.get(paneId) ?? { anchor: 0, focus: 0 },
  set: (paneId: string, anchor: number, focus: number) => {
    _kbSelectionState.set(paneId, { anchor, focus });
  },
  clear: (paneId: string) => {
    _kbSelectionState.delete(paneId);
  },
};

// Basic navigation keys that work even when custom hotkeys are disabled.
const BASIC_NAV_KEYS: Record<string, string> = {
  'Enter': 'sftpOpen',
  'Backspace': 'sftpGoParent',
};

const isEditableShortcutTarget = (target: HTMLElement): boolean =>
  target.tagName === "INPUT" ||
  target.tagName === "TEXTAREA" ||
  target.isContentEditable ||
  !!target.closest?.(".monaco-editor, .monaco-diff-editor, .monaco-inputbox");

const hasOpenDialog = (): boolean =>
  !!document.querySelector('[role="dialog"][data-state="open"]');

interface UseSftpKeyboardShortcutsParams {
  keyBindings: KeyBinding[];
  hotkeyScheme: "disabled" | "mac" | "pc";
  sftpRef: MutableRefObject<SftpStateApi>;
  dialogActionScopeId: string;
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
  dialogActionScopeId,
  isActive,
}: UseSftpKeyboardShortcutsParams) => {
  const typeaheadRef = useRef<{ paneId: string; state: SftpTypeaheadState } | null>(null);

  const getFocusedPane = useCallback(() => {
    const sftp = sftpRef.current;
    const focusedSide = sftpFocusStore.getFocusedSide();
    const pane = focusedSide === "left"
      ? sftp.leftTabs.tabs.find(p => p.id === sftp.leftTabs.activeTabId)
      : sftp.rightTabs.tabs.find(p => p.id === sftp.rightTabs.activeTabId);
    return { sftp, focusedSide, pane };
  }, [sftpRef]);

  const getClipboardUploadTarget = useCallback((pane: NonNullable<ReturnType<typeof getFocusedPane>["pane"]>) => {
    const { selectedFileNames, treeSelection } = resolveSftpActiveSelection(
      sftpPaneViewModeStore.get(pane.id),
      Array.from(pane.selectedFiles) as string[],
      sftpTreeSelectionStore.getSelectedItems(pane.id),
    );
    const treeActionSelection = treeSelection.filter((entry) => entry.name !== '..');

    return resolveSftpClipboardUploadTarget({
      currentPath: pane.connection!.currentPath,
      selectedFileNames,
      files: pane.files as SftpFileEntry[],
      treeSelection: treeActionSelection,
    });
  }, []);

  const showUploadResults = useCallback((results: Awaited<ReturnType<SftpStateApi["uploadExternalEntries"]>>) => {
    if (results.some((result) => result.cancelled)) {
      toast.info("Upload cancelled.", "SFTP");
      return;
    }

    const successCount = results.filter((result) => result.success).length;
    const failedFiles = results.filter((result) => !result.success && !result.cancelled);
    if (successCount > 0) {
      toast.success(`Uploaded ${successCount} item${successCount === 1 ? "" : "s"}.`, "SFTP");
    }
    failedFiles.forEach((failed) => {
      const errorMsg = failed.error ? ` - ${failed.error}` : "";
      toast.error(`Upload failed: ${failed.fileName}${errorMsg}`, "SFTP");
    });
  }, []);

  const triggerPathBackedClipboardUpload = useCallback((
    files: ClipboardLocalFile[],
    focusedSide: "left" | "right",
    targetPath: string,
  ) => {
    const sftp = sftpRef.current;
    const uploadFiles = getSupportedClipboardUploadFiles(files);
    if (uploadFiles.length === 0) return;

    const entries = createDropEntriesFromClipboardFiles(uploadFiles);

    sftpClipboardUploadStore.trigger({
      scopeId: dialogActionScopeId,
      side: focusedSide,
      targetPath,
      files: uploadFiles,
      onConfirm: async () => {
        try {
          const results: Awaited<ReturnType<SftpStateApi["uploadExternalEntries"]>> = [];
          const fileEntries: DropEntry[] = [];

          for (const file of uploadFiles) {
            if (file.isDirectory) {
              try {
                const folderResults = await sftp.uploadExternalFolderPath(focusedSide, file.path, targetPath);
                results.push(...folderResults);
              } catch (error) {
                results.push({
                  fileName: file.name,
                  success: false,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            } else {
              fileEntries.push(
                entries.find((entry) => entry.localPath === file.path) ?? {
                  file: null,
                  localPath: file.path,
                  relativePath: file.name,
                  isDirectory: false,
                  size: file.size,
                },
              );
            }
          }

          if (fileEntries.length > 0) {
            const fileResults = await sftp.uploadExternalEntries(focusedSide, fileEntries, { targetPath });
            results.push(...fileResults);
          }

          showUploadResults(results);
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Upload failed.", "SFTP");
        }
      },
    });
  }, [dialogActionScopeId, showUploadResults, sftpRef]);

  const triggerDropEntriesClipboardUpload = useCallback((
    entries: DropEntry[],
    focusedSide: "left" | "right",
    targetPath: string,
  ) => {
    const sftp = sftpRef.current;
    if (entries.length === 0) return;

    const rootNames = new Set<string>();
    const previewFiles: ClipboardLocalFile[] = [];
    for (const entry of entries) {
      const rootName = entry.relativePath.split("/")[0];
      if (rootNames.has(rootName)) continue;
      rootNames.add(rootName);
      previewFiles.push({
        path: entry.localPath ?? entry.relativePath,
        name: rootName,
        isDirectory: entry.isDirectory,
        size: entry.size,
      });
    }

    sftpClipboardUploadStore.trigger({
      scopeId: dialogActionScopeId,
      side: focusedSide,
      targetPath,
      files: previewFiles,
      onConfirm: async () => {
        try {
          const results = await sftp.uploadExternalEntries(focusedSide, entries, { targetPath });
          showUploadResults(results);
        } catch (error) {
          toast.error(error instanceof Error ? error.message : "Upload failed.", "SFTP");
        }
      },
    });
  }, [dialogActionScopeId, showUploadResults, sftpRef]);

  const pasteInternalSftpClipboard = useCallback(async (
    focusedSide: "left" | "right",
    pane: NonNullable<ReturnType<typeof getFocusedPane>["pane"]>,
  ) => {
    const sftp = sftpRef.current;
    const clipboard = sftpClipboardStore.get();
    if (!clipboard || clipboard.files.length === 0) return;

    const isSameConnection = clipboard.sourceSide === focusedSide
      && clipboard.sourceConnectionId === pane.connection!.id;
    if (isSameConnection) {
      toast.info("Paste within the same pane is not supported. Use copy to other pane instead.", "SFTP");
      return;
    }

    const sourceTabs = clipboard.sourceSide === "left" ? sftp.leftTabs.tabs : sftp.rightTabs.tabs;
    const sourcePane = sourceTabs.find((tab) => tab.connection?.id === clipboard.sourceConnectionId);

    if (!sourcePane?.connection) {
      toast.info("Paste source is no longer available.", "SFTP");
      return;
    }

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
  }, [sftpRef]);

  const handlePaste = useCallback(
    (e: ClipboardEvent) => {
      if (!isActive) return;
      if (!isSftpNativeClipboardPasteEnabled(hotkeyScheme, keyBindings)) return;

      const target = e.target as HTMLElement;
      if (isEditableShortcutTarget(target) || hasOpenDialog()) return;

      const hasInternalClipboardFiles = sftpClipboardStore.hasFiles();
      const { focusedSide, pane } = getFocusedPane();
      if (!pane?.connection) return;

      const targetPath = getClipboardUploadTarget(pane);
      const pendingClipboardWrite = pendingSftpSystemClipboardWrite;
      const bridge = netcattyBridge.get();
      const dataTransfer = e.clipboardData;
      const hasClipboardItems = (dataTransfer?.items?.length ?? 0) > 0;
      // webkitGetAsEntry must be invoked synchronously during the paste event.
      const dropEntriesPromise = dataTransfer?.items?.length
        ? extractDropEntries(dataTransfer)
        : null;
      const pastedFileSnapshot = dataTransfer?.files?.length
        ? Array.from(dataTransfer.files).filter((file) => file.name)
        : [];

      if (!hasInternalClipboardFiles && !hasClipboardItems && !bridge?.readClipboardFiles) {
        return;
      }

      const runPaste = async () => {
        if (pendingClipboardWrite && hasInternalClipboardFiles) {
          await pendingClipboardWrite;
          await pasteInternalSftpClipboard(focusedSide, pane);
          return;
        }

        if (bridge?.readClipboardFiles) {
          const clipboardFiles = await bridge.readClipboardFiles();
          if (clipboardFiles.length > 0) {
            triggerPathBackedClipboardUpload(clipboardFiles, focusedSide, targetPath);
            return;
          }
        }

        if (dropEntriesPromise) {
          const entries = await dropEntriesPromise;
          if (entries.length > 0) {
            triggerDropEntriesClipboardUpload(entries, focusedSide, targetPath);
            return;
          }
        }

        if (pastedFileSnapshot.length > 0) {
          const pathBackedFiles: ClipboardLocalFile[] = pastedFileSnapshot
            .map((file) => ({
              path: bridge?.getPathForFile?.(file) || file.name,
              name: file.name,
              isDirectory: false,
              size: file.size,
            }))
            .filter((file) => file.path.includes("/") || file.path.includes("\\"));
          if (pathBackedFiles.length > 0) {
            triggerPathBackedClipboardUpload(pathBackedFiles, focusedSide, targetPath);
            return;
          }
        }

        if (hasInternalClipboardFiles) {
          await pasteInternalSftpClipboard(focusedSide, pane);
        }
      };

      e.preventDefault();
      e.stopPropagation();
      void runPaste();
    },
    [
      getClipboardUploadTarget,
      getFocusedPane,
      hotkeyScheme,
      isActive,
      keyBindings,
      pasteInternalSftpClipboard,
      triggerDropEntriesClipboardUpload,
      triggerPathBackedClipboardUpload,
    ],
  );

  const handleKeyDown = useCallback(
    async (e: KeyboardEvent) => {
      // Basic SFTP keyboard navigation should work whenever the SFTP tab is active,
      // even if the user has disabled global/custom hotkeys.
      if (!isActive) return;

      // Skip if focus is on an input element
      const target = e.target as HTMLElement;
      if (isEditableShortcutTarget(target)) {
        return;
      }

      // Skip when a dialog or overlay is open to prevent SFTP shortcuts from
      // firing while interacting with unrelated dialogs (e.g. settings, confirm).
      if (hasOpenDialog()) {
        return;
      }

      // ── Printable keys: select the first visible name with this prefix ──
      if (
        e.key.length === 1
        && !e.ctrlKey
        && !e.metaKey
        && !e.altKey
        && !e.isComposing
        && !/^\s$/u.test(e.key)
        && !target.closest?.('[role="menu"], [role="listbox"]')
      ) {
        const { sftp, focusedSide, pane } = getFocusedPane();
        if (!pane?.connection) return;

        const source = resolveSftpTypeaheadSource(
          sftpPaneViewModeStore.get(pane.id),
          sftpListOrderStore.getItems(pane.id),
          sftpTreeSelectionStore.getPaneState(pane.id).visibleItems,
        );
        if (source.names.length === 0) return;

        const previous = typeaheadRef.current?.paneId === pane.id
          ? typeaheadRef.current.state
          : null;
        const result = advanceSftpTypeahead(source.names, previous, e.key, Date.now());
        typeaheadRef.current = { paneId: pane.id, state: result.state };

        e.preventDefault();
        e.stopPropagation();
        if (result.matchIndex < 0) return;

        keepOnlyPaneSelections(sftp, { side: focusedSide, tabId: pane.id });
        if (source.kind === 'list') {
          sftp.rangeSelect(focusedSide, [source.names[result.matchIndex]]);
        } else {
          sftpTreeSelectionStore.setSelection(pane.id, [source.items[result.matchIndex].path]);
        }
        sftpKeyboardSelectionStore.set(pane.id, result.matchIndex, result.matchIndex);
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
        const viewMode = sftpPaneViewModeStore.get(pane.id);

        // List view: navigate sorted display files. The explicit view mode is
        // authoritative even when the active list has no visible items.
        const listItems = sftpListOrderStore.getItems(pane.id);
        if (viewMode === 'list') {
          if (listItems.length === 0) return;
          e.preventDefault();
          e.stopPropagation();

          // Resolve current focus position from tracked state, falling back
          // to the actual selection when out of sync (e.g. after mouse click).
          let { anchor: anchorIdx, focus: focusIdx } = sftpKeyboardSelectionStore.get(pane.id);
          const currentSelected = Array.from(pane.selectedFiles) as string[];
          if (currentSelected.length === 0) {
            // No selection: start from before the list so the first arrow press lands on item 0.
            // For Shift+Arrow, anchor at 0 so range selection starts from the first item.
            anchorIdx = e.shiftKey ? 0 : -1;
            focusIdx = -1;
          } else if (!currentSelected.includes(listItems[focusIdx])) {
            // Tracked focus doesn't match actual selection, re-sync
            focusIdx = listItems.indexOf(currentSelected[currentSelected.length - 1]);
            if (focusIdx < 0) focusIdx = 0;
            anchorIdx = focusIdx;
            sftpKeyboardSelectionStore.set(pane.id, anchorIdx, focusIdx);
          }

          let nextIdx = focusIdx + delta;
          if (nextIdx < 0) nextIdx = 0;
          if (nextIdx >= listItems.length) nextIdx = listItems.length - 1;

          keepOnlyPaneSelections(sftp, { side: focusedSide, tabId: pane.id });
          if (e.shiftKey) {
            // Shift+Arrow: extend range from anchor to new focus
            const start = Math.min(anchorIdx, nextIdx);
            const end = Math.max(anchorIdx, nextIdx);
            sftp.rangeSelect(focusedSide, listItems.slice(start, end + 1));
            sftpKeyboardSelectionStore.set(pane.id, anchorIdx, nextIdx);
          } else {
            sftp.rangeSelect(focusedSide, [listItems[nextIdx]]);
            sftpKeyboardSelectionStore.set(pane.id, nextIdx, nextIdx);
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

          // Use tracked state, re-sync if needed
          let { anchor: anchorIdx, focus: focusIdx } = sftpKeyboardSelectionStore.get(pane.id);
          if (currentSelected.length === 0) {
            // No selection: start from before the list so the first arrow press lands on item 0.
            // For Shift+Arrow, anchor at 0 so range selection starts from the first item.
            anchorIdx = e.shiftKey ? 0 : -1;
            focusIdx = -1;
          } else {
            const focusPath = items[focusIdx]?.path;
            if (!focusPath || !treeState.selectedPaths.has(focusPath)) {
              focusIdx = treeState.visibleIndexByPath.get(currentSelected[currentSelected.length - 1]) ?? 0;
              anchorIdx = focusIdx;
              sftpKeyboardSelectionStore.set(pane.id, anchorIdx, focusIdx);
            }
          }

          let nextIdx = focusIdx + delta;
          if (nextIdx < 0) nextIdx = 0;
          if (nextIdx >= items.length) nextIdx = items.length - 1;

          keepOnlyPaneSelections(sftp, { side: focusedSide, tabId: pane.id });
          if (e.shiftKey) {
            const start = Math.min(anchorIdx, nextIdx);
            const end = Math.max(anchorIdx, nextIdx);
            const paths = items.slice(start, end + 1).map(item => item.path);
            sftpTreeSelectionStore.setSelection(pane.id, paths);
            sftpKeyboardSelectionStore.set(pane.id, anchorIdx, nextIdx);
          } else {
            sftpTreeSelectionStore.setSelection(pane.id, [items[nextIdx].path]);
            sftpKeyboardSelectionStore.set(pane.id, nextIdx, nextIdx);
          }
          return;
        }
        return;
      }

      // Basic navigation actions (Enter, Backspace) must work even when
      // custom hotkeys are disabled — they are essential SFTP navigation.
      // When hotkeys are enabled, defer to matchSftpAction so user
      // customizations are respected.
      const basicNavAction = hotkeyScheme === "disabled" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
        ? BASIC_NAV_KEYS[e.key]
        : undefined;

      if (hotkeyScheme === "disabled" && !basicNavAction) return;

      const isMac = hotkeyScheme === "mac";
      const matched = basicNavAction ? null : matchSftpAction(e, keyBindings, isMac);
      if (!matched && !basicNavAction) return;

      const action = basicNavAction ?? matched?.action;
      if (!action || !SFTP_ACTIONS.has(action)) return;

      const matchedKey = isMac ? matched?.binding.mac : matched?.binding.pc;
      if (shouldLetNativePasteEventHandleSftpPaste(action, matchedKey)) {
        return;
      }

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
      const viewMode = sftpPaneViewModeStore.get(pane.id);
      const isTreeView = viewMode === 'tree';
      const treeSelectionState = sftpTreeSelectionStore.getPaneState(pane.id);
      const { selectedFileNames, treeSelection } = resolveSftpActiveSelection(
        viewMode,
        Array.from(pane.selectedFiles) as string[],
        sftpTreeSelectionStore.getSelectedItems(pane.id),
      );
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
            await replaceSystemClipboardWithSftpPaths(getSftpClipboardSystemTextPaths({
              currentPath: pane.connection.currentPath,
              selectedFileNames: [],
              treeSelection: treeActionSelection,
            }));
            break;
          }

          // Copy selected files to clipboard
          if (selectedFileNames.length === 0) return;

          {
            const filesByName = new Map((pane.files as SftpFileEntry[]).map(f => [f.name, f]));
            const clipboardFiles: SftpClipboardFile[] = selectedFileNames.map((name: string) => {
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
            await replaceSystemClipboardWithSftpPaths(getSftpClipboardSystemTextPaths({
              currentPath: pane.connection.currentPath,
              selectedFileNames,
              treeSelection: [],
            }));
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
            await replaceSystemClipboardWithSftpPaths(getSftpClipboardSystemTextPaths({
              currentPath: pane.connection.currentPath,
              selectedFileNames: [],
              treeSelection: treeActionSelection,
            }));
            break;
          }

          // Cut selected files to clipboard
          if (selectedFileNames.length === 0) return;

          {
            const filesByName = new Map((pane.files as SftpFileEntry[]).map(f => [f.name, f]));
            const clipboardFiles: SftpClipboardFile[] = selectedFileNames.map((name: string) => {
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
            await replaceSystemClipboardWithSftpPaths(getSftpClipboardSystemTextPaths({
              currentPath: pane.connection.currentPath,
              selectedFileNames,
              treeSelection: [],
            }));
          }
          break;
        }

        case "sftpPaste": {
          await pasteInternalSftpClipboard(focusedSide, pane);
          break;
        }

        case "sftpSelectAll": {
          const selectAllTarget = resolveSftpSelectAllTarget(
            viewMode,
            treeSelectionState.visibleItems.length,
          );
          if (selectAllTarget === 'none') break;
          if (selectAllTarget === 'tree') {
            keepOnlyPaneSelections(sftp, { side: focusedSide, tabId: pane.id });
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
          keepOnlyPaneSelections(sftp, { side: focusedSide, tabId: pane.id });
          sftp.rangeSelect(focusedSide, allFileNames);
          break;
        }

        case "sftpRename": {
          if (treeActionSelection.length === 1) {
            sftpDialogActionStore.trigger("rename", dialogActionScopeId, [treeActionSelection[0].path]);
            break;
          }

          // Trigger rename for the first selected file
          if (selectedFileNames.length !== 1) return;
          sftpDialogActionStore.trigger("rename", dialogActionScopeId, selectedFileNames);
          break;
        }

        case "sftpDelete": {
          if (treeActionSelection.length > 0) {
            sftpDialogActionStore.trigger(
              "delete",
              dialogActionScopeId,
              treeActionSelection.map((entry) => entry.path),
            );
            break;
          }

          // Delete selected files
          if (selectedFileNames.length === 0) return;
          sftpDialogActionStore.trigger("delete", dialogActionScopeId, selectedFileNames);
          break;
        }

        case "sftpRefresh": {
          // Refresh the current pane
          sftp.refresh(focusedSide);
          break;
        }

        case "sftpNewFolder": {
          // Create new folder
          sftpDialogActionStore.trigger("newFolder", dialogActionScopeId);
          break;
        }

        case "sftpOpen": {
          if (!isTreeView && selectedFileNames.length === 1) {
            const fileName = selectedFileNames[0];
            const entry = (pane.files as SftpFileEntry[]).find(f => f.name === fileName);
            if (entry) {
              if (isNavigableDirectory(entry)) {
                _kbSelectionState.delete(pane.id);
                sftp.navigateTo(focusedSide, joinPath(pane.connection.currentPath, entry.name));
              } else {
                sftp.openEntry(focusedSide, entry);
              }
            }
            break;
          }

          if (!isTreeView) break;
          if (treeActionSelection.length === 1) {
            const item = treeActionSelection[0];
            if (item.isDirectory) _kbSelectionState.delete(pane.id);
            sftpTreeEnterStore.trigger(pane.id, item.path, item.isDirectory);
          }
          break;
        }

        case "sftpGoParent": {
          const parentPath = getParentPath(pane.connection.currentPath);
          if (parentPath !== pane.connection.currentPath) {
            _kbSelectionState.delete(pane.id);
            sftp.navigateTo(focusedSide, parentPath);
          }
          break;
        }

        case "sftpNavigateTo": {
          // Navigate to the selected directory (useful in tree view)
          // Filter out ".." entry for consistency with other handlers
          if (treeActionSelection.length === 1 && treeActionSelection[0].isDirectory) {
            _kbSelectionState.delete(pane.id);
            sftp.navigateTo(focusedSide, treeActionSelection[0].path);
            break;
          }
          // In list view, navigate to selected directory
          if (selectedFileNames.length === 1) {
            const entry = (pane.files as SftpFileEntry[]).find(f => f.name === selectedFileNames[0]);
            if (entry && isNavigableDirectory(entry)) {
              _kbSelectionState.delete(pane.id);
              sftp.navigateTo(focusedSide, joinPath(pane.connection.currentPath, entry.name));
            }
          }
          break;
        }
      }
    },
    [dialogActionScopeId, getFocusedPane, hotkeyScheme, isActive, keyBindings, pasteInternalSftpClipboard, sftpRef]
  );

  useEffect(() => {
    if (!isActive) return;
    // Use capture phase to intercept before other handlers
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [handleKeyDown, isActive]);

  useEffect(() => {
    if (!isActive) return;
    window.addEventListener("paste", handlePaste, true);
    return () => window.removeEventListener("paste", handlePaste, true);
  }, [handlePaste, isActive]);
};
