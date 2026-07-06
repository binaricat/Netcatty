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

const VaultDeleteConfirmDialogContent: React.FC<Omit<
  VaultDeleteConfirmDialogProps,
  "open" | "onOpenChange"
> & { onCancel: () => void }> = ({
  title,
  description,
  confirmLabel,
  disabled = false,
  onCancel,
  onConfirm,
}) => {
  const { t } = useI18n();

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2 text-destructive">
          <AlertTriangle size={20} />
          {title}
        </DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogFooter className="gap-2 sm:gap-0">
        <Button
          variant="outline"
          onClick={onCancel}
          disabled={disabled}
        >
          {t("common.cancel")}
        </Button>
        <Button
          variant="destructive"
          onClick={onConfirm}
          disabled={disabled}
        >
          {confirmLabel ?? t("action.delete")}
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
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!disabled) onOpenChange(nextOpen);
    }}>
      <DialogContent className="sm:max-w-[400px]">
        <VaultDeleteConfirmDialogContent
          title={title}
          description={description}
          confirmLabel={confirmLabel}
          disabled={disabled}
          onCancel={() => onOpenChange(false)}
          onConfirm={onConfirm}
        />
      </DialogContent>
    </Dialog>
  );
};
