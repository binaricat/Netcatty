import { useCallback, useRef, useState } from "react";
import type { SftpPaneCallbacks } from "../SftpContext";
import type { SftpPane } from "../../../application/state/sftp/types";
import { getFileName, getParentPath } from "../../../application/state/sftp/utils";
import { logger } from "../../../lib/logger";

const INVALID_FILENAME_CHARS = /[/\\:*?"<>|]/;
const RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

interface UseSftpPaneDialogsParams {
  t: (key: string, params?: Record<string, unknown>) => string;
  pane: SftpPane;
  onCreateDirectory: SftpPaneCallbacks["onCreateDirectory"];
  onCreateDirectoryAtPath: SftpPaneCallbacks["onCreateDirectoryAtPath"];
  onCreateFile: SftpPaneCallbacks["onCreateFile"];
  onCreateFileAtPath: SftpPaneCallbacks["onCreateFileAtPath"];
  onRenameFileAtPath: SftpPaneCallbacks["onRenameFileAtPath"];
  onDeleteFilesAtPath: SftpPaneCallbacks["onDeleteFilesAtPath"];
  onClearSelection: SftpPaneCallbacks["onClearSelection"];
  onMutateSuccess?: (paths?: string[]) => void;
}

interface UseSftpPaneDialogsResult {
  showHostPicker: boolean;
  hostSearch: string;
  showNewFolderDialog: boolean;
  newFolderName: string;
  showNewFileDialog: boolean;
  newFileName: string;
  fileNameError: string | null;
  showOverwriteConfirm: boolean;
  overwriteTarget: string | null;
  showRenameDialog: boolean;
  renameTarget: string | null;
  renameName: string;
  showDeleteConfirm: boolean;
  deleteTargets: string[];
  isCreating: boolean;
  isCreatingFile: boolean;
  isRenaming: boolean;
  isDeleting: boolean;
  setShowHostPicker: (open: boolean) => void;
  setHostSearch: (value: string) => void;
  setShowNewFolderDialog: (open: boolean) => void;
  setNewFolderName: (value: string) => void;
  setShowNewFileDialog: (open: boolean) => void;
  setNewFileName: (value: string) => void;
  setFileNameError: (value: string | null) => void;
  setShowOverwriteConfirm: (open: boolean) => void;
  setShowRenameDialog: (open: boolean) => void;
  setRenameName: (value: string) => void;
  setShowDeleteConfirm: (open: boolean) => void;
  handleCreateFolder: () => Promise<void>;
  handleCreateFile: (forceOverwrite?: boolean) => Promise<void>;
  handleConfirmOverwrite: () => Promise<void>;
  handleRename: () => Promise<void>;
  handleDelete: () => Promise<void>;
  openNewFolderDialogAtPath: (path: string) => void;
  openNewFileDialogAtPath: (path: string) => void;
  openRenameDialog: (name: string) => void;
  openDeleteConfirm: (names: string[]) => void;
  getNextUntitledName: (existingFiles: string[]) => string;
}

export const useSftpPaneDialogs = ({
  t,
  pane,
  onCreateDirectory,
  onCreateDirectoryAtPath,
  onCreateFile,
  onCreateFileAtPath,
  onRenameFileAtPath,
  onDeleteFilesAtPath,
  onClearSelection,
  onMutateSuccess,
}: UseSftpPaneDialogsParams): UseSftpPaneDialogsResult => {
  const [showHostPicker, setShowHostPicker] = useState(false);
  const [hostSearch, setHostSearch] = useState("");
  const [showNewFolderDialogState, setShowNewFolderDialogState] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFileDialogState, setShowNewFileDialogState] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [createTargetPath, setCreateTargetPath] = useState<string | null>(null);
  const [fileNameError, setFileNameError] = useState<string | null>(null);
  const [showOverwriteConfirm, setShowOverwriteConfirm] = useState(false);
  const [overwriteTarget, setOverwriteTarget] = useState<string | null>(null);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<string[]>([]);
  const [isCreating, setIsCreating] = useState(false);
  const [isCreatingFile, setIsCreatingFile] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Refs for values accessed inside useCallback to avoid stale closures
  const newFolderNameRef = useRef(newFolderName);
  newFolderNameRef.current = newFolderName;
  const newFileNameRef = useRef(newFileName);
  newFileNameRef.current = newFileName;
  const createTargetPathRef = useRef(createTargetPath);
  createTargetPathRef.current = createTargetPath;
  const renameTargetRef = useRef(renameTarget);
  renameTargetRef.current = renameTarget;
  const renameNameRef = useRef(renameName);
  renameNameRef.current = renameName;
  const deleteTargetsRef = useRef(deleteTargets);
  deleteTargetsRef.current = deleteTargets;
  const paneRef = useRef(pane);
  paneRef.current = pane;

  const validateFileName = useCallback(
    (name: string): string | null => {
      const trimmed = name.trim();
      if (!trimmed) return null;

      const invalidMatch = trimmed.match(INVALID_FILENAME_CHARS);
      if (invalidMatch) {
        return t("sftp.error.invalidFileName", { chars: invalidMatch[0] });
      }

      const baseName = trimmed.split(".")[0].toUpperCase();
      if (RESERVED_NAMES.has(baseName)) {
        return t("sftp.error.reservedName");
      }

      return null;
    },
    [t],
  );

  const getNextUntitledName = useCallback((existingFiles: string[]): string => {
    const existingSet = new Set(existingFiles.map((f) => f.toLowerCase()));

    if (!existingSet.has("untitled.txt")) {
      return "untitled.txt";
    }

    let counter = 1;
    while (counter < 1000) {
      const name = `untitled (${counter}).txt`;
      if (!existingSet.has(name.toLowerCase())) {
        return name;
      }
      counter++;
    }

    return `untitled_${Date.now()}.txt`;
  }, []);

  const handleCreateFolder = useCallback(async () => {
    if (!newFolderNameRef.current.trim() || isCreating) return;
    setIsCreating(true);
    try {
      if (createTargetPathRef.current) {
        await onCreateDirectoryAtPath(createTargetPathRef.current, newFolderNameRef.current.trim());
      } else {
        await onCreateDirectory(newFolderNameRef.current.trim());
      }
      const affectedPath = createTargetPathRef.current ?? paneRef.current.connection?.currentPath;
      onMutateSuccess?.(affectedPath ? [affectedPath] : undefined);
      setShowNewFolderDialogState(false);
      setCreateTargetPath(null);
      setNewFolderName("");
    } catch (err) {
      logger.warn("Failed to create folder", err);
    } finally {
      setIsCreating(false);
    }
  }, [isCreating, onCreateDirectory, onCreateDirectoryAtPath, onMutateSuccess]);

  const handleCreateFile = useCallback(async (forceOverwrite = false) => {
    const trimmedName = newFileNameRef.current.trim();
    if (!trimmedName || isCreatingFile) return;

    const error = validateFileName(trimmedName);
    if (error) {
      setFileNameError(error);
      return;
    }

    const currentPane = paneRef.current;
    if (!forceOverwrite && (!createTargetPathRef.current || createTargetPathRef.current === currentPane.connection?.currentPath)) {
      const existingFile = currentPane.files.find(
        (f) =>
          f.name.toLowerCase() === trimmedName.toLowerCase() && f.type === "file",
      );
      if (existingFile) {
        setOverwriteTarget(trimmedName);
        setShowOverwriteConfirm(true);
        return;
      }
    }

    setIsCreatingFile(true);
    try {
      if (createTargetPathRef.current) {
        await onCreateFileAtPath(createTargetPathRef.current, trimmedName);
      } else {
        await onCreateFile(trimmedName);
      }
      const affectedPath = createTargetPathRef.current ?? paneRef.current.connection?.currentPath;
      onMutateSuccess?.(affectedPath ? [affectedPath] : undefined);
      setShowNewFileDialogState(false);
      setShowOverwriteConfirm(false);
      setOverwriteTarget(null);
      setCreateTargetPath(null);
      setNewFileName("");
      setFileNameError(null);
    } catch (err) {
      logger.warn("Failed to create file", err);
    } finally {
      setIsCreatingFile(false);
    }
  }, [isCreatingFile, validateFileName, onCreateFile, onCreateFileAtPath, onMutateSuccess]);

  const handleConfirmOverwrite = useCallback(async () => {
    await handleCreateFile(true);
  }, [handleCreateFile]);

  const handleRename = useCallback(async () => {
    if (!renameTargetRef.current || !renameNameRef.current.trim() || isRenaming) return;
    setIsRenaming(true);
    try {
      // renameTarget is always a full path; use the path-aware variant
      await onRenameFileAtPath(renameTargetRef.current, renameNameRef.current.trim());
      onMutateSuccess?.([getParentPath(renameTargetRef.current)]);
      setShowRenameDialog(false);
      setRenameTarget(null);
      setRenameName("");
    } catch (err) {
      logger.warn("Failed to rename file", err);
    } finally {
      setIsRenaming(false);
    }
  }, [isRenaming, onRenameFileAtPath, onMutateSuccess]);

  const handleDelete = useCallback(async () => {
    if (deleteTargetsRef.current.length === 0 || isDeleting) return;
    setIsDeleting(true);
    try {
      // deleteTargets are full paths; group by parent dir and use path-aware variant
      const byDir = new Map<string, string[]>();
      for (const fullPath of deleteTargetsRef.current) {
        const dir = getParentPath(fullPath);
        const name = getFileName(fullPath);
        const list = byDir.get(dir) ?? [];
        list.push(name);
        byDir.set(dir, list);
      }
      const connectionId = paneRef.current.connection?.id;
      if (!connectionId) {
        throw new Error("Pane connection is no longer available");
      }
      for (const [dir, names] of byDir) {
        await onDeleteFilesAtPath(connectionId, dir, names);
      }
      onMutateSuccess?.(Array.from(byDir.keys()));
      setShowDeleteConfirm(false);
      setDeleteTargets([]);
      onClearSelection();
    } catch (err) {
      logger.warn("Failed to delete files", err);
    } finally {
      setIsDeleting(false);
    }
  }, [isDeleting, onDeleteFilesAtPath, onMutateSuccess, onClearSelection]);

  // entryPath is the full path; renameName is initialized to the basename
  const openRenameDialog = useCallback((entryPath: string) => {
    setRenameTarget(entryPath);
    setRenameName(getFileName(entryPath) || entryPath);
    setShowRenameDialog(true);
  }, []);

  const setShowNewFolderDialog = useCallback((open: boolean) => {
    if (!open) {
      setCreateTargetPath(null);
    }
    setShowNewFolderDialogState(open);
  }, []);

  const setShowNewFileDialog = useCallback((open: boolean) => {
    if (!open) {
      setCreateTargetPath(null);
    }
    setShowNewFileDialogState(open);
  }, []);

  const openNewFolderDialogAtPath = useCallback((path: string) => {
    setCreateTargetPath(path);
    setNewFolderName("");
    setShowNewFolderDialogState(true);
  }, []);

  const openNewFileDialogAtPath = useCallback((path: string) => {
    setCreateTargetPath(path);
    setNewFileName("");
    setFileNameError(null);
    setShowNewFileDialogState(true);
  }, []);

  const openDeleteConfirm = useCallback((names: string[]) => {
    setDeleteTargets(names);
    setShowDeleteConfirm(true);
  }, []);

  return {
    showHostPicker,
    hostSearch,
    showNewFolderDialog: showNewFolderDialogState,
    newFolderName,
    showNewFileDialog: showNewFileDialogState,
    newFileName,
    fileNameError,
    showOverwriteConfirm,
    overwriteTarget,
    showRenameDialog,
    renameTarget,
    renameName,
    showDeleteConfirm,
    deleteTargets,
    isCreating,
    isCreatingFile,
    isRenaming,
    isDeleting,
    setShowHostPicker,
    setHostSearch,
    setShowNewFolderDialog,
    setNewFolderName,
    setShowNewFileDialog,
    setNewFileName,
    setFileNameError,
    setShowOverwriteConfirm,
    setShowRenameDialog,
    setRenameName,
    setShowDeleteConfirm,
    handleCreateFolder,
    handleCreateFile,
    handleConfirmOverwrite,
    handleRename,
    handleDelete,
    openNewFolderDialogAtPath,
    openNewFileDialogAtPath,
    openRenameDialog,
    openDeleteConfirm,
    getNextUntitledName,
  };
};
