import React from "react";
import { useI18n } from "../../../../application/i18n/I18nProvider";
import { Button } from "../../../ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../../../ui/dialog";

/** Shared, bounded settings dialog. Callers retain their original commit semantics. */
export const ToolSettingsDialog: React.FC<{
  title: string;
  triggerLabel: string;
  children: React.ReactNode;
  immediate?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  footer?: React.ReactNode;
  busy?: boolean;
}> = ({ title, triggerLabel, children, immediate, open, onOpenChange, footer, busy }) => {
  const { t } = useI18n();
  const [localOpen, setLocalOpen] = React.useState(false);
  const changeOpen = (next: boolean) => {
    if (busy) return;
    setLocalOpen(next);
    onOpenChange?.(next);
  };
  return (
    <Dialog open={open ?? localOpen} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">{triggerLabel}</Button>
      </DialogTrigger>
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0"
        hideCloseButton={busy}
        onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}
        onInteractOutside={(event) => { if (busy) event.preventDefault(); }}
      >
        <DialogHeader className="shrink-0 px-6 pb-4 pt-6 pr-12 text-left">
          <DialogTitle className="text-base">{title}</DialogTitle>
          {immediate ? <p className="text-xs text-muted-foreground">{t("ai.toolSettings.immediate")}</p> : null}
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto px-6 pb-6 space-y-4">{children}</div>
        <DialogFooter className="shrink-0 gap-2 border-t px-6 py-4">
          {footer ?? <Button type="button" variant="outline" onClick={() => changeOpen(false)}>{t("common.close")}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
