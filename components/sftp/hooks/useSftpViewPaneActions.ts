import { useCallback, useMemo, useState } from "react";
import type { MutableRefObject } from "react";
import type { SftpStateApi } from "../../../application/state/useSftpState";
import type { SftpDragCallbacks, SftpTransferSource } from "../SftpContext";
import { keepOnlyActivePaneSelections } from "./selectionScope";
import { editorTabStore } from "../../../application/state/editorTabStore";
import type { EditorTab, EditorTabId } from "../../../application/state/editorTabStore";
import { promptUnsavedChanges } from "../../editor/UnsavedChangesDialog";

interface UseSftpViewPaneActionsParams {
  sftpRef: MutableRefObject<SftpStateApi>;
}

interface UseSftpViewPaneActionsResult {
  dragCallbacks: SftpDragCallbacks;
  draggedFiles: (SftpTransferSource & { side: "left" | "right" })[] | null;
  onConnectLeft: (host: Parameters<SftpStateApi["connect"]>[1]) => void;
  onConnectRight: (host: Parameters<SftpStateApi["connect"]>[1]) => void;
  onDisconnectLeft: () => Promise<void>;
  onDisconnectRight: () => Promise<void>;
  onPrepareSelectionLeft: () => void;
  onPrepareSelectionRight: () => void;
  onNavigateToLeft: (path: string) => void;
  onNavigateToRight: (path: string) => void;
  onNavigateUpLeft: () => void;
  onNavigateUpRight: () => void;
  onRefreshLeft: () => void;
  onRefreshRight: () => void;
  onRefreshTabLeft: (tabId: string) => void;
  onRefreshTabRight: (tabId: string) => void;
  onSetFilenameEncodingLeft: (encoding: Parameters<SftpStateApi["setFilenameEncoding"]>[1]) => void;
  onSetFilenameEncodingRight: (encoding: Parameters<SftpStateApi["setFilenameEncoding"]>[1]) => void;
  onToggleSelectionLeft: (name: string, multi: boolean) => void;
  onToggleSelectionRight: (name: string, multi: boolean) => void;
  onRangeSelectLeft: (fileNames: string[]) => void;
  onRangeSelectRight: (fileNames: string[]) => void;
  onClearSelectionLeft: () => void;
  onClearSelectionRight: () => void;
  onSetFilterLeft: (filter: string) => void;
  onSetFilterRight: (filter: string) => void;
  onCreateDirectoryLeft: (name: string) => void;
  onCreateDirectoryRight: (name: string) => void;
  onCreateDirectoryAtPathLeft: (path: string, name: string) => void;
  onCreateDirectoryAtPathRight: (path: string, name: string) => void;
  onCreateFileLeft: (name: string) => void;
  onCreateFileRight: (name: string) => void;
  onCreateFileAtPathLeft: (path: string, name: string) => void;
  onCreateFileAtPathRight: (path: string, name: string) => void;
  onDeleteFilesLeft: (names: string[]) => void;
  onDeleteFilesRight: (names: string[]) => void;
  onDeleteFilesAtPathLeft: (connectionId: string, path: string, names: string[]) => void;
  onDeleteFilesAtPathRight: (connectionId: string, path: string, names: string[]) => void;
  onRenameFileLeft: (old: string, newName: string) => void;
  onRenameFileRight: (old: string, newName: string) => void;
  onRenameFileAtPathLeft: (oldPath: string, newName: string) => void;
  onRenameFileAtPathRight: (oldPath: string, newName: string) => void;
  onMoveEntriesToPathLeft: (sourcePaths: string[], targetPath: string) => void;
  onMoveEntriesToPathRight: (sourcePaths: string[], targetPath: string) => void;
  onCopyToOtherPaneLeft: (files: SftpTransferSource[]) => void;
  onCopyToOtherPaneRight: (files: SftpTransferSource[]) => void;
  onReceiveFromOtherPaneLeft: (files: SftpTransferSource[]) => void;
  onReceiveFromOtherPaneRight: (files: SftpTransferSource[]) => void;
}

export const useSftpViewPaneActions = ({
  sftpRef,
}: UseSftpViewPaneActionsParams): UseSftpViewPaneActionsResult => {
  const [draggedFiles, setDraggedFiles] = useState<
    (SftpTransferSource & { side: "left" | "right" })[] | null
  >(null);

  const handleDragStart = useCallback(
    (
      files: SftpTransferSource[],
      side: "left" | "right",
    ) => {
      setDraggedFiles(files.map((f) => ({ ...f, side })));
    },
    [],
  );

  const handleDragEnd = useCallback(() => {
    setDraggedFiles(null);
  }, []);

  const startGroupedTransfer = useCallback(
    (files: SftpTransferSource[], sourceSide: "left" | "right", targetSide: "left" | "right") => {
      const groups = new Map<string, SftpTransferSource[]>();
      for (const file of files) {
        const key = `${file.sourceConnectionId ?? ""}::${file.sourcePath ?? ""}`;
        const group = groups.get(key) ?? [];
        group.push(file);
        groups.set(key, group);
      }

      for (const group of groups.values()) {
        const [{ sourceConnectionId, sourcePath, targetPath }] = group;
        void sftpRef.current.startTransfer(group, sourceSide, targetSide, {
          sourceConnectionId,
          sourcePath,
          targetPath,
        });
      }
    },
    [sftpRef],
  );

  const onCopyToOtherPaneLeft = useCallback(
    (files: SftpTransferSource[]) => startGroupedTransfer(files, "left", "right"),
    [startGroupedTransfer],
  );
  const onCopyToOtherPaneRight = useCallback(
    (files: SftpTransferSource[]) => startGroupedTransfer(files, "right", "left"),
    [startGroupedTransfer],
  );
  const onReceiveFromOtherPaneLeft = useCallback(
    (files: SftpTransferSource[]) => startGroupedTransfer(files, "right", "left"),
    [startGroupedTransfer],
  );
  const onReceiveFromOtherPaneRight = useCallback(
    (files: SftpTransferSource[]) => startGroupedTransfer(files, "left", "right"),
    [startGroupedTransfer],
  );

  const onConnectLeft = useCallback(
    (host: Parameters<SftpStateApi["connect"]>[1]) => sftpRef.current.connect("left", host),
    [sftpRef],
  );
  const onConnectRight = useCallback(
    (host: Parameters<SftpStateApi["connect"]>[1]) => sftpRef.current.connect("right", host),
    [sftpRef],
  );
  const onDisconnectLeft = useCallback(async () => {
    const connectionId = sftpRef.current.getActivePane("left")?.connection?.id;
    if (connectionId) {
      const choice = (tab: EditorTab) => promptUnsavedChanges(tab.fileName);
      const saveTab = async (id: EditorTabId) => {
        const tab = editorTabStore.getTab(id);
        if (!tab) return;
        await sftpRef.current.writeTextFileByConnection(tab.sessionId, tab.hostId, tab.remotePath, tab.content);
        editorTabStore.markSaved(id, tab.content);
      };
      const ok = await editorTabStore.confirmCloseBySession(connectionId, choice, saveTab);
      if (!ok) return;
    }
    sftpRef.current.disconnect("left");
  }, [sftpRef]);
  const onDisconnectRight = useCallback(async () => {
    const connectionId = sftpRef.current.getActivePane("right")?.connection?.id;
    if (connectionId) {
      const choice = (tab: EditorTab) => promptUnsavedChanges(tab.fileName);
      const saveTab = async (id: EditorTabId) => {
        const tab = editorTabStore.getTab(id);
        if (!tab) return;
        await sftpRef.current.writeTextFileByConnection(tab.sessionId, tab.hostId, tab.remotePath, tab.content);
        editorTabStore.markSaved(id, tab.content);
      };
      const ok = await editorTabStore.confirmCloseBySession(connectionId, choice, saveTab);
      if (!ok) return;
    }
    sftpRef.current.disconnect("right");
  }, [sftpRef]);
  const onPrepareSelectionLeft = useCallback(() => {
    keepOnlyActivePaneSelections(sftpRef.current, "left");
  }, [sftpRef]);
  const onPrepareSelectionRight = useCallback(() => {
    keepOnlyActivePaneSelections(sftpRef.current, "right");
  }, [sftpRef]);
  const onNavigateToLeft = useCallback(
    (path: string) => sftpRef.current.navigateTo("left", path),
    [sftpRef],
  );
  const onNavigateToRight = useCallback(
    (path: string) => sftpRef.current.navigateTo("right", path),
    [sftpRef],
  );
  const onNavigateUpLeft = useCallback(() => sftpRef.current.navigateUp("left"), [sftpRef]);
  const onNavigateUpRight = useCallback(() => sftpRef.current.navigateUp("right"), [sftpRef]);
  const onRefreshLeft = useCallback(() => sftpRef.current.refresh("left"), [sftpRef]);
  const onRefreshRight = useCallback(() => sftpRef.current.refresh("right"), [sftpRef]);
  const onRefreshTabLeft = useCallback((tabId: string) => sftpRef.current.refresh("left", { tabId }), [sftpRef]);
  const onRefreshTabRight = useCallback((tabId: string) => sftpRef.current.refresh("right", { tabId }), [sftpRef]);
  const onSetFilenameEncodingLeft = useCallback(
    (encoding: Parameters<SftpStateApi["setFilenameEncoding"]>[1]) =>
      sftpRef.current.setFilenameEncoding("left", encoding),
    [sftpRef],
  );
  const onSetFilenameEncodingRight = useCallback(
    (encoding: Parameters<SftpStateApi["setFilenameEncoding"]>[1]) =>
      sftpRef.current.setFilenameEncoding("right", encoding),
    [sftpRef],
  );
  const onToggleSelectionLeft = useCallback(
    (name: string, multi: boolean) => {
      onPrepareSelectionLeft();
      sftpRef.current.toggleSelection("left", name, multi);
    },
    [onPrepareSelectionLeft, sftpRef],
  );
  const onToggleSelectionRight = useCallback(
    (name: string, multi: boolean) => {
      onPrepareSelectionRight();
      sftpRef.current.toggleSelection("right", name, multi);
    },
    [onPrepareSelectionRight, sftpRef],
  );
  const onRangeSelectLeft = useCallback(
    (fileNames: string[]) => {
      onPrepareSelectionLeft();
      sftpRef.current.rangeSelect("left", fileNames);
    },
    [onPrepareSelectionLeft, sftpRef],
  );
  const onRangeSelectRight = useCallback(
    (fileNames: string[]) => {
      onPrepareSelectionRight();
      sftpRef.current.rangeSelect("right", fileNames);
    },
    [onPrepareSelectionRight, sftpRef],
  );
  const onClearSelectionLeft = useCallback(() => sftpRef.current.clearSelection("left"), [sftpRef]);
  const onClearSelectionRight = useCallback(() => sftpRef.current.clearSelection("right"), [sftpRef]);
  const onSetFilterLeft = useCallback(
    (filter: string) => sftpRef.current.setFilter("left", filter),
    [sftpRef],
  );
  const onSetFilterRight = useCallback(
    (filter: string) => sftpRef.current.setFilter("right", filter),
    [sftpRef],
  );
  const onCreateDirectoryLeft = useCallback(
    (name: string) => sftpRef.current.createDirectory("left", name),
    [sftpRef],
  );
  const onCreateDirectoryRight = useCallback(
    (name: string) => sftpRef.current.createDirectory("right", name),
    [sftpRef],
  );
  const onCreateDirectoryAtPathLeft = useCallback(
    (path: string, name: string) => sftpRef.current.createDirectoryAtPath("left", path, name),
    [sftpRef],
  );
  const onCreateDirectoryAtPathRight = useCallback(
    (path: string, name: string) => sftpRef.current.createDirectoryAtPath("right", path, name),
    [sftpRef],
  );
  const onCreateFileLeft = useCallback(
    (name: string) => sftpRef.current.createFile("left", name),
    [sftpRef],
  );
  const onCreateFileRight = useCallback(
    (name: string) => sftpRef.current.createFile("right", name),
    [sftpRef],
  );
  const onCreateFileAtPathLeft = useCallback(
    (path: string, name: string) => sftpRef.current.createFileAtPath("left", path, name),
    [sftpRef],
  );
  const onCreateFileAtPathRight = useCallback(
    (path: string, name: string) => sftpRef.current.createFileAtPath("right", path, name),
    [sftpRef],
  );
  const onDeleteFilesLeft = useCallback(
    (names: string[]) => sftpRef.current.deleteFiles("left", names),
    [sftpRef],
  );
  const onDeleteFilesRight = useCallback(
    (names: string[]) => sftpRef.current.deleteFiles("right", names),
    [sftpRef],
  );
  const onDeleteFilesAtPathLeft = useCallback(
    (connectionId: string, path: string, names: string[]) =>
      sftpRef.current.deleteFilesAtPath("left", connectionId, path, names),
    [sftpRef],
  );
  const onDeleteFilesAtPathRight = useCallback(
    (connectionId: string, path: string, names: string[]) =>
      sftpRef.current.deleteFilesAtPath("right", connectionId, path, names),
    [sftpRef],
  );
  const onRenameFileLeft = useCallback(
    (old: string, newName: string) => sftpRef.current.renameFile("left", old, newName),
    [sftpRef],
  );
  const onRenameFileRight = useCallback(
    (old: string, newName: string) => sftpRef.current.renameFile("right", old, newName),
    [sftpRef],
  );
  const onRenameFileAtPathLeft = useCallback(
    (oldPath: string, newName: string) => sftpRef.current.renameFileAtPath("left", oldPath, newName),
    [sftpRef],
  );
  const onRenameFileAtPathRight = useCallback(
    (oldPath: string, newName: string) => sftpRef.current.renameFileAtPath("right", oldPath, newName),
    [sftpRef],
  );
  const onMoveEntriesToPathLeft = useCallback(
    (sourcePaths: string[], targetPath: string) => sftpRef.current.moveEntriesToPath("left", sourcePaths, targetPath),
    [sftpRef],
  );
  const onMoveEntriesToPathRight = useCallback(
    (sourcePaths: string[], targetPath: string) => sftpRef.current.moveEntriesToPath("right", sourcePaths, targetPath),
    [sftpRef],
  );

  const dragCallbacks = useMemo<SftpDragCallbacks>(
    () => ({
      onDragStart: handleDragStart,
      onDragEnd: handleDragEnd,
    }),
    [handleDragStart, handleDragEnd],
  );

  return {
    dragCallbacks,
    draggedFiles,
    onConnectLeft,
    onConnectRight,
    onDisconnectLeft,
    onDisconnectRight,
    onPrepareSelectionLeft,
    onPrepareSelectionRight,
    onNavigateToLeft,
    onNavigateToRight,
    onNavigateUpLeft,
    onNavigateUpRight,
    onRefreshLeft,
    onRefreshRight,
    onRefreshTabLeft,
    onRefreshTabRight,
    onSetFilenameEncodingLeft,
    onSetFilenameEncodingRight,
    onToggleSelectionLeft,
    onToggleSelectionRight,
    onRangeSelectLeft,
    onRangeSelectRight,
    onClearSelectionLeft,
    onClearSelectionRight,
    onSetFilterLeft,
    onSetFilterRight,
    onCreateDirectoryLeft,
    onCreateDirectoryRight,
    onCreateDirectoryAtPathLeft,
    onCreateDirectoryAtPathRight,
    onCreateFileLeft,
    onCreateFileRight,
    onCreateFileAtPathLeft,
    onCreateFileAtPathRight,
    onDeleteFilesLeft,
    onDeleteFilesRight,
    onDeleteFilesAtPathLeft,
    onDeleteFilesAtPathRight,
    onRenameFileLeft,
    onRenameFileRight,
    onRenameFileAtPathLeft,
    onRenameFileAtPathRight,
    onMoveEntriesToPathLeft,
    onMoveEntriesToPathRight,
    onCopyToOtherPaneLeft,
    onCopyToOtherPaneRight,
    onReceiveFromOtherPaneLeft,
    onReceiveFromOtherPaneRight,
  };
};
