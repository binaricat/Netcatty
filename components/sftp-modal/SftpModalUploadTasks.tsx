import React from "react";
import { Download, Loader2, Upload, X, XCircle } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

interface TransferTask {
  id: string;
  fileName: string;
  totalBytes: number;
  transferredBytes: number;
  progress: number;
  speed: number;
  status: "pending" | "uploading" | "downloading" | "completed" | "failed" | "cancelled";
  error?: string;
  direction: "upload" | "download";
}

interface SftpModalUploadTasksProps {
  tasks: TransferTask[];
  t: (key: string, params?: Record<string, unknown>) => string;
  onCancel?: () => void;
  onCancelTask?: (taskId: string) => void;
  onDismiss?: (taskId: string) => void;
}

export const SftpModalUploadTasks: React.FC<SftpModalUploadTasksProps> = ({ tasks, t, onCancel, onCancelTask, onDismiss }) => {
  if (tasks.length === 0) return null;

  // Helper function to get localized display name for compressed uploads
  const getDisplayName = (task: TransferTask) => {
    // Check for explicit phase marker format: "folderName|phase"
    // This is the format sent by uploadService.ts for compressed uploads
    if (task.fileName.includes('|')) {
      const pipeIndex = task.fileName.lastIndexOf('|');
      const baseName = task.fileName.substring(0, pipeIndex);
      const phase = task.fileName.substring(pipeIndex + 1);

      if (phase === 'compressing' || phase === 'extracting' || phase === 'uploading' || phase === 'compressed') {
        const phaseLabel = t(`sftp.upload.phase.${phase}`);
        return `${baseName} (${phaseLabel})`;
      }
    }

    // Check for exact matches of phase status strings (legacy support)
    if (task.fileName === t('sftp.upload.compressing') || task.fileName === 'Compressing...' || task.fileName === 'Compressing') {
      return t('sftp.upload.compressing');
    }
    if (task.fileName === t('sftp.upload.extracting') || task.fileName === 'Extracting...' || task.fileName === 'Extracting') {
      return t('sftp.upload.extracting');
    }
    if (task.fileName === t('sftp.upload.scanning') || task.fileName === 'Scanning files...' || task.fileName === 'Scanning files') {
      return t('sftp.upload.scanning');
    }

    // Check if this is a compressed upload task (legacy format)
    if (task.fileName.includes('(compressed)')) {
      const baseName = task.fileName.replace(' (compressed)', '');
      return `${baseName} (${t('sftp.upload.compressed')})`;
    }

    return task.fileName;
  };

  return (
    <div className="border-t border-border/60 bg-secondary/50 flex-shrink-0">
      <div className="max-h-40 overflow-y-auto overflow-x-hidden">
        {tasks.map((task) => {
          const formatSpeed = (bytesPerSec: number) => {
            if (bytesPerSec <= 0) return "";
            if (bytesPerSec >= 1024 * 1024)
              return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
            if (bytesPerSec >= 1024)
              return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
            return `${Math.round(bytesPerSec)} B/s`;
          };

          const formatBytes = (bytes: number) => {
            if (bytes === 0) return "0 B";
            if (bytes >= 1024 * 1024)
              return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
            if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
            return `${bytes} B`;
          };

          const remainingBytes = task.totalBytes - task.transferredBytes;
          const remainingTime =
            task.speed > 0 ? Math.ceil(remainingBytes / task.speed) : 0;
          const remainingStr =
            remainingTime > 60
              ? `~${Math.ceil(remainingTime / 60)}m left`
              : remainingTime > 0
                ? `~${remainingTime}s left`
                : "";

          return (
            <div
              key={task.id}
              className="px-4 py-2.5 flex items-center gap-3 border-b border-border/30 last:border-b-0"
            >
              <div className="shrink-0">
                {(task.status === "uploading" || task.status === "downloading") && (
                  <Loader2 size={14} className="animate-spin text-primary" />
                )}
                {task.status === "pending" && (
                  task.direction === "download"
                    ? <Download size={14} className="text-muted-foreground animate-pulse" />
                    : <Upload size={14} className="text-muted-foreground animate-pulse" />
                )}
                {task.status === "completed" && (
                  task.direction === "download"
                    ? <Download size={14} className="text-green-500" />
                    : <Upload size={14} className="text-green-500" />
                )}
                {task.status === "failed" && (
                  <XCircle size={14} className="text-destructive" />
                )}
                {task.status === "cancelled" && (
                  <XCircle size={14} className="text-muted-foreground" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium truncate">
                    {getDisplayName(task)}
                  </span>
                  {(task.status === "uploading" || task.status === "downloading") && task.speed > 0 && (
                    <span className="text-[10px] text-primary font-mono shrink-0">
                      {formatSpeed(task.speed)}
                    </span>
                  )}
                  {(task.status === "uploading" || task.status === "downloading") && remainingStr && (
                    <span className="text-[10px] text-muted-foreground shrink-0">
                      {remainingStr}
                    </span>
                  )}
                </div>
                {(task.status === "uploading" || task.status === "downloading" || task.status === "pending") && (
                  <div className="mt-1.5 flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-secondary rounded-full overflow-hidden">
                      <div
                        className={cn(
                          "h-full rounded-full transition-all duration-150",
                          task.status === "pending"
                            ? "bg-muted-foreground/50 animate-pulse w-full"
                            : "bg-primary",
                        )}
                        style={{
                          width:
                            task.status === "uploading" || task.status === "downloading"
                              ? `${task.progress}%`
                              : undefined,
                        }}
                      />
                    </div>
                    <span className="text-[10px] text-muted-foreground font-mono shrink-0 w-8 text-right">
                      {task.status === "uploading" || task.status === "downloading" ? `${Math.round(task.progress)}%` : "..."}
                    </span>
                  </div>
                )}
                {(task.status === "uploading" || task.status === "downloading") && task.totalBytes > 0 && (
                  <div className="text-[10px] text-muted-foreground mt-0.5 font-mono">
                    {formatBytes(task.transferredBytes)} / {formatBytes(task.totalBytes)}
                  </div>
                )}
                {task.status === "completed" && (
                  <div className="text-[10px] text-green-600 mt-0.5">
                    {t(task.direction === "download" ? "sftp.download.completed" : "sftp.upload.completed")} - {formatBytes(task.totalBytes)}
                  </div>
                )}
                {task.status === "cancelled" && (
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    {t(task.direction === "download" ? "sftp.download.cancelled" : "sftp.upload.cancelled")}
                  </div>
                )}
                {task.status === "failed" && task.error && (
                  <div className="text-[10px] text-destructive truncate mt-0.5">
                    {task.error}
                  </div>
                )}
              </div>
              <div className="shrink-0 flex items-center gap-1">
                {task.status === "pending" && (
                  <span className="text-[10px] text-muted-foreground">
                    {t("sftp.task.waiting")}
                  </span>
                )}
                {(task.status === "uploading" || task.status === "downloading" || task.status === "pending") && (onCancelTask || onCancel) && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-destructive hover:text-destructive"
                    onClick={() => {
                      // For download tasks or when onCancelTask is available, use task-specific cancel
                      if (onCancelTask) {
                        onCancelTask(task.id);
                      } else if (onCancel) {
                        onCancel();
                      }
                    }}
                    title={t("sftp.action.cancel")}
                  >
                    <X size={12} />
                  </Button>
                )}
                {(task.status === "completed" || task.status === "failed" || task.status === "cancelled") && onDismiss && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground hover:text-foreground"
                    onClick={() => onDismiss(task.id)}
                    title={t("sftp.action.dismiss")}
                  >
                    <X size={12} />
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
