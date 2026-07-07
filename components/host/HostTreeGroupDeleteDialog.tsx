import React, { useEffect, useState } from 'react';

import { useI18n } from '../../application/i18n/I18nProvider';
import {
  hostTreeInlineGroupDeleteStore,
  useHostTreeInlineGroupDeleteTarget,
} from '../../application/state/hostTreeInlineGroupDeleteStore';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

type HostTreeGroupDeleteDialogProps = {
  managedGroupPaths?: Set<string>;
  onConfirmDelete: (groupPath: string, deleteHosts: boolean) => void | Promise<void>;
};

export const HostTreeGroupDeleteDialog: React.FC<HostTreeGroupDeleteDialogProps> = ({
  managedGroupPaths,
  onConfirmDelete,
}) => {
  const { t } = useI18n();
  const targetPath = useHostTreeInlineGroupDeleteTarget();
  const [deleteHosts, setDeleteHosts] = useState(false);
  const isOpen = Boolean(targetPath);
  const isManaged = Boolean(targetPath && managedGroupPaths?.has(targetPath));

  useEffect(() => {
    if (!isOpen) {
      setDeleteHosts(false);
    }
  }, [isOpen]);

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) hostTreeInlineGroupDeleteStore.close();
      }}
    >
      <DialogContent className="max-w-[calc(100vw-2rem)] overflow-hidden sm:max-w-lg">
        <DialogHeader className="min-w-0 pr-6">
          <DialogTitle className="truncate">{t('vault.groups.deleteDialogTitle')}</DialogTitle>
          <DialogDescription className="break-words [overflow-wrap:anywhere]">
            {isManaged
              ? t('vault.groups.deleteDialog.managedDesc')
              : t('vault.groups.deleteDialog.desc')}
          </DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-4 py-4">
          {targetPath && (
            <>
              <p className="min-w-0 break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">
                {t('vault.groups.pathLabel')}:{' '}
                <span className="font-mono">{targetPath}</span>
              </p>
              {!isManaged && (
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={deleteHosts}
                    onChange={(event) => setDeleteHosts(event.target.checked)}
                    className="rounded border-border"
                  />
                  <span>{t('vault.groups.deleteDialog.deleteHosts')}</span>
                </label>
              )}
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => hostTreeInlineGroupDeleteStore.close()}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              if (!targetPath) return;
              void Promise.resolve(onConfirmDelete(targetPath, isManaged || deleteHosts)).finally(() => {
                hostTreeInlineGroupDeleteStore.close();
                setDeleteHosts(false);
              });
            }}
          >
            {t('common.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
