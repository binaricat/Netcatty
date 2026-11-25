import React, { useRef } from "react";
import { useI18n } from "../../application/i18n/I18nProvider";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import type { SftpClipboardUploadRequest } from "./clipboardUpload";
import {
  confirmSftpClipboardUpload,
  shouldStartClipboardUploadConfirm,
  sftpClipboardUploadStore,
} from "./clipboardUpload";

interface SftpClipboardUploadDialogProps {
  request: SftpClipboardUploadRequest | null;
  currentPath?: string;
  onUploaded?: (targetPath: string) => void;
}

/**
 * Confirmation dialog for OS-clipboard / path-backed paste uploads.
 *
 * Important: clear the store request *before* awaiting the transfer so the
 * modal overlay does not block the app for the entire upload (issue #2478).
 * Progress and cancellation live in the transfer queue after handoff.
 */
export const SftpClipboardUploadDialog: React.FC<SftpClipboardUploadDialogProps> = ({
  request,
  currentPath,
  onUploaded,
}) => {
  const { t } = useI18n();
  // Double-click guard is scoped to the request identity so a later paste can
  // confirm while an earlier background transfer is still running.
  const confirmStartedForRef = useRef<SftpClipboardUploadRequest | null>(null);
  const open = !!request;
  const fileCount = request?.files.length ?? 0;
  const previewFiles = request?.files.slice(0, 5) ?? [];
  const remainingCount = Math.max(0, fileCount - previewFiles.length);

  const handleClose = (nextOpen: boolean) => {
    if (nextOpen) return;
    sftpClipboardUploadStore.clear(request);
  };

  const handleConfirm = async () => {
    if (!request || !shouldStartClipboardUploadConfirm(request, confirmStartedForRef.current)) {
      return;
    }
    const confirmedRequest = request;
    confirmStartedForRef.current = confirmedRequest;
    try {
      // Close immediately so side-panel / standalone SFTP stay interactive while
      // the existing background transfer path runs.
      await confirmSftpClipboardUpload({ request: confirmedRequest, onUploaded });
    } catch {
      // Transfer handlers toast failures; keep this path free of unhandled
      // rejections after the dialog has already closed.
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-[calc(100vw-2rem)] overflow-hidden sm:max-w-md">
        <DialogHeader className="min-w-0 pr-6">
          <DialogTitle>{t("sftp.clipboardUpload.title")}</DialogTitle>
          <DialogDescription>
            {t("sftp.clipboardUpload.description", { count: fileCount })}
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-3">
          <div className="min-w-0 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm font-mono break-all [overflow-wrap:anywhere]">
            {request?.targetPath ?? currentPath}
          </div>
          {previewFiles.length > 0 && (
            <div className="max-h-40 min-w-0 overflow-auto rounded-md border border-border/60">
              {previewFiles.map((file) => (
                <div
                  key={file.path}
                  className="flex min-w-0 items-center border-b border-border/40 px-3 py-2 text-sm last:border-b-0"
                >
                  <span className="min-w-0 truncate" title={file.name}>
                    {file.name}
                  </span>
                </div>
              ))}
              {remainingCount > 0 && (
                <div className="px-3 py-2 text-sm text-muted-foreground">
                  {t("sftp.clipboardUpload.more", { count: remainingCount })}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => sftpClipboardUploadStore.clear(request)}
          >
            {t("common.cancel")}
          </Button>
          <Button onClick={handleConfirm} disabled={!request}>
            {t("sftp.upload")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
