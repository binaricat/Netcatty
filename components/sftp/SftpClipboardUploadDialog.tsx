import React, { useState } from "react";
import { Loader2 } from "lucide-react";
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
import { sftpClipboardUploadStore } from "./clipboardUpload";

interface SftpClipboardUploadDialogProps {
  request: SftpClipboardUploadRequest | null;
  currentPath?: string;
  onUploaded?: (targetPath: string) => void;
}

export const SftpClipboardUploadDialog: React.FC<SftpClipboardUploadDialogProps> = ({
  request,
  currentPath,
  onUploaded,
}) => {
  const [uploading, setUploading] = useState(false);
  const open = !!request;
  const fileCount = request?.files.length ?? 0;
  const previewFiles = request?.files.slice(0, 5) ?? [];
  const remainingCount = Math.max(0, fileCount - previewFiles.length);

  const handleClose = (nextOpen: boolean) => {
    if (nextOpen || uploading) return;
    sftpClipboardUploadStore.clear(request);
  };

  const handleConfirm = async () => {
    if (!request) return;
    setUploading(true);
    try {
      await request.onConfirm();
      onUploaded?.(request.targetPath);
      sftpClipboardUploadStore.clear(request);
    } finally {
      setUploading(false);
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
            disabled={uploading}
          >
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={uploading || !request}>
            {uploading && <Loader2 size={14} className="mr-2 animate-spin" />}
            Upload
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
