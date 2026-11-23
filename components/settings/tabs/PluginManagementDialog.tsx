import React, { useState } from 'react';
import { useI18n } from '../../../application/i18n/I18nProvider';
import { Button } from '../../ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '../../ui/dialog';

/** Uses the existing renderer and host bridge; opening the manager never starts a plugin. */
export function PluginManagementDialog({ children, trigger, open: controlledOpen, onOpenChange, restoreFocusTo, fallbackFocusTo }: {
  trigger?: React.ReactNode | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  restoreFocusTo?: React.RefObject<HTMLElement | null>;
  fallbackFocusTo?: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (value: boolean) => { setInternalOpen(value); onOpenChange?.(value); };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger !== null && <DialogTrigger asChild>
        {trigger ?? <Button variant="outline">{t('settings.plugins.openManager')}</Button>}
      </DialogTrigger>}
      <DialogContent onCloseAutoFocus={(event) => {
        const previous = restoreFocusTo?.current;
        const target = previous?.isConnected && !previous.matches(':disabled') ? previous : fallbackFocusTo?.current;
        if (target?.isConnected) {
          event.preventDefault();
          target.focus({ preventScroll: true });
        }
      }} className="app-no-drag flex h-[min(88dvh,900px)] w-[calc(100vw-2rem)] max-w-[1180px] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 border-b px-6 py-4 pr-12 text-left">
          <DialogTitle>{t('settings.plugins.title')}</DialogTitle>
        </DialogHeader>
        <div data-settings-scroll-pane className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6">
          {children}
        </div>
      </DialogContent>
    </Dialog>
  );
}
