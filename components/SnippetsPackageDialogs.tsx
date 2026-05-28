import React from 'react';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SnippetsPackageDialogsProps = Record<string, any>;

export const SnippetsPackageDialogs: React.FC<SnippetsPackageDialogsProps> = ({
  isPackageDialogOpen,
  t,
  selectedPackage,
  newPackageName,
  setNewPackageName,
  createPackage,
  setIsPackageDialogOpen,
  isRenameDialogOpen,
  renamingPackagePath,
  renamePackageName,
  setRenamePackageName,
  setRenameError,
  renamePackage,
  renameError,
  setIsRenameDialogOpen,
}) => (
  <>
      {/* New Package Inline Form */}
      {isPackageDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-full max-w-sm p-4 space-y-4">
            <div>
              <p className="text-sm font-semibold">{t('snippets.packageDialog.title')}</p>
              <p className="text-xs text-muted-foreground">{t('snippets.packageDialog.parent', { parent: selectedPackage || t('snippets.packageDialog.root') })}</p>
            </div>
            <div className="space-y-2">
              <Label>{t('field.name')}</Label>
              <Input
                autoFocus
                placeholder={t('snippets.packageDialog.placeholder')}
                value={newPackageName}
                onChange={(e) => setNewPackageName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createPackage()}
              />
              <p className="text-[11px] text-muted-foreground">{t('snippets.packageDialog.hint')}</p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setIsPackageDialogOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={createPackage}>{t('common.create')}</Button>
            </div>
          </Card>
        </div>
      )}

      {/* Rename Package Dialog */}
      {isRenameDialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-full max-w-sm p-4 space-y-4">
            <div>
              <p className="text-sm font-semibold">{t('snippets.renameDialog.title')}</p>
              <p className="text-xs text-muted-foreground">{t('snippets.renameDialog.currentPath', { path: renamingPackagePath })}</p>
            </div>
            <div className="space-y-2">
              <Label>{t('field.name')}</Label>
              <Input
                autoFocus
                placeholder={t('snippets.renameDialog.placeholder')}
                value={renamePackageName}
                onChange={(e) => {
                  setRenamePackageName(e.target.value);
                  setRenameError('');
                }}
                onKeyDown={(e) => e.key === 'Enter' && renamePackage()}
              />
              {renameError && (
                <p className="text-[11px] text-destructive">{renameError}</p>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setIsRenameDialogOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button onClick={renamePackage}>{t('common.rename')}</Button>
            </div>
          </Card>
        </div>
      )}
  </>
);
