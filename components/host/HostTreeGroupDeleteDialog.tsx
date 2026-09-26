import React, { useEffect, useState } from 'react';

import { useI18n } from '../../application/i18n/I18nProvider';
import {
  hostTreeInlineGroupDeleteStore,
  useHostTreeInlineGroupDeleteTarget,
} from '../../application/state/hostTreeInlineGroupDeleteStore';
import { VaultGroupDeletionConfirmationChangedError } from '../../application/state/useVaultGroupDeletion';
import { toast } from '../ui/toast';
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
  managedFilesByGroupPath?: Map<string, string[]>;
  onConfirmDelete: (groupPath: string, deleteHosts: boolean) => void | Promise<void>;
};

export const HostTreeGroupDeleteDialog: React.FC<HostTreeGroupDeleteDialogProps> = ({
  managedGroupPaths,
  managedFilesByGroupPath,
  onConfirmDelete,
}) => {
  const { t } = useI18n();
  const targetPath = useHostTreeInlineGroupDeleteTarget();
  const [deleteHosts, setDeleteHosts] = useState(false);
  const isOpen = Boolean(targetPath);
  const isManaged = Boolean(targetPath && managedGroupPaths?.has(targetPath));
  const descendantManagedFiles: string[] = [];
  if (targetPath && managedFilesByGroupPath) {
    for (const [groupPath, files] of managedFilesByGroupPath) {
      if (
        (groupPath === targetPath || groupPath.startsWith(`${targetPath}/`))
      ) {
        for (const filePath of files) {
          if (
            filePath
            && !descendantManagedFiles.includes(filePath)
          ) {
            descendantManagedFiles.push(filePath);
          }
        }
      }
    }
  }

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
              : descendantManagedFiles.length > 0
                ? t('vault.groups.deleteDialog.mixedDesc')
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
              {descendantManagedFiles.length > 0 && (
                <div className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-3">
                  <p className="text-sm text-destructive">
                    {t('vault.groups.deleteDialog.managedWarning')}
                  </p>
                  {descendantManagedFiles.length > 0 && (
                    <div className="max-h-40 space-y-1 overflow-y-auto">
                      {descendantManagedFiles.map((filePath) => (
                        <p
                          key={filePath}
                          className="break-all font-mono text-xs text-muted-foreground"
                        >
                          {t('vault.groups.deleteDialog.managedFile', { file: filePath })}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}
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
            onClick={async () => {
              if (!targetPath) return;
              try {
                await onConfirmDelete(targetPath, isManaged || deleteHosts);
              } catch (error) {
                toast.error(error instanceof VaultGroupDeletionConfirmationChangedError
                  ? t('vault.groups.deleteDialog.sourcesChanged')
                  : error instanceof Error ? error.message : t('common.error'));
                return;
              }
              hostTreeInlineGroupDeleteStore.close();
              setDeleteHosts(false);
            }}
          >
            {t('common.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
