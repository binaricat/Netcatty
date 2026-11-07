import React, { memo } from "react";

import { useI18n } from "../../application/i18n/I18nProvider";
import { Button } from "./button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel: string;
  busy?: boolean;
  destructive?: boolean;
  hostSecuritySurface?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export const ConfirmDialog = memo(function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  busy = false,
  destructive = false,
  hostSecuritySurface = false,
  onOpenChange,
  onConfirm,
}: ConfirmDialogProps) {
  const { t } = useI18n();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-host-security-surface={hostSecuritySurface ? "" : undefined} className="max-w-[calc(100vw-2rem)] overflow-hidden sm:max-w-[380px]">
        <DialogHeader className="min-w-0 pr-6">
          <DialogTitle className="truncate">{title}</DialogTitle>
        </DialogHeader>

        {message ? (
          <p className="min-w-0 whitespace-pre-wrap break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">{message}</p>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});
