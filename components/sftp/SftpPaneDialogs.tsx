import React from "react";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { getFileName, getParentPath } from "../../application/state/sftp/utils";
import { SftpHostPicker } from "./index";
import type { Host } from "../../types";

interface SftpPaneDialogsProps {
  t: (key: string, params?: Record<string, unknown>) => string;
  hostLabel?: string;
  currentPath?: string;
  // New folder
  showNewFolderDialog: boolean;
  setShowNewFolderDialog: (open: boolean) => void;
  newFolderName: string;
  setNewFolderName: (value: string) => void;
  handleCreateFolder: () => void;
  isCreating: boolean;
  // New file
  showNewFileDialog: boolean;
  setShowNewFileDialog: (open: boolean) => void;
  newFileName: string;
  setNewFileName: (value: string) => void;
  fileNameError: string | null;
  setFileNameError: (value: string | null) => void;
  handleCreateFile: () => void;
  isCreatingFile: boolean;
  // Overwrite confirm
  showOverwriteConfirm: boolean;
  setShowOverwriteConfirm: (open: boolean) => void;
  overwriteTarget: string | null;
  handleOverwriteConfirm: () => void;
  // Rename
  showRenameDialog: boolean;
  setShowRenameDialog: (open: boolean) => void;
  renameName: string;
  setRenameName: (value: string) => void;
  handleRename: () => void;
  isRenaming: boolean;
  // Delete
  showDeleteConfirm: boolean;
  setShowDeleteConfirm: (open: boolean) => void;
  deleteTargets: string[];
  handleDelete: () => void;
  isDeleting: boolean;
  // Host picker (connected view)
  showHostPicker: boolean;
  setShowHostPicker: (open: boolean) => void;
  hosts: Host[];
  side: "left" | "right";
  hostSearch: string;
  setHostSearch: (value: string) => void;
  onConnect: (host: Host | "local") => void;
  onDisconnect: () => Promise<void>;
}

const HostHint: React.FC<{ label?: string }> = ({ label }) =>
  label ? (
    <div className="text-xs text-muted-foreground truncate mb-1">{label}</div>
  ) : null;

export const SftpPaneDialogs: React.FC<SftpPaneDialogsProps> = ({
  t,
  hostLabel,
  currentPath,
  showNewFolderDialog,
  setShowNewFolderDialog,
  newFolderName,
  setNewFolderName,
  handleCreateFolder,
  isCreating,
  showNewFileDialog,
  setShowNewFileDialog,
  newFileName,
  setNewFileName,
  fileNameError,
  setFileNameError,
  handleCreateFile,
  isCreatingFile,
  showOverwriteConfirm,
  setShowOverwriteConfirm,
  overwriteTarget,
  handleOverwriteConfirm,
  showRenameDialog,
  setShowRenameDialog,
  renameName,
  setRenameName,
  handleRename,
  isRenaming,
  showDeleteConfirm,
  setShowDeleteConfirm,
  deleteTargets,
  handleDelete,
  isDeleting,
  showHostPicker,
  setShowHostPicker,
  hosts,
  side,
  hostSearch,
  setHostSearch,
  onConnect,
  onDisconnect,
}) => {
  const isSingleDeleteTarget = deleteTargets.length === 1;
  const deletePath = (() => {
    if (isSingleDeleteTarget) {
      return deleteTargets[0];
    }

    const uniquePaths = Array.from(new Set(deleteTargets.map((target) => getParentPath(target)).filter(Boolean)));
    if (uniquePaths.length === 1) return uniquePaths[0];
    if (uniquePaths.length > 1) return "Multiple locations";
    return currentPath;
  })();
  const showDeleteList = deleteTargets.length > 1;
  const deleteListItems = (() => {
    if (!showDeleteList) return [];

    const uniquePaths = Array.from(new Set(deleteTargets.map((target) => getParentPath(target)).filter(Boolean)));
    if (uniquePaths.length === 1) {
      return deleteTargets.map((target) => getFileName(target) || target);
    }
    return deleteTargets;
  })();

  return (
  <>
    {/* Dialogs */}
    <Dialog open={showNewFolderDialog} onOpenChange={setShowNewFolderDialog}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <HostHint label={hostLabel} />
          <DialogTitle>{t("sftp.newFolder")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t("sftp.folderName")}</Label>
            <Input
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              placeholder={t("sftp.folderName.placeholder")}
              onKeyDown={(e) => e.key === "Enter" && handleCreateFolder()}
              autoFocus
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setShowNewFolderDialog(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            onClick={handleCreateFolder}
            disabled={!newFolderName.trim() || isCreating}
          >
            {isCreating && (
              <Loader2 size={14} className="mr-2 animate-spin" />
            )}
            {t("common.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={showNewFileDialog} onOpenChange={(open) => {
      setShowNewFileDialog(open);
      if (!open) {
        setFileNameError(null);
      }
    }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <HostHint label={hostLabel} />
          <DialogTitle>{t("sftp.newFile")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t("sftp.fileName")}</Label>
            <Input
              value={newFileName}
              onChange={(e) => {
                setNewFileName(e.target.value);
                setFileNameError(null);
              }}
              placeholder={t("sftp.fileName.placeholder")}
              onKeyDown={(e) => e.key === "Enter" && handleCreateFile()}
              autoFocus
            />
            {fileNameError && (
              <div className="text-xs text-destructive">{fileNameError}</div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setShowNewFileDialog(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            onClick={handleCreateFile}
            disabled={!newFileName.trim() || isCreatingFile}
          >
            {isCreatingFile && (
              <Loader2 size={14} className="mr-2 animate-spin" />
            )}
            {t("common.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* Overwrite Confirmation Dialog */}
    <Dialog open={showOverwriteConfirm} onOpenChange={setShowOverwriteConfirm}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <HostHint label={hostLabel} />
          <DialogTitle>{t("sftp.overwrite.title")}</DialogTitle>
          <DialogDescription>
            {t("sftp.overwrite.desc", { name: overwriteTarget || "" })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setShowOverwriteConfirm(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={handleOverwriteConfirm}
          >
            {t("sftp.overwrite.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={showRenameDialog} onOpenChange={setShowRenameDialog}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <HostHint label={hostLabel} />
          <DialogTitle>{t("sftp.rename.title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>{t("sftp.rename.newName")}</Label>
            <Input
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              placeholder={t("sftp.rename.placeholder")}
              onKeyDown={(e) => e.key === "Enter" && handleRename()}
              autoFocus
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setShowRenameDialog(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            onClick={handleRename}
            disabled={!renameName.trim() || isRenaming}
          >
            {isRenaming && (
              <Loader2 size={14} className="mr-2 animate-spin" />
            )}
            {t("common.rename")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {t("sftp.deleteConfirm.title", { count: deleteTargets.length })}
          </DialogTitle>
          <DialogDescription>
            {t(showDeleteList ? "sftp.deleteConfirm.desc" : "sftp.deleteConfirm.descSingle")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {hostLabel || deletePath ? (
            <div className="text-xs text-muted-foreground space-y-1.5">
              {hostLabel ? (
                <div className="flex items-start gap-2">
                  <span className="font-medium text-foreground/80 shrink-0">{t("sftp.deleteConfirm.host")}:</span>
                  <span className="break-all">{hostLabel}</span>
                </div>
              ) : null}
              {deletePath ? (
                <div className="flex items-start gap-2">
                  <span className="font-medium text-foreground/80 shrink-0">{t("sftp.deleteConfirm.path")}:</span>
                  <span className="break-all">{deletePath}</span>
                </div>
              ) : null}
            </div>
          ) : null}
          {showDeleteList ? (
            <div className="max-h-32 overflow-auto text-sm space-y-1">
              {deleteListItems.map((name) => (
                <div
                  key={name}
                  className="flex items-center gap-2 text-muted-foreground"
                >
                  <Trash2 size={12} />
                  <span className="truncate">{name}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setShowDeleteConfirm(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={isDeleting}
          >
            {isDeleting && (
              <Loader2 size={14} className="mr-2 animate-spin" />
            )}
            {t("action.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <SftpHostPicker
      open={showHostPicker}
      onOpenChange={setShowHostPicker}
      hosts={hosts}
      side={side}
      hostSearch={hostSearch}
      onHostSearchChange={setHostSearch}
      onSelectLocal={async () => {
        await onDisconnect();
        onConnect("local");
      }}
      onSelectHost={async (host) => {
        await onDisconnect();
        onConnect(host);
      }}
    />
  </>
  );
};
