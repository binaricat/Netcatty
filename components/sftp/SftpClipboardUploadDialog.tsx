import React, { useRef } from "react";
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
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Upload clipboard files?</DialogTitle>
          <DialogDescription>
            Upload {fileCount} item{fileCount === 1 ? "" : "s"} to:
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-sm font-mono break-all">
            {request?.targetPath ?? currentPath}
          </div>
          {previewFiles.length > 0 && (
            <div className="max-h-40 overflow-auto rounded-md border border-border/60">
              {previewFiles.map((file) => (
                <div key={file.path} className="px-3 py-2 text-sm border-b border-border/40 last:border-b-0 truncate">
                  {file.name}
                </div>
              ))}
              {remainingCount > 0 && (
                <div className="px-3 py-2 text-sm text-muted-foreground">
                  and {remainingCount} more...
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
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={!request}>
            Upload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
