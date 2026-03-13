import React from "react";
import { Button } from "../ui/button";
import { useI18n } from "../../application/i18n/I18nProvider";
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
  const { t } = useI18n();

  if (sftp.transfers.length === 0) {
    return null;
  }

  return (
    <div className="border-t border-border/70 bg-secondary/80 backdrop-blur-sm shrink-0">
      <div className="flex items-center justify-between px-3 py-1.5 text-[11px] text-muted-foreground border-b border-border/40">
        <span className="font-medium">
          {t("sftp.transfers")}
          {sftp.activeTransfersCount > 0 && (
            <span className="ml-2 text-primary">
              ({t("sftp.transfers.active", { count: sftp.activeTransfersCount })})
            </span>
          )}
        </span>
        {sftp.transfers.some(
          (tr) => tr.status === "completed" || tr.status === "cancelled",
        ) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 text-[11px]"
            onClick={sftp.clearCompletedTransfers}
          >
            {t("sftp.transfers.clearCompleted")}
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
