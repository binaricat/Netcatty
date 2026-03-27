import { useCallback, useState } from "react";
import type { SftpPaneCallbacks } from "../SftpContext";
import type { SftpPane } from "../../../application/state/sftp/types";
import { getFileName } from "../../../application/state/sftp/utils";

interface UseSftpPaneDialogsParams {
  t: (key: string, params?: Record<string, unknown>) => string;
  pane: SftpPane;
  onCreateDirectory: SftpPaneCallbacks["onCreateDirectory"];
  onCreateFile: SftpPaneCallbacks["onCreateFile"];
  onRenameFileAtPath: SftpPaneCallbacks["onRenameFileAtPath"];
  onDeleteFilesAtPath: SftpPaneCallbacks["onDeleteFilesAtPath"];
  onClearSelection: SftpPaneCallbacks["onClearSelection"];
  onMutateSuccess?: () => void;
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
  openRenameDialog: (name: string) => void;
  openDeleteConfirm: (names: string[]) => void;
  getNextUntitledName: (existingFiles: string[]) => string;
}

export const useSftpPaneDialogs = ({
  t,
  pane,
  onCreateDirectory,
  onCreateFile,
  onRenameFileAtPath,
  onDeleteFilesAtPath,
  onClearSelection,
  onMutateSuccess,
}: UseSftpPaneDialogsParams): UseSftpPaneDialogsResult => {
  const [showHostPicker, setShowHostPicker] = useState(false);
  const [hostSearch, setHostSearch] = useState("");
  const [showNewFolderDialog, setShowNewFolderDialog] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [showNewFileDialog, setShowNewFileDialog] = useState(false);
  const [newFileName, setNewFileName] = useState("");
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

  const validateFileName = useCallback(
    (name: string): string | null => {
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

  const handleCreateFolder = async () => {
    if (!newFolderName.trim() || isCreating) return;
    setIsCreating(true);
    try {
      await onCreateDirectory(newFolderName.trim());
      onMutateSuccess?.();
      setShowNewFolderDialog(false);
      setNewFolderName("");
    } catch {
      /* Error handling */
    } finally {
      setIsCreating(false);
    }
  };

  const handleCreateFile = async (forceOverwrite = false) => {
    const trimmedName = newFileName.trim();
    if (!trimmedName || isCreatingFile) return;

    const error = validateFileName(trimmedName);
    if (error) {
      setFileNameError(error);
      return;
    }

    if (!forceOverwrite) {
      const existingFile = pane.files.find(
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
      await onCreateFile(trimmedName);
      onMutateSuccess?.();
      setShowNewFileDialog(false);
      setShowOverwriteConfirm(false);
      setOverwriteTarget(null);
      setNewFileName("");
      setFileNameError(null);
    } catch {
      /* Error handling */
    } finally {
      setIsCreatingFile(false);
    }
  };

  const handleConfirmOverwrite = async () => {
    await handleCreateFile(true);
  };

  const handleRename = async () => {
    if (!renameTarget || !renameName.trim() || isRenaming) return;
    setIsRenaming(true);
    try {
      // renameTarget is always a full path; use the path-aware variant
      await onRenameFileAtPath(renameTarget, renameName.trim());
      onMutateSuccess?.();
      setShowRenameDialog(false);
      setRenameTarget(null);
      setRenameName("");
    } catch {
      /* Error handling */
    } finally {
      setIsRenaming(false);
    }
  };

  const handleDelete = async () => {
    if (deleteTargets.length === 0 || isDeleting) return;
    setIsDeleting(true);
    try {
      // deleteTargets are full paths; group by parent dir and use path-aware variant
      const byDir = new Map<string, string[]>();
      for (const fullPath of deleteTargets) {
        const lastSlash = Math.max(fullPath.lastIndexOf("/"), fullPath.lastIndexOf("\\"));
        const dir = lastSlash > 0 ? fullPath.slice(0, lastSlash) : "/";
        const name = fullPath.slice(lastSlash + 1);
        const list = byDir.get(dir) ?? [];
        list.push(name);
        byDir.set(dir, list);
      }
      const connectionId = pane.connection?.id;
      if (!connectionId) {
        throw new Error("Pane connection is no longer available");
      }
      for (const [dir, names] of byDir) {
        await onDeleteFilesAtPath(connectionId, dir, names);
      }
      onMutateSuccess?.();
      setShowDeleteConfirm(false);
      setDeleteTargets([]);
      onClearSelection();
    } catch {
      /* Error handling */
    } finally {
      setIsDeleting(false);
    }
  };

  // entryPath is the full path; renameName is initialized to the basename
  const openRenameDialog = useCallback((entryPath: string) => {
    setRenameTarget(entryPath);
    setRenameName(getFileName(entryPath) || entryPath);
    setShowRenameDialog(true);
  }, []);

  const openDeleteConfirm = useCallback((names: string[]) => {
    setDeleteTargets(names);
    setShowDeleteConfirm(true);
  }, []);

  return {
    showHostPicker,
    hostSearch,
    showNewFolderDialog,
    newFolderName,
    showNewFileDialog,
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
    openRenameDialog,
    openDeleteConfirm,
    getNextUntitledName,
  };
};
