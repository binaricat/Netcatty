import { AlertTriangle } from "lucide-react";
import React from "react";
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

interface VaultDeleteConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  disabled?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

interface VaultDeleteConfirmDialogContentProps {
  title: string;
  description: string;
  descriptionId?: string;
  cancelLabel: string;
  confirmLabel: string;
  disabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export const VaultDeleteConfirmDialogContent: React.FC<VaultDeleteConfirmDialogContentProps> = ({
  title,
  description,
  descriptionId,
  cancelLabel,
  confirmLabel,
  disabled = false,
  onCancel,
  onConfirm,
}) => {
  return (
    <>
      <DialogHeader className="min-w-0 pr-6">
        <DialogTitle className="flex min-w-0 items-center gap-2 text-destructive">
          <AlertTriangle size={20} className="shrink-0" />
          <span className="min-w-0 truncate">{title}</span>
        </DialogTitle>
        <DialogDescription
          id={descriptionId}
          className="break-words [overflow-wrap:anywhere]"
        >
          {description}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter className="gap-2 sm:gap-0">
        <Button
          variant="outline"
          onClick={onCancel}
          disabled={disabled}
        >
          {cancelLabel}
        </Button>
        <Button
          variant="destructive"
          onClick={onConfirm}
          disabled={disabled}
        >
          {confirmLabel}
        </Button>
      </DialogFooter>
    </>
  );
};

export const VaultDeleteConfirmDialog: React.FC<VaultDeleteConfirmDialogProps> = ({
  open,
  title,
  description,
  confirmLabel,
  disabled = false,
  onOpenChange,
  onConfirm,
}) => {
  const { t } = useI18n();
  const descriptionId = React.useId();

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!disabled) onOpenChange(nextOpen);
    }}>
      <DialogContent
        className="max-w-[calc(100vw-2rem)] overflow-hidden sm:max-w-[400px]"
        aria-describedby={descriptionId}
      >
        <VaultDeleteConfirmDialogContent
          title={title}
          description={description}
          descriptionId={descriptionId}
          cancelLabel={t("common.cancel")}
          confirmLabel={confirmLabel ?? t("action.delete")}
          disabled={disabled}
          onCancel={() => onOpenChange(false)}
          onConfirm={onConfirm}
        />
      </DialogContent>
    </Dialog>
  );
};
