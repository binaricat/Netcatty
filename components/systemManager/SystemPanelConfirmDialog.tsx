import React, { memo } from 'react';
import { useI18n } from '../../application/i18n/I18nProvider';
import { cn } from '../../lib/utils';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';

interface SystemPanelConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  busy?: boolean;
  destructive?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

/**
 * In-app confirm dialog. Prefer this over window.confirm() in Electron side panels:
 * native confirms can leave focus/modal state broken on Windows, which blocks
 * subsequent Radix dialogs (e.g. tmux "new session" right after detach).
 */
export const SystemPanelConfirmDialog = memo(function SystemPanelConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  busy = false,
  destructive = false,
  onOpenChange,
  onConfirm,
}: SystemPanelConfirmDialogProps) {
  const { t } = useI18n();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[380px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <p className="text-sm text-muted-foreground whitespace-pre-wrap">{message}</p>

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded-md border border-border hover:bg-muted transition-colors disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={cn(
              'px-3 py-1.5 text-sm rounded-md transition-colors disabled:opacity-50',
              destructive
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : 'bg-primary text-primary-foreground hover:bg-primary/90',
            )}
          >
            {confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
});
