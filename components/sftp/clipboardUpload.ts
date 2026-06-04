import type { SftpFileEntry } from "../../types";
import type { DropEntry } from "../../lib/sftpFileUtils";
import type { KeyBinding } from "../../domain/models";
import { joinPath } from "../../application/state/sftp/utils";
import { isNavigableDirectory } from "./utils";

export interface ClipboardLocalFile {
  path: string;
  name: string;
  isDirectory: boolean;
  size?: number;
}

export interface SftpClipboardUploadTreeSelection {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface ResolveSftpClipboardUploadTargetParams {
  currentPath: string;
  selectedFileNames: string[];
  files: SftpFileEntry[];
  treeSelection: SftpClipboardUploadTreeSelection[];
}

export interface GetSftpClipboardSystemTextPathsParams {
  currentPath: string;
  selectedFileNames: string[];
  treeSelection: SftpClipboardUploadTreeSelection[];
}

export function resolveSftpClipboardUploadTarget({
  currentPath,
  selectedFileNames,
  files,
  treeSelection,
}: ResolveSftpClipboardUploadTargetParams): string {
  const selectedTreeFolders = treeSelection.filter((entry) => entry.isDirectory && entry.name !== "..");
  if (selectedTreeFolders.length === 1) {
    return selectedTreeFolders[0].path;
  }

  if (selectedFileNames.length === 1) {
    const filesByName = new Map(files.map((entry) => [entry.name, entry]));
    const selectedEntry = filesByName.get(selectedFileNames[0]);
    if (selectedEntry && isNavigableDirectory(selectedEntry)) {
      return joinPath(currentPath, selectedEntry.name);
    }
  }

  return currentPath;
}

export function getSftpClipboardSystemTextPaths({
  currentPath,
  selectedFileNames,
  treeSelection,
}: GetSftpClipboardSystemTextPathsParams): string[] {
  if (treeSelection.length > 0) {
    return treeSelection.map((entry) => entry.path);
  }

  return selectedFileNames.map((name) => joinPath(currentPath, name));
}

export function createDropEntriesFromClipboardFiles(files: ClipboardLocalFile[]): DropEntry[] {
  return files.map((file) => ({
    file: null,
    localPath: file.path,
    relativePath: file.name,
    isDirectory: file.isDirectory,
    size: file.size,
  }));
}

export function getSupportedClipboardUploadFiles(files: ClipboardLocalFile[]): ClipboardLocalFile[] {
  return files.filter((file) => !file.isDirectory);
}

export function shouldLetNativePasteEventHandleSftpPaste(
  action: string,
  key: string | undefined,
): boolean {
  if (action !== "sftpPaste" || !key) return false;
  const normalized = key.toLowerCase().replace(/\s+/g, "");
  return [
    "ctrl+v",
    "⌘+v",
    "cmd+v",
    "command+v",
  ].includes(normalized);
}

export function isSftpNativeClipboardPasteEnabled(
  hotkeyScheme: "disabled" | "mac" | "pc",
  keyBindings: KeyBinding[],
): boolean {
  if (hotkeyScheme === "disabled") return false;
  const pasteBinding = keyBindings.find((binding) => (
    binding.category === "sftp" && binding.action === "sftpPaste"
  ));
  if (!pasteBinding) return false;
  const key = hotkeyScheme === "mac" ? pasteBinding.mac : pasteBinding.pc;
  return shouldLetNativePasteEventHandleSftpPaste("sftpPaste", key);
}

export interface SftpClipboardUploadRequest {
  scopeId: string;
  side: "left" | "right";
  targetPath: string;
  files: ClipboardLocalFile[];
  onConfirm: () => Promise<void>;
}

type ClipboardUploadListener = () => void;

let clipboardUploadRequest: SftpClipboardUploadRequest | null = null;
const clipboardUploadListeners = new Set<ClipboardUploadListener>();

const notifyClipboardUploadListeners = () => {
  clipboardUploadListeners.forEach((listener) => listener());
};

export const sftpClipboardUploadStore = {
  trigger: (request: SftpClipboardUploadRequest) => {
    clipboardUploadRequest = request;
    notifyClipboardUploadListeners();
  },
  clear: (request?: SftpClipboardUploadRequest | null) => {
    if (request && clipboardUploadRequest !== request) return;
    clipboardUploadRequest = null;
    notifyClipboardUploadListeners();
  },
  getSnapshot: () => clipboardUploadRequest,
  subscribe: (listener: ClipboardUploadListener) => {
    clipboardUploadListeners.add(listener);
    return () => clipboardUploadListeners.delete(listener);
  },
};
