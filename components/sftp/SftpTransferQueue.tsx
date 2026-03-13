import React from "react";
import { Button } from "../ui/button";
import type { useSftpState } from "../../application/state/useSftpState";
import type { TransferTask } from "../../types";
import { SftpTransferItem } from "./SftpTransferItem";

type SftpState = ReturnType<typeof useSftpState>;

interface SftpTransferQueueProps {
  sftp: SftpState;
  visibleTransfers: SftpState["transfers"];
  canRevealTransferTarget?: (task: TransferTask) => boolean;
  onRevealTransferTarget?: (task: TransferTask) => void | Promise<void>;
}

export const SftpTransferQueue: React.FC<SftpTransferQueueProps> = ({
  sftp,
  visibleTransfers,
  canRevealTransferTarget,
  onRevealTransferTarget,
}) => {
  if (sftp.transfers.length === 0) {
    return null;
  }

  return (
    <div className="border-t border-border/70 bg-secondary/80 backdrop-blur-sm shrink-0">
      <div className="flex items-center justify-between px-3 py-1.5 text-[11px] text-muted-foreground border-b border-border/40">
        <span className="font-medium">
          Transfers
          {sftp.activeTransfersCount > 0 && (
            <span className="ml-2 text-primary">
              ({sftp.activeTransfersCount} active)
            </span>
          )}
        </span>
        {sftp.transfers.some(
          (t) => t.status === "completed" || t.status === "cancelled",
        ) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 text-[11px]"
            onClick={sftp.clearCompletedTransfers}
          >
            Clear completed
          </Button>
        )}
      </div>
      <div className="max-h-40 overflow-auto">
        {visibleTransfers.map((task) => (
          <SftpTransferItem
            key={task.id}
            task={task}
            onCancel={() => {
              if (task.sourceConnectionId === "external") {
                sftp.cancelExternalUpload();
              }
              sftp.cancelTransfer(task.id);
            }}
            onRetry={() => sftp.retryTransfer(task.id)}
            onDismiss={() => sftp.dismissTransfer(task.id)}
            canRevealTarget={canRevealTransferTarget?.(task) ?? false}
            onRevealTarget={
              onRevealTransferTarget
                ? () => {
                    void onRevealTransferTarget(task);
                  }
                : undefined
            }
          />
        ))}
      </div>
    </div>
  );
};
