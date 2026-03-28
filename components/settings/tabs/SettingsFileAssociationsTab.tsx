/**
 * SettingsFileAssociationsTab - Manage SFTP file opener associations and behavior
 */
import { FileType, Pencil, Trash2 } from "lucide-react";
import React, { useCallback, useState } from "react";
import { useI18n } from "../../../application/i18n/I18nProvider";
import { useSftpFileAssociations } from "../../../application/state/useSftpFileAssociations";
import { useSettingsState } from "../../../application/state/useSettingsState";
import type { FileOpenerType, SystemAppInfo } from "../../../lib/sftpFileUtils";
import { netcattyBridge } from "../../../infrastructure/services/netcattyBridge";
import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { Label } from "../../ui/label";
import { SectionHeader, SettingsTabContent } from "../settings-ui";

const getOpenerLabel = (
  openerType: FileOpenerType,
  systemApp: SystemAppInfo | undefined,
  t: (key: string) => string
): string => {
  if (openerType === 'builtin-editor') {
    return t('sftp.opener.builtInEditor');
  } else if (openerType === 'system-app' && systemApp) {
    return systemApp.name;
  }
  return openerType;
};

export default function SettingsFileAssociationsTab() {
  const { t } = useI18n();
  const { getAllAssociations, removeAssociation, setOpenerForExtension, getDefaultOpener, setDefaultOpener, removeDefaultOpener } = useSftpFileAssociations();
  const { sftpDoubleClickBehavior, setSftpDoubleClickBehavior, sftpAutoSync, setSftpAutoSync, sftpShowHiddenFiles, setSftpShowHiddenFiles, sftpUseCompressedUpload, setSftpUseCompressedUpload, sftpAutoOpenSidebar, setSftpAutoOpenSidebar, sftpDefaultViewMode, setSftpDefaultViewMode, sftpTransferConcurrency, setSftpTransferConcurrency } = useSettingsState();
  const associations = getAllAssociations();
  const defaultOpener = getDefaultOpener();
  const [editingExtension, setEditingExtension] = useState<string | null>(null);
  const [isSelectingDefaultApp, setIsSelectingDefaultApp] = useState(false);

  const handleRemove = useCallback((extension: string) => {
    if (confirm(t('settings.sftpFileAssociations.removeConfirm', { ext: extension === 'file' ? t('sftp.opener.noExtension') : extension }))) {
      removeAssociation(extension);
    }
  }, [removeAssociation, t]);

  const handleSelectDefaultSystemApp = useCallback(async () => {
    setIsSelectingDefaultApp(true);
    try {
      const bridge = netcattyBridge.get();
      if (!bridge?.selectApplication) return;
      const result = await bridge.selectApplication();
      if (result) {
        setDefaultOpener('system-app', { path: result.path, name: result.name });
      }
    } catch (e) {
      console.error('Failed to select application:', e);
    } finally {
      setIsSelectingDefaultApp(false);
    }
  }, [setDefaultOpener]);

  const handleEdit = useCallback(async (extension: string) => {
    setEditingExtension(extension);
    try {
      const bridge = netcattyBridge.get();
      if (!bridge?.selectApplication) {
        return;
      }
      const result = await bridge.selectApplication();
      if (result) {
        setOpenerForExtension(extension, 'system-app', { path: result.path, name: result.name });
      }
    } catch (e) {
      console.error('Failed to select application:', e);
    } finally {
      setEditingExtension(null);
    }
  }, [setOpenerForExtension]);

  return (
    <SettingsTabContent value="file-associations">
      <div className="space-y-8">
        {/* Double-click behavior section */}
        <div className="space-y-4">
          <SectionHeader title={t('settings.sftp.doubleClickBehavior')} />
          <p className="text-sm text-muted-foreground">
            {t('settings.sftp.doubleClickBehavior.desc')}
          </p>
          <div className="space-y-3">
            <button
              onClick={() => setSftpDoubleClickBehavior('open')}
              className={cn(
                "w-full text-left p-4 rounded-lg border-2 transition-colors",
                sftpDoubleClickBehavior === 'open'
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/50 hover:bg-secondary/50"
              )}
            >
              <div className="flex items-start gap-3">
                <div className={cn(
                  "h-5 w-5 rounded-full border-2 flex items-center justify-center mt-0.5 shrink-0",
                  sftpDoubleClickBehavior === 'open'
                    ? "border-primary"
                    : "border-muted-foreground/30"
                )}>
                  {sftpDoubleClickBehavior === 'open' && (
                    <div className="h-2.5 w-2.5 rounded-full bg-primary" />
                  )}
                </div>
                <div className="space-y-1">
                  <Label className="font-medium cursor-pointer">
                    {t('settings.sftp.doubleClickBehavior.open')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('settings.sftp.doubleClickBehavior.openDesc')}
                  </p>
                </div>
              </div>
            </button>
            <button
              onClick={() => setSftpDoubleClickBehavior('transfer')}
              className={cn(
                "w-full text-left p-4 rounded-lg border-2 transition-colors",
                sftpDoubleClickBehavior === 'transfer'
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/50 hover:bg-secondary/50"
              )}
            >
              <div className="flex items-start gap-3">
                <div className={cn(
                  "h-5 w-5 rounded-full border-2 flex items-center justify-center mt-0.5 shrink-0",
                  sftpDoubleClickBehavior === 'transfer'
                    ? "border-primary"
                    : "border-muted-foreground/30"
                )}>
                  {sftpDoubleClickBehavior === 'transfer' && (
                    <div className="h-2.5 w-2.5 rounded-full bg-primary" />
                  )}
                </div>
                <div className="space-y-1">
                  <Label className="font-medium cursor-pointer">
                    {t('settings.sftp.doubleClickBehavior.transfer')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('settings.sftp.doubleClickBehavior.transferDesc')}
                  </p>
                </div>
              </div>
            </button>
          </div>
        </div>

        {/* Default view mode section */}
        <div className="space-y-4">
          <SectionHeader title={t('settings.sftp.defaultViewMode')} />
          <p className="text-sm text-muted-foreground">
            {t('settings.sftp.defaultViewMode.desc')}
          </p>
          <div className="space-y-3">
            <button
              onClick={() => setSftpDefaultViewMode('list')}
              className={cn(
                "w-full text-left p-4 rounded-lg border-2 transition-colors",
                sftpDefaultViewMode === 'list'
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/50 hover:bg-secondary/50"
              )}
            >
              <div className="flex items-start gap-3">
                <div className={cn(
                  "h-5 w-5 rounded-full border-2 flex items-center justify-center mt-0.5 shrink-0",
                  sftpDefaultViewMode === 'list'
                    ? "border-primary"
                    : "border-muted-foreground/30"
                )}>
                  {sftpDefaultViewMode === 'list' && (
                    <div className="h-2.5 w-2.5 rounded-full bg-primary" />
                  )}
                </div>
                <div className="space-y-1">
                  <Label className="font-medium cursor-pointer">
                    {t('settings.sftp.defaultViewMode.list')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('settings.sftp.defaultViewMode.listDesc')}
                  </p>
                </div>
              </div>
            </button>
            <button
              onClick={() => setSftpDefaultViewMode('tree')}
              className={cn(
                "w-full text-left p-4 rounded-lg border-2 transition-colors",
                sftpDefaultViewMode === 'tree'
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/50 hover:bg-secondary/50"
              )}
            >
              <div className="flex items-start gap-3">
                <div className={cn(
                  "h-5 w-5 rounded-full border-2 flex items-center justify-center mt-0.5 shrink-0",
                  sftpDefaultViewMode === 'tree'
                    ? "border-primary"
                    : "border-muted-foreground/30"
                )}>
                  {sftpDefaultViewMode === 'tree' && (
                    <div className="h-2.5 w-2.5 rounded-full bg-primary" />
                  )}
                </div>
                <div className="space-y-1">
                  <Label className="font-medium cursor-pointer">
                    {t('settings.sftp.defaultViewMode.tree')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('settings.sftp.defaultViewMode.treeDesc')}
                  </p>
                </div>
              </div>
            </button>
          </div>
        </div>

        {/* Auto-sync section */}
        <div className="space-y-4">
          <SectionHeader title={t('settings.sftp.autoSync')} />
          <p className="text-sm text-muted-foreground">
            {t('settings.sftp.autoSync.desc')}
          </p>
          <button
            onClick={() => setSftpAutoSync(!sftpAutoSync)}
            className={cn(
              "w-full text-left p-4 rounded-lg border-2 transition-colors",
              sftpAutoSync
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/50 hover:bg-secondary/50"
            )}
          >
            <div className="flex items-start gap-3">
              <div className={cn(
                "h-5 w-5 rounded border-2 flex items-center justify-center mt-0.5 shrink-0",
                sftpAutoSync
                  ? "border-primary bg-primary"
                  : "border-muted-foreground/30"
              )}>
                {sftpAutoSync && (
                  <svg className="h-3 w-3 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </div>
              <div className="space-y-1">
                <Label className="font-medium cursor-pointer">
                  {t('settings.sftp.autoSync.enable')}
                </Label>
                <p className="text-sm text-muted-foreground">
                  {t('settings.sftp.autoSync.enableDesc')}
                </p>
              </div>
            </div>
          </button>
        </div>

        {/* Show hidden files section */}
        <div className="space-y-4">
          <SectionHeader title={t('settings.sftp.showHiddenFiles')} />
          <p className="text-sm text-muted-foreground">
            {t('settings.sftp.showHiddenFiles.desc')}
          </p>
          <button
            onClick={() => setSftpShowHiddenFiles(!sftpShowHiddenFiles)}
            className={cn(
              "w-full text-left p-4 rounded-lg border-2 transition-colors",
              sftpShowHiddenFiles
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/50 hover:bg-secondary/50"
            )}
          >
            <div className="flex items-start gap-3">
              <div className={cn(
                "h-5 w-5 rounded border-2 flex items-center justify-center mt-0.5 shrink-0",
                sftpShowHiddenFiles
                  ? "border-primary bg-primary"
                  : "border-muted-foreground/30"
              )}>
                {sftpShowHiddenFiles && (
                  <svg className="h-3 w-3 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </div>
              <div className="space-y-1">
                <Label className="font-medium cursor-pointer">
                  {t('settings.sftp.showHiddenFiles.enable')}
                </Label>
                <p className="text-sm text-muted-foreground">
                  {t('settings.sftp.showHiddenFiles.enableDesc')}
                </p>
              </div>
            </div>
          </button>
        </div>

        {/* Compressed folder upload section */}
        <div className="space-y-4">
          <SectionHeader title={t('settings.sftp.compressedUpload')} />
          <p className="text-sm text-muted-foreground">
            {t('settings.sftp.compressedUpload.desc')}
          </p>
          <button
            onClick={() => setSftpUseCompressedUpload(!sftpUseCompressedUpload)}
            className={cn(
              "w-full text-left p-4 rounded-lg border-2 transition-colors",
              sftpUseCompressedUpload
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/50 hover:bg-secondary/50"
            )}
          >
            <div className="flex items-start gap-3">
              <div className={cn(
                "h-5 w-5 rounded border-2 flex items-center justify-center mt-0.5 shrink-0",
                sftpUseCompressedUpload
                  ? "border-primary bg-primary"
                  : "border-muted-foreground/30"
              )}>
                {sftpUseCompressedUpload && (
                  <svg className="h-3 w-3 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </div>
              <div className="space-y-1">
                <Label className="font-medium cursor-pointer">
                  {t('settings.sftp.compressedUpload.enable')}
                </Label>
                <p className="text-sm text-muted-foreground">
                  {t('settings.sftp.compressedUpload.enableDesc')}
                </p>
              </div>
            </div>
          </button>
        </div>

        {/* Auto-open sidebar section */}
        <div className="space-y-4">
          <SectionHeader title={t('settings.sftp.autoOpenSidebar')} />
          <p className="text-sm text-muted-foreground">
            {t('settings.sftp.autoOpenSidebar.desc')}
          </p>
          <button
            onClick={() => setSftpAutoOpenSidebar(!sftpAutoOpenSidebar)}
            className={cn(
              "w-full text-left p-4 rounded-lg border-2 transition-colors",
              sftpAutoOpenSidebar
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/50 hover:bg-secondary/50"
            )}
          >
            <div className="flex items-start gap-3">
              <div className={cn(
                "h-5 w-5 rounded border-2 flex items-center justify-center mt-0.5 shrink-0",
                sftpAutoOpenSidebar
                  ? "border-primary bg-primary"
                  : "border-muted-foreground/30"
              )}>
                {sftpAutoOpenSidebar && (
                  <svg className="h-3 w-3 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </div>
              <div className="space-y-1">
                <Label className="font-medium cursor-pointer">
                  {t('settings.sftp.autoOpenSidebar.enable')}
                </Label>
                <p className="text-sm text-muted-foreground">
                  {t('settings.sftp.autoOpenSidebar.enableDesc')}
                </p>
              </div>
            </div>
          </button>
        </div>

        {/* Transfer concurrency section */}
        <div className="space-y-4">
          <SectionHeader title={t('settings.sftp.transferConcurrency')} />
          <p className="text-sm text-muted-foreground">
            {t('settings.sftp.transferConcurrency.desc')}
          </p>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={1}
              max={16}
              step={1}
              value={sftpTransferConcurrency}
              onChange={(e) => setSftpTransferConcurrency(Number(e.target.value))}
              className="flex-1 accent-primary"
            />
            <span className="text-sm font-mono w-6 text-center">{sftpTransferConcurrency}</span>
          </div>
        </div>

        {/* Default opener section */}
        <div className="space-y-4">
          <SectionHeader title={t('settings.sftp.defaultOpener')} />
          <p className="text-sm text-muted-foreground">
            {t('settings.sftp.defaultOpener.desc')}
          </p>
          <div className="space-y-3">
            <button
              onClick={() => removeDefaultOpener()}
              className={cn(
                "w-full text-left p-4 rounded-lg border-2 transition-colors",
                !defaultOpener
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/50 hover:bg-secondary/50"
              )}
            >
              <div className="flex items-start gap-3">
                <div className={cn(
                  "h-5 w-5 rounded-full border-2 flex items-center justify-center mt-0.5 shrink-0",
                  !defaultOpener ? "border-primary" : "border-muted-foreground/30"
                )}>
                  {!defaultOpener && <div className="h-2.5 w-2.5 rounded-full bg-primary" />}
                </div>
                <div className="space-y-1">
                  <Label className="font-medium cursor-pointer">
                    {t('settings.sftp.defaultOpener.ask')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('settings.sftp.defaultOpener.askDesc')}
                  </p>
                </div>
              </div>
            </button>
            <button
              onClick={() => setDefaultOpener('builtin-editor')}
              className={cn(
                "w-full text-left p-4 rounded-lg border-2 transition-colors",
                defaultOpener?.openerType === 'builtin-editor'
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/50 hover:bg-secondary/50"
              )}
            >
              <div className="flex items-start gap-3">
                <div className={cn(
                  "h-5 w-5 rounded-full border-2 flex items-center justify-center mt-0.5 shrink-0",
                  defaultOpener?.openerType === 'builtin-editor' ? "border-primary" : "border-muted-foreground/30"
                )}>
                  {defaultOpener?.openerType === 'builtin-editor' && <div className="h-2.5 w-2.5 rounded-full bg-primary" />}
                </div>
                <div className="space-y-1">
                  <Label className="font-medium cursor-pointer">
                    {t('sftp.opener.builtInEditor')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('settings.sftp.defaultOpener.builtInDesc')}
                  </p>
                </div>
              </div>
            </button>
            <button
              onClick={handleSelectDefaultSystemApp}
              disabled={isSelectingDefaultApp}
              className={cn(
                "w-full text-left p-4 rounded-lg border-2 transition-colors",
                defaultOpener?.openerType === 'system-app'
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/50 hover:bg-secondary/50"
              )}
            >
              <div className="flex items-start gap-3">
                <div className={cn(
                  "h-5 w-5 rounded-full border-2 flex items-center justify-center mt-0.5 shrink-0",
                  defaultOpener?.openerType === 'system-app' ? "border-primary" : "border-muted-foreground/30"
                )}>
                  {defaultOpener?.openerType === 'system-app' && <div className="h-2.5 w-2.5 rounded-full bg-primary" />}
                </div>
                <div className="space-y-1">
                  <Label className="font-medium cursor-pointer">
                    {defaultOpener?.openerType === 'system-app' && defaultOpener.systemApp
                      ? defaultOpener.systemApp.name
                      : t('settings.sftp.defaultOpener.systemApp')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('settings.sftp.defaultOpener.systemAppDesc')}
                  </p>
                </div>
              </div>
            </button>
          </div>
        </div>

        {/* File associations section */}
        <div className="space-y-4">
          <SectionHeader title={t('settings.sftpFileAssociations.title')} />
          <p className="text-sm text-muted-foreground">
            {t('settings.sftpFileAssociations.desc')}
          </p>

        {associations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <FileType size={48} strokeWidth={1} className="mb-4 opacity-50" />
            <p className="text-sm">{t('settings.sftpFileAssociations.noAssociations')}</p>
          </div>
        ) : (
          <div className="border border-border rounded-md overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50 border-b border-border">
                  <th className="text-left px-4 py-2 font-medium">
                    {t('settings.sftpFileAssociations.extension')}
                  </th>
                  <th className="text-left px-4 py-2 font-medium">
                    {t('settings.sftpFileAssociations.application')}
                  </th>
                  <th className="text-right px-4 py-2 font-medium w-28">
                    {/* Actions */}
                  </th>
                </tr>
              </thead>
              <tbody>
                {associations.map(({ extension, openerType, systemApp }) => (
                  <tr key={extension} className="border-b border-border last:border-b-0 hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <code className="text-xs bg-muted px-1.5 py-0.5 rounded">
                        {extension === 'file' ? t('sftp.opener.noExtension') : `.${extension}`}
                      </code>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {openerType === 'system-app' && systemApp ? (
                        <span title={systemApp.path}>{systemApp.name}</span>
                      ) : (
                        getOpenerLabel(openerType, systemApp, t)
                      )}
                    </td>
                    <td className="px-4 py-3 text-right space-x-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => handleEdit(extension)}
                        disabled={editingExtension === extension}
                        title={t('common.edit')}
                      >
                        <Pencil size={14} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => handleRemove(extension)}
                        title={t('settings.sftpFileAssociations.remove')}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        </div>
      </div>
    </SettingsTabContent>
  );
}
