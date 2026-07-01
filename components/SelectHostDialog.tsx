import React from 'react';
import { useI18n } from '@/application/i18n/I18nProvider';
import { SelectHostPanelContent, type SelectHostPanelContentProps } from './SelectHostPanelContent';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

export interface SelectHostDialogProps extends Omit<SelectHostPanelContentProps, 'className'> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
}

export const SelectHostDialog: React.FC<SelectHostDialogProps> = ({
  open,
  onOpenChange,
  title,
  onConfirm,
  ...contentProps
}) => {
  const { t } = useI18n();
  const dialogTitle = title ?? t('snippets.targets.add');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md h-[min(85vh,640px)] flex flex-col p-0 gap-0 overflow-hidden">
        <DialogHeader className="px-4 pt-4 pb-2 shrink-0 border-b border-border/60">
          <DialogTitle className="text-base">{dialogTitle}</DialogTitle>
        </DialogHeader>
        <SelectHostPanelContent
          {...contentProps}
          className="flex-1 min-h-0"
          onConfirm={() => {
            onConfirm();
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
};
